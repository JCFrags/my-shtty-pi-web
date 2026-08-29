import { EventEmitter } from "node:events";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type FrameEvent, type TabAddress } from "@webx/browser-protocol";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionMotor } from "../motor/session-motor.js";
import type { Layout } from "../observations/store.js";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface Consumer { readonly key: string; readonly address: TabAddress; readonly interest: "idle" | "selected" }
interface TabSchedule {
  readonly tabId: string;
  readonly consumers: Map<string, Consumer>;
  activeActions: number;
  captureInFlight: boolean;
  captureRequested: boolean;
  lastCaptureStartedMs: number;
  timer?: NodeJS.Timeout;
}

export interface FrameSchedulerOptions { idleIntervalMs?: number; selectedIntervalMs?: number; burstIntervalMs?: number }

export class FrameScheduler extends EventEmitter {
  private readonly schedules = new Map<string, TabSchedule>();
  private readonly consumerAddresses = new Map<string, TabAddress>();
  private readonly latest = new Map<string, FrameEvent>();
  private readonly idleIntervalMs: number;
  private readonly selectedIntervalMs: number;
  private readonly burstIntervalMs: number;
  droppedFrames = 0;
  private closed = false;

  constructor(private readonly actor: ActorIdentity, private readonly registry: TargetRegistry, private readonly artifacts: BrowserArtifactStore, private readonly motor: SessionMotor, private readonly currentEpoch: () => number, options: FrameSchedulerOptions = {}) {
    super();
    this.idleIntervalMs = options.idleIntervalMs ?? 2_000;
    this.selectedIntervalMs = options.selectedIntervalMs ?? 500;
    this.burstIntervalMs = options.burstIntervalMs ?? 100;
    motor.on("actionStart", this.onActionStart);
    motor.on("actionEnd", this.onActionEnd);
    motor.on("sample", this.onSample);
  }

  get subscriptionCount(): number { let count = 0; for (const schedule of this.schedules.values()) count += schedule.consumers.size; return count; }
  get timerCount(): number { let count = 0; for (const schedule of this.schedules.values()) if (schedule.timer !== undefined) count++; return count; }

  subscribe(key: string, address: TabAddress, interest: "idle" | "selected" = "selected"): void {
    const priorAddress = this.consumerAddresses.get(key);
    if (priorAddress !== undefined && !sameAddress(priorAddress, address)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription ID is already bound to another resource.");
    const tab = this.registry.resolve(address);
    const schedule = this.schedule(tab);
    const existing = schedule.consumers.get(key);
    if (existing !== undefined) {
      if (existing.interest !== interest) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription ID is already bound to another interest level.");
      return;
    }
    schedule.consumers.set(key, { key, address: { ...address }, interest });
    this.consumerAddresses.set(key, { ...address });
    this.arm(schedule, 0);
  }

  unsubscribe(key: string, address: TabAddress): void {
    const schedule = this.schedules.get(address.tabId);
    const existing = schedule?.consumers.get(key);
    if (existing === undefined) return;
    if (!sameAddress(existing.address, address)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription address does not match.");
    schedule?.consumers.delete(key);
    this.consumerAddresses.delete(key);
    if (schedule !== undefined && schedule.consumers.size === 0 && schedule.activeActions === 0) this.stop(address.tabId);
  }

  removeConsumer(key: string): void { this.consumerAddresses.delete(key); for (const schedule of [...this.schedules.values()]) { if (schedule.consumers.delete(key) && schedule.consumers.size === 0 && schedule.activeActions === 0) this.stop(schedule.tabId); } }
  removeConsumerPrefix(prefix: string): void { for (const schedule of [...this.schedules.values()]) { for (const key of [...schedule.consumers.keys()]) if (key.startsWith(prefix)) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) this.stop(schedule.tabId); } }
  invalidateEpoch(epoch: number): void { for (const schedule of [...this.schedules.values()]) { for (const [key, consumer] of schedule.consumers) if (consumer.address.controlEpoch !== epoch) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) this.stop(schedule.tabId); } }
  hasConsumer(key: string, address: TabAddress): boolean { const consumer = this.schedules.get(address.tabId)?.consumers.get(key); return consumer !== undefined && sameAddress(consumer.address, address); }
  latestFrame(tabId: string): FrameEvent | undefined { return this.latest.get(tabId); }

  stop(tabId: string): void { const schedule = this.schedules.get(tabId); if (schedule?.timer) clearTimeout(schedule.timer); for (const key of schedule?.consumers.keys() ?? []) this.consumerAddresses.delete(key); this.schedules.delete(tabId); this.latest.delete(tabId); }

  close(): void { if (this.closed) return; this.closed = true; this.motor.off("actionStart", this.onActionStart); this.motor.off("actionEnd", this.onActionEnd); this.motor.off("sample", this.onSample); for (const tabId of [...this.schedules.keys()]) this.stop(tabId); this.consumerAddresses.clear(); }

  private readonly onActionStart = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions++; this.arm(schedule, 0); };
  private readonly onActionEnd = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions = Math.max(0, schedule.activeActions - 1); if (schedule.consumers.size === 0 && schedule.activeActions === 0) this.stop(tabId); };
  private readonly onSample = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule !== undefined && schedule.activeActions > 0) this.arm(schedule, 0); };

  private schedule(tab: TabRecord): TabSchedule { const existing = this.schedules.get(tab.tabId); if (existing !== undefined) return existing; const schedule: TabSchedule = { tabId: tab.tabId, consumers: new Map(), activeActions: 0, captureInFlight: false, captureRequested: false, lastCaptureStartedMs: 0 }; this.schedules.set(tab.tabId, schedule); return schedule; }
  private arm(schedule: TabSchedule, delay?: number): void { if (this.closed) return; if (schedule.timer) clearTimeout(schedule.timer); schedule.timer = setTimeout(() => { delete schedule.timer; void this.capture(schedule); }, delay ?? this.interval(schedule)); }
  private interval(schedule: TabSchedule): number { if (schedule.activeActions > 0) return this.burstIntervalMs; for (const consumer of schedule.consumers.values()) if (consumer.interest === "selected") return this.selectedIntervalMs; return this.idleIntervalMs; }

  private async capture(schedule: TabSchedule): Promise<void> {
    if (this.closed || (schedule.consumers.size === 0 && schedule.activeActions === 0)) return;
    if (schedule.captureInFlight) { schedule.captureRequested = true; this.droppedFrames++; return; }
    const elapsed = performance.now() - schedule.lastCaptureStartedMs;
    const minimum = this.interval(schedule);
    if (schedule.lastCaptureStartedMs > 0 && elapsed < minimum) { this.arm(schedule, minimum - elapsed); return; }
    const tab = this.registry.getById(schedule.tabId);
    if (tab === undefined || tab.state !== "open") { this.stop(schedule.tabId); return; }
    schedule.captureInFlight = true;
    schedule.lastCaptureStartedMs = performance.now();
    try {
      await this.motor.ensureOverlay(tab);
      const targetId = tab.targetId;
      const documentGeneration = tab.documentGeneration;
      const viewportGeneration = tab.viewportGeneration;
      const before = await layout(tab);
      const result = await frameConnection(tab).send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, tab.cdpSessionId);
      const after = await layout(tab);
      const capturedMonotonicMs = performance.now();
      if (tab.targetId !== targetId || tab.documentGeneration !== documentGeneration || tab.viewportGeneration !== viewportGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Frame target changed during capture.");
      if (before.width !== after.width || before.height !== after.height || before.dpr !== after.dpr || Math.abs(before.scrollX - after.scrollX) > 2 || Math.abs(before.scrollY - after.scrollY) > 2) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Frame viewport changed during capture.");
      const bytes = Buffer.from(result.data, "base64");
      const address: TabAddress = { browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch: this.currentEpoch() };
      for (const [key, consumer] of schedule.consumers) if (!sameAddress(consumer.address, address)) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); }
      if (schedule.consumers.size === 0 && schedule.activeActions === 0) { this.stop(tab.tabId); return; }
      const artifact = await this.artifacts.put(this.actor, bytes, { browserSessionId: tab.browserSessionId, tabId: tab.tabId, purpose: "workspace-frame", mediaType: "image/png", latestFrameKey: `${tab.browserSessionId}\u0000${tab.tabId}` });
      const frame: FrameEvent = {
        protocolVersion: PROTOCOL_VERSION, kind: "frame.available", address,
        documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration,
        frameSequence: this.registry.incrementFrame(tab), capturedMonotonicMs, publishedMonotonicMs: performance.now(),
        mediaType: "image/png", byteLength: bytes.byteLength, artifactId: artifact.artifactId, sha256: artifact.sha256,
        viewport: { width: after.width, height: after.height, devicePixelRatio: after.dpr }, url: after.url, title: after.title, cursor: this.motor.state,
      };
      this.latest.set(tab.tabId, frame);
      this.emit("frame", frame);
    } catch { if (tab.state !== "open") this.stop(tab.tabId); }
    finally { schedule.captureInFlight = false; if (schedule.captureRequested) { schedule.captureRequested = false; this.arm(schedule, 0); } else if (this.schedules.has(schedule.tabId)) this.arm(schedule); }
  }
}

interface FrameConnection { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }
const connections = new WeakMap<TabRecord, FrameConnection>();
export function bindFrameTab(tab: TabRecord, connection: FrameConnection): void { connections.set(tab, connection); }
function frameConnection(tab: TabRecord): FrameConnection { const connection = connections.get(tab); if (connection === undefined) throw new BrowserProtocolError("CDP_DISCONNECTED", "Tab has no CDP connection."); return connection; }
async function layout(tab: TabRecord): Promise<Layout> { const expression = "({url:location.href,title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX:scrollX,scrollY:scrollY})"; const response = await frameConnection(tab).send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true }, tab.cdpSessionId); const value = response.result?.value; if (response.exceptionDetails !== undefined || !isLayout(value)) throw new BrowserProtocolError("CDP_ERROR", "Could not inspect frame viewport."); return value; }
function isLayout(value: unknown): value is Layout { if (typeof value !== "object" || value === null) return false; const item = value as Partial<Layout>; return typeof item.url === "string" && typeof item.title === "string" && [item.width, item.height, item.dpr, item.scrollX, item.scrollY].every((number) => typeof number === "number" && Number.isFinite(number)); }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
