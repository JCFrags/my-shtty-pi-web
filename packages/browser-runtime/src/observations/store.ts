import { randomBytes } from "node:crypto";
import type { ActorIdentity, ScreenshotObservation, TabAddress } from "@webx/browser-protocol";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionMotor } from "../motor/session-motor.js";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface Layout { url: string; title: string; width: number; height: number; dpr: number; scrollX: number; scrollY: number }
interface ObservationRecord {
  readonly id: string;
  readonly address: TabAddress;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly capturedMonotonicMs: number;
  readonly validUntilMonotonicMs: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface ObservationStoreOptions { maxRecords?: number; freshnessMs?: number; inlineLimitBytes?: number }

export class ObservationStore {
  private readonly records = new Map<string, ObservationRecord>();
  private readonly latestByTab = new Map<string, string>();
  private readonly maxRecords: number;
  private readonly freshnessMs: number;
  private readonly inlineLimitBytes: number;

  constructor(
    private readonly actor: ActorIdentity,
    private readonly registry: TargetRegistry,
    private readonly artifacts: BrowserArtifactStore,
    private readonly motor: SessionMotor,
    options: ObservationStoreOptions = {},
  ) {
    this.maxRecords = options.maxRecords ?? 64;
    this.freshnessMs = options.freshnessMs ?? 3_000;
    this.inlineLimitBytes = options.inlineLimitBytes ?? 768 * 1024;
  }

  get size(): number { return this.records.size; }

  async capture(address: TabAddress, delivery: "auto" | "inline" | "artifact" = "auto"): Promise<ScreenshotObservation> {
    const tab = this.registry.resolve(address);
    await this.motor.ensureOverlay(tab);
    const layout = await this.layout(tab);
    const response = await this.command<{ data: string }>(tab, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const bytes = Buffer.from(response.data, "base64");
    const capturedMonotonicMs = performance.now();
    const capturedWall = Date.now();
    const descriptor = await this.artifacts.put(this.actor, bytes, "image/png");
    const observationId = opaqueId("observation");
    const frameSequence = this.registry.incrementFrame(tab);
    const record: ObservationRecord = {
      id: observationId, address: { ...address }, documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration,
      capturedMonotonicMs, validUntilMonotonicMs: capturedMonotonicMs + this.freshnessMs,
      width: layout.width, height: layout.height, dpr: layout.dpr, scrollX: layout.scrollX, scrollY: layout.scrollY,
    };
    this.records.set(observationId, record);
    this.latestByTab.set(tab.tabId, observationId);
    this.prune();
    const inline = delivery === "inline" || (delivery === "auto" && bytes.byteLength <= this.inlineLimitBytes);
    if (delivery === "inline" && bytes.byteLength > this.inlineLimitBytes) throw new Error("Screenshot exceeds the reviewed inline limit.");
    return {
      kind: "screenshotObservation", observationId, address: { ...address },
      documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration,
      url: layout.url, title: layout.title, capturedAt: new Date(capturedWall).toISOString(), capturedMonotonicMs,
      validUntil: new Date(capturedWall + this.freshnessMs).toISOString(),
      viewport: { width: layout.width, height: layout.height, devicePixelRatio: layout.dpr },
      scroll: { x: layout.scrollX, y: layout.scrollY }, frameSequence,
      mediaType: "image/png", byteLength: descriptor.sizeBytes, sha256: descriptor.sha256,
      cursor: this.motor.state,
      image: inline ? { kind: "inline", base64: bytes.toString("base64") } : { kind: "artifact", artifactId: descriptor.artifactId },
    };
  }

  async guard(address: TabAddress, observationId: string, point: { x: number; y: number }, riskPolicy: "normal" | "newer-observation" | "local-region" = "normal"): Promise<void> {
    const tab = this.registry.resolve(address);
    const record = this.records.get(observationId);
    if (record === undefined || !sameAddress(record.address, address)) throw new Error("Observation not found.");
    if (record.documentGeneration !== tab.documentGeneration) throw new Error("Document changed after observation.");
    if (record.viewportGeneration !== tab.viewportGeneration) throw new Error("Viewport changed after observation.");
    if (performance.now() > record.validUntilMonotonicMs) throw new Error("Observation is stale.");
    if (riskPolicy === "newer-observation" && this.latestByTab.get(tab.tabId) !== observationId) throw new Error("A newer observation is required.");
    if (riskPolicy === "local-region") throw new Error("Local region comparison is not configured.");
    const layout = await this.layout(tab);
    if (layout.width !== record.width || layout.height !== record.height || layout.dpr !== record.dpr) throw new Error("Viewport changed after observation.");
    if (Math.abs(layout.scrollX - record.scrollX) > 2 || Math.abs(layout.scrollY - record.scrollY) > 2) throw new Error("Scroll changed after observation.");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= layout.width || point.y >= layout.height) throw new Error("Coordinate is outside the observed viewport.");
  }

  invalidateTab(tabId: string): void {
    this.latestByTab.delete(tabId);
    for (const [id, record] of this.records) if (record.address.tabId === tabId) this.records.delete(id);
  }

  private prune(): void {
    const now = performance.now();
    for (const [id, record] of this.records) if (record.validUntilMonotonicMs <= now) this.records.delete(id);
    while (this.records.size > this.maxRecords) {
      const id = this.records.keys().next().value;
      if (typeof id !== "string") break;
      this.records.delete(id);
    }
  }

  private async layout(tab: TabRecord): Promise<Layout> {
    const expression = "({url:location.href,title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX:scrollX,scrollY:scrollY})";
    const response = await this.command<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tab, "Runtime.evaluate", { expression, returnByValue: true });
    if (response.exceptionDetails !== undefined || !isLayout(response.result?.value)) throw new Error("Could not inspect the target viewport.");
    return response.result.value;
  }

  private async command<T>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
    return await observationConnection(tab).send<T>(method, params, tab.cdpSessionId);
  }
}

const connections = new WeakMap<TabRecord, { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }>();
export function bindObservationTab(tab: TabRecord, connection: { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }): void { connections.set(tab, connection); }
function observationConnection(tab: TabRecord) { const connection = connections.get(tab); if (connection === undefined) throw new Error("Tab has no CDP connection."); return connection; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
function isLayout(value: unknown): value is Layout { if (typeof value !== "object" || value === null) return false; const item = value as Partial<Layout>; return typeof item.url === "string" && typeof item.title === "string" && [item.width, item.height, item.dpr, item.scrollX, item.scrollY].every((number) => typeof number === "number" && Number.isFinite(number)); }
