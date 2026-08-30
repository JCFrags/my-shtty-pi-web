import { randomBytes } from "node:crypto";
import type { ActorIdentity, ScreenshotObservation, TabAddress } from "@webx/browser-protocol";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { sha256Hex } from "@webx/artifacts";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionCaptureCoordinator } from "../capture/coordinator.js";
import { CdpCommandTimeoutError } from "../cdp/connection.js";
import type { SessionMotor } from "../motor/session-motor.js";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

export interface Layout { url: string; title: string; width: number; height: number; dpr: number; scrollX: number; scrollY: number }
const MAX_MODEL_IMAGE_BYTES = 4 * 1024 * 1024;

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
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface ObservationStoreOptions {
  maxRecords?: number;
  freshnessMs?: number;
  inlineLimitBytes?: number;
  currentEpoch?: () => number;
  monotonicNow?: () => number;
  wallNow?: () => number;
  commitBarrierForTest?: (stage: "afterDigest" | "afterArtifactPut") => Promise<void>;
  captureCoordinator?: SessionCaptureCoordinator;
}

interface CapturedObservation {
  readonly tab: TabRecord;
  readonly address: TabAddress;
  readonly targetId: string;
  readonly cdpSessionId: string;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly controlEpoch: number;
  readonly layout: Layout;
  readonly bytes: Buffer;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly captureScale: number;
  readonly capturedMonotonicMs: number;
  readonly capturedWall: number;
}

export class ObservationStore {
  private readonly records = new Map<string, ObservationRecord>();
  private readonly latestByTab = new Map<string, string>();
  private readonly maxRecords: number;
  private readonly freshnessMs: number;
  private readonly inlineLimitBytes: number;
  private readonly currentEpoch: (() => number) | undefined;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  private readonly commitBarrierForTest: ((stage: "afterDigest" | "afterArtifactPut") => Promise<void>) | undefined;
  private readonly captureCoordinator: SessionCaptureCoordinator | undefined;

  constructor(
    private readonly actor: ActorIdentity,
    private readonly registry: TargetRegistry,
    private readonly artifacts: BrowserArtifactStore,
    private readonly motor: SessionMotor,
    options: ObservationStoreOptions = {},
  ) {
    this.maxRecords = options.maxRecords ?? 64;
    this.freshnessMs = options.freshnessMs ?? 60_000;
    this.inlineLimitBytes = options.inlineLimitBytes ?? 768 * 1024;
    this.currentEpoch = options.currentEpoch;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.commitBarrierForTest = options.commitBarrierForTest;
    this.captureCoordinator = options.captureCoordinator;
  }

  get size(): number { return this.records.size; }
  hasUsable(observationId: string): boolean { this.prune(); return this.records.has(observationId); }

  async capture(address: TabAddress, delivery: "auto" | "inline" | "artifact" = "auto", signal?: AbortSignal): Promise<ScreenshotObservation> {
    signal?.throwIfAborted();
    if (this.captureCoordinator === undefined) return await this.captureTransaction(address, delivery, signal);
    return await this.captureCoordinator.runAgent(address.tabId, signal, async (captureSignal) => await this.captureTransaction(address, delivery, captureSignal));
  }

  private async captureTransaction(address: TabAddress, delivery: "auto" | "inline" | "artifact", signal?: AbortSignal): Promise<ScreenshotObservation> {
    signal?.throwIfAborted();
    let captured: CapturedObservation | undefined;
    let consistencyRetries = 0;
    let timeoutRetries = 0;
    let timeoutSeen = false;
    let screenshotAttempts = 0;
    const claimScreenshotAttempt = (): void => {
      if (screenshotAttempts >= 2) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Agent screenshot attempt limit was reached.", true);
      screenshotAttempts++;
      this.captureCoordinator?.recordAgentScreenshotAttempt();
    };
    for (;;) {
      try {
        captured = await this.captureConsistent(address, signal, claimScreenshotAttempt);
        if (timeoutSeen) this.captureCoordinator?.recordRecoveredAgentScreenshotTimeout();
        break;
      } catch (error) {
        if (error instanceof CdpCommandTimeoutError && error.method === "Page.captureScreenshot") {
          this.captureCoordinator?.recordAgentScreenshotTimeout();
          timeoutSeen = true;
          if (!signal?.aborted && timeoutRetries < 1 && screenshotAttempts < 2) {
            timeoutRetries++;
            this.captureCoordinator?.recordAgentScreenshotRetry();
            continue;
          }
        } else if (!signal?.aborted && error instanceof BrowserProtocolError && (error.code === "DOCUMENT_CHANGED" || error.code === "VIEWPORT_CHANGED") && consistencyRetries < 1) {
          consistencyRetries++;
          continue;
        }
        if (timeoutSeen) this.captureCoordinator?.recordUnrecoveredAgentScreenshotTimeout();
        throw error;
      }
    }
    const { tab, layout, bytes, mediaType, imagePixelWidth, imagePixelHeight, captureScale, capturedMonotonicMs, capturedWall } = captured;
    signal?.throwIfAborted();
    const inline = delivery === "inline" || (delivery === "auto" && bytes.byteLength <= this.inlineLimitBytes);
    if (delivery === "inline" && bytes.byteLength > this.inlineLimitBytes) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Screenshot exceeds the reviewed inline limit.");
    let artifactId: string | undefined;
    const descriptor = inline
      ? { sizeBytes: bytes.byteLength, sha256: await sha256Hex(Uint8Array.from(bytes)) }
      : await this.artifacts.put(this.actor, bytes, { browserSessionId: captured.address.browserSessionId, tabId: captured.address.tabId, purpose: "agent-observation", mediaType, ...(signal ? { signal } : {}) });
    if ("artifactId" in descriptor) artifactId = descriptor.artifactId;
    try {
      await this.commitBarrierForTest?.(inline ? "afterDigest" : "afterArtifactPut");
      this.validateCaptured(captured, signal);
      const observationId = opaqueId("observation");
      const frameSequence = this.registry.incrementFrame(tab);
      const record: ObservationRecord = {
        id: observationId, address: { ...captured.address }, documentGeneration: captured.documentGeneration, viewportGeneration: captured.viewportGeneration,
        capturedMonotonicMs, validUntilMonotonicMs: capturedMonotonicMs + this.freshnessMs,
        width: layout.width, height: layout.height, dpr: layout.dpr, imagePixelWidth, imagePixelHeight, scrollX: layout.scrollX, scrollY: layout.scrollY,
      };
      this.records.set(observationId, record);
      this.latestByTab.set(tab.tabId, observationId);
      this.prune();
      return {
        kind: "screenshotObservation", observationId, address: { ...captured.address },
        documentGeneration: captured.documentGeneration, viewportGeneration: captured.viewportGeneration,
        url: layout.url, title: layout.title, capturedAt: new Date(capturedWall).toISOString(), capturedMonotonicMs,
        validUntil: new Date(capturedWall + this.freshnessMs).toISOString(),
        viewport: { width: layout.width, height: layout.height, devicePixelRatio: layout.dpr },
        scroll: { x: layout.scrollX, y: layout.scrollY }, frameSequence,
        mediaType, byteLength: descriptor.sizeBytes, imagePixelWidth, imagePixelHeight, captureScale, sha256: descriptor.sha256,
        cursor: this.motor.state,
        image: inline ? { kind: "inline", base64: bytes.toString("base64") } : { kind: "artifact", artifactId: artifactId as string },
      };
    } catch (error) {
      if (artifactId !== undefined) this.artifacts.revokeIfOwned(this.actor, artifactId);
      throw error;
    }
  }

  async guard(address: TabAddress, observationId: string, point: { x: number; y: number }, riskPolicy: "normal" | "newer-observation" | "local-region" = "normal", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const tab = this.registry.resolve(address);
    const record = this.records.get(observationId);
    if (record === undefined || !sameAddress(record.address, address)) throw new BrowserProtocolError("OBSERVATION_NOT_FOUND", "Observation not found.");
    if (record.documentGeneration !== tab.documentGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed after observation.");
    if (record.viewportGeneration !== tab.viewportGeneration) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Viewport changed after observation.");
    if (this.monotonicNow() > record.validUntilMonotonicMs) throw new BrowserProtocolError("OBSERVATION_STALE", "Observation is stale.");
    if (riskPolicy === "newer-observation" && this.latestByTab.get(tab.tabId) !== observationId) throw new BrowserProtocolError("OBSERVATION_STALE", "A newer observation is required.");
    if (riskPolicy === "local-region") throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Local region comparison is not configured.");
    const layout = await this.layout(tab, signal);
    signal?.throwIfAborted();
    if (layout.width !== record.width || layout.height !== record.height || layout.dpr !== record.dpr) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Viewport changed after observation.");
    if (Math.abs(layout.scrollX - record.scrollX) > 2 || Math.abs(layout.scrollY - record.scrollY) > 2) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Scroll changed after observation.");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= layout.width || point.y >= layout.height) throw new BrowserProtocolError("COORDINATE_OUT_OF_BOUNDS", "Coordinate is outside the observed viewport.");
  }

  convertPoint(address: TabAddress, observationId: string, point: { x: number; y: number }, coordinateSpace: "imagePixels" | "cssViewport"): { x: number; y: number } {
    const record = this.records.get(observationId);
    if (record === undefined || !sameAddress(record.address, address)) throw new BrowserProtocolError("OBSERVATION_NOT_FOUND", "Observation not found.");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new BrowserProtocolError("COORDINATE_OUT_OF_BOUNDS", "Coordinate must be finite.");
    if (coordinateSpace === "cssViewport") {
      if (point.x < 0 || point.y < 0 || point.x >= record.width || point.y >= record.height) throw new BrowserProtocolError("COORDINATE_OUT_OF_BOUNDS", "Coordinate is outside the observed CSS viewport.");
      return { x: point.x, y: point.y };
    }
    if (point.x < 0 || point.y < 0 || point.x >= record.imagePixelWidth || point.y >= record.imagePixelHeight) throw new BrowserProtocolError("COORDINATE_OUT_OF_BOUNDS", "Coordinate is outside the observed image.");
    return { x: point.x * record.width / record.imagePixelWidth, y: point.y * record.height / record.imagePixelHeight };
  }

  invalidateTab(tabId: string): void { this.latestByTab.delete(tabId); for (const [id, record] of this.records) if (record.address.tabId === tabId) this.records.delete(id); }

  async readLayout(tab: TabRecord, signal?: AbortSignal): Promise<Layout> { return await this.layout(tab, signal); }

  private async captureConsistent(address: TabAddress, signal: AbortSignal | undefined, claimScreenshotAttempt: () => void): Promise<CapturedObservation> {
    const transaction = async (captureSignal?: AbortSignal): Promise<CapturedObservation> => {
      const tab = this.registry.resolve(address);
      const targetId = tab.targetId;
      const documentGeneration = tab.documentGeneration;
      const viewportGeneration = tab.viewportGeneration;
      await this.motor.ensureOverlay(tab, captureSignal);
      captureSignal?.throwIfAborted();
      const before = await this.layout(tab, captureSignal);
      claimScreenshotAttempt();
      const png = await this.command<{ data: string }>(tab, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, captureSignal);
      let after = await this.layout(tab, captureSignal);
      assertCaptureIdentity(tab, targetId, documentGeneration, viewportGeneration, before, after);
      let bytes = decodeCanonicalBase64(png.data);
      let mediaType: "image/png" | "image/jpeg" = "image/png";
      if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) {
        const jpegBefore = after;
        claimScreenshotAttempt();
        const jpeg = await this.command<{ data: string }>(tab, "Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true, captureBeyondViewport: false }, captureSignal);
        after = await this.layout(tab, captureSignal);
        assertCaptureIdentity(tab, targetId, documentGeneration, viewportGeneration, jpegBefore, after);
        bytes = decodeCanonicalBase64(jpeg.data);
        mediaType = "image/jpeg";
      }
      if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Screenshot exceeds the model image byte limit.");
      const dimensions = decodeImageDimensions(bytes, mediaType);
      const captureScaleX = dimensions.width / after.width;
      const captureScaleY = dimensions.height / after.height;
      if (!Number.isFinite(captureScaleX) || !Number.isFinite(captureScaleY) || captureScaleX <= 0 || captureScaleY <= 0 || Math.abs(captureScaleX - captureScaleY) > 0.02) throw new BrowserProtocolError("CDP_ERROR", "Screenshot dimensions do not match the captured viewport.");
      return {
        tab, address: { ...address }, targetId, cdpSessionId: tab.cdpSessionId,
        documentGeneration, viewportGeneration, controlEpoch: address.controlEpoch,
        layout: after, bytes, mediaType, imagePixelWidth: dimensions.width, imagePixelHeight: dimensions.height,
        captureScale: (captureScaleX + captureScaleY) / 2, capturedMonotonicMs: this.monotonicNow(), capturedWall: this.wallNow(),
      };
    };
    return await transaction(signal);
  }

  private validateCaptured(captured: CapturedObservation, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.currentEpoch !== undefined && this.currentEpoch() !== captured.controlEpoch) throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
    let current: TabRecord;
    try { current = this.registry.resolve(captured.address); }
    catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      void error;
      throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed before screenshot commit.");
    }
    if (current.targetId !== captured.targetId || current.cdpSessionId !== captured.cdpSessionId || current.documentGeneration !== captured.documentGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed before screenshot commit.");
    if (current.viewportGeneration !== captured.viewportGeneration) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Viewport changed before screenshot commit.");
  }

  private prune(): void { const now = this.monotonicNow(); for (const [id, record] of this.records) if (record.validUntilMonotonicMs <= now) this.records.delete(id); while (this.records.size > this.maxRecords) { const id = this.records.keys().next().value; if (typeof id !== "string") break; this.records.delete(id); } }

  private async layout(tab: TabRecord, signal?: AbortSignal): Promise<Layout> {
    const expression = "({url:location.href,title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX:scrollX,scrollY:scrollY})";
    const response = await this.command<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tab, "Runtime.evaluate", { expression, returnByValue: true }, signal);
    if (response.exceptionDetails !== undefined || !isLayout(response.result?.value)) throw new BrowserProtocolError("CDP_ERROR", "Could not inspect the target viewport.");
    return response.result.value;
  }

  private async command<T>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<T> { return await observationConnection(tab).send<T>(method, params, tab.cdpSessionId, signal ? { signal } : undefined); }
}

interface ObservationConnection { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string, options?: { signal?: AbortSignal }): Promise<T> }
const connections = new WeakMap<TabRecord, ObservationConnection>();
export function bindObservationTab(tab: TabRecord, connection: ObservationConnection): void { connections.set(tab, connection); }
function observationConnection(tab: TabRecord): ObservationConnection { const connection = connections.get(tab); if (connection === undefined) throw new BrowserProtocolError("CDP_DISCONNECTED", "Tab has no CDP connection."); return connection; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
function isLayout(value: unknown): value is Layout { if (typeof value !== "object" || value === null) return false; const item = value as Partial<Layout>; return typeof item.url === "string" && typeof item.title === "string" && [item.width, item.height, item.dpr, item.scrollX, item.scrollY].every((number) => typeof number === "number" && Number.isFinite(number)); }
function assertCaptureIdentity(tab: TabRecord, targetId: string, documentGeneration: number, viewportGeneration: number, before: Layout, after: Layout): void {
  if (tab.targetId !== targetId || tab.documentGeneration !== documentGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed during screenshot capture.", true);
  if (tab.viewportGeneration !== viewportGeneration || before.width !== after.width || before.height !== after.height || before.dpr !== after.dpr) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Viewport changed during screenshot capture.", true);
  if (Math.abs(before.scrollX - after.scrollX) > 2 || Math.abs(before.scrollY - after.scrollY) > 2) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Scroll changed during screenshot capture.", true);
}
function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0) throw new BrowserProtocolError("CDP_ERROR", "Screenshot payload is not canonical base64.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new BrowserProtocolError("CDP_ERROR", "Screenshot payload is not canonical base64.");
  return bytes;
}
function decodeImageDimensions(bytes: Buffer, mediaType: "image/png" | "image/jpeg"): { width: number; height: number } {
  if (mediaType === "image/png") {
    if (bytes.byteLength < 24 || bytes.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new BrowserProtocolError("CDP_ERROR", "Screenshot is not a valid PNG image.");
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) throw new BrowserProtocolError("CDP_ERROR", "Screenshot PNG dimensions are invalid.");
    return { width, height };
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new BrowserProtocolError("CDP_ERROR", "Screenshot is not a valid JPEG image.");
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if ((marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3); const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) break;
      return { width, height };
    }
    offset += length;
  }
  throw new BrowserProtocolError("CDP_ERROR", "Screenshot JPEG dimensions are invalid.");
}
