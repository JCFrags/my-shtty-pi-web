import { EventEmitter } from "node:events";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type FrameEvent, type TabAddress } from "@webx/browser-protocol";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionCaptureCoordinator } from "../capture/coordinator.js";
import { CdpCommandTimeoutError } from "../cdp/connection.js";
import type { SessionMotor } from "../motor/session-motor.js";
import type { Layout } from "../observations/store.js";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface Consumer { readonly key: string; readonly address: TabAddress; readonly interest: "idle" | "selected" }
interface TabSchedule {
  readonly tabId: string;
  readonly browserSessionId: string;
  readonly consumers: Map<string, Consumer>;
  activeActions: number;
  captureRequested: boolean;
  lastCaptureStartedMs: number;
  generation: number;
  controller: AbortController;
  capturePromise?: Promise<void>;
  closed: boolean;
  timer?: NodeJS.Timeout;
  timerDueMs?: number;
}

export interface FrameSchedulerOptions {
  idleIntervalMs?: number;
  selectedIntervalMs?: number;
  burstIntervalMs?: number;
  commitBarrierForTest?: () => Promise<void>;
  afterScreenshotForTest?: () => Promise<void>;
  captureCoordinator?: SessionCaptureCoordinator;
}

export class FrameScheduler extends EventEmitter {
  private readonly schedules = new Map<string, TabSchedule>();
  private readonly consumerAddresses = new Map<string, TabAddress>();
  private readonly latest = new Map<string, FrameEvent>();
  private readonly idleIntervalMs: number;
  private readonly selectedIntervalMs: number;
  private readonly burstIntervalMs: number;
  private readonly commitBarrierForTest: (() => Promise<void>) | undefined;
  private readonly afterScreenshotForTest: (() => Promise<void>) | undefined;
  private readonly captureCoordinator: SessionCaptureCoordinator | undefined;
  droppedFrames = 0;
  private closed = false;

  constructor(private readonly actor: ActorIdentity, private readonly registry: TargetRegistry, private readonly artifacts: BrowserArtifactStore, private readonly motor: SessionMotor, private readonly currentEpoch: () => number, options: FrameSchedulerOptions = {}) {
    super();
    this.idleIntervalMs = options.idleIntervalMs ?? 2_000;
    this.selectedIntervalMs = options.selectedIntervalMs ?? 500;
    this.burstIntervalMs = options.burstIntervalMs ?? 100;
    this.commitBarrierForTest = options.commitBarrierForTest;
    this.afterScreenshotForTest = options.afterScreenshotForTest;
    this.captureCoordinator = options.captureCoordinator;
    motor.on("actionStart", this.onActionStart);
    motor.on("actionEnd", this.onActionEnd);
    motor.on("sample", this.onSample);
  }

  get subscriptionCount(): number { let count = 0; for (const schedule of this.schedules.values()) count += schedule.consumers.size; return count; }
  get timerCount(): number { let count = 0; for (const schedule of this.schedules.values()) if (schedule.timer !== undefined) count++; return count; }

  subscribe(key: string, address: TabAddress, interest: "idle" | "selected" = "selected"): void {
    if (this.closed) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame scheduler is closed.");
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

  async unsubscribe(key: string, address: TabAddress): Promise<void> {
    const schedule = this.schedules.get(address.tabId);
    const existing = schedule?.consumers.get(key);
    if (existing === undefined) return;
    if (!sameAddress(existing.address, address)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription address does not match.");
    schedule?.consumers.delete(key);
    this.consumerAddresses.delete(key);
    if (schedule !== undefined && schedule.consumers.size === 0 && schedule.activeActions === 0) await this.stop(address.tabId);
  }

  removeConsumer(key: string): void { this.consumerAddresses.delete(key); for (const schedule of [...this.schedules.values()]) { if (schedule.consumers.delete(key) && schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(schedule.tabId); } }
  removeConsumerPrefix(prefix: string): void { for (const schedule of [...this.schedules.values()]) { for (const key of [...schedule.consumers.keys()]) if (key.startsWith(prefix)) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(schedule.tabId); } }
  invalidateEpoch(epoch: number): void { for (const schedule of [...this.schedules.values()]) { for (const [key, consumer] of schedule.consumers) if (consumer.address.controlEpoch !== epoch) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(schedule.tabId); } }
  hasConsumer(key: string, address: TabAddress): boolean { const consumer = this.schedules.get(address.tabId)?.consumers.get(key); return consumer !== undefined && sameAddress(consumer.address, address); }
  latestFrame(tabId: string): FrameEvent | undefined { return this.latest.get(tabId); }

  async stop(tabId: string): Promise<void> {
    const schedule = this.schedules.get(tabId);
    if (schedule === undefined) { this.latest.delete(tabId); return; }
    if (!schedule.closed) {
      schedule.closed = true;
      schedule.generation++;
      schedule.controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "Frame capture was stopped."));
      if (schedule.timer !== undefined) { clearTimeout(schedule.timer); delete schedule.timer; delete schedule.timerDueMs; }
      for (const key of schedule.consumers.keys()) this.consumerAddresses.delete(key);
      schedule.consumers.clear();
      schedule.captureRequested = false;
      this.schedules.delete(tabId);
      this.latest.delete(tabId);
      this.artifacts.releaseFrameRing(schedule.browserSessionId, schedule.tabId);
    }
    await schedule.capturePromise?.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.motor.off("actionStart", this.onActionStart);
    this.motor.off("actionEnd", this.onActionEnd);
    this.motor.off("sample", this.onSample);
    await Promise.all([...this.schedules.keys()].map(async (tabId) => await this.stop(tabId)));
    this.consumerAddresses.clear();
  }

  private readonly onActionStart = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions++; this.arm(schedule, 0); };
  private readonly onActionEnd = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions = Math.max(0, schedule.activeActions - 1); if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(tabId); };
  private readonly onSample = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule !== undefined && schedule.activeActions > 0) this.arm(schedule, this.burstIntervalMs); };

  private schedule(tab: TabRecord): TabSchedule {
    const existing = this.schedules.get(tab.tabId);
    if (existing !== undefined) return existing;
    const schedule: TabSchedule = {
      tabId: tab.tabId,
      browserSessionId: tab.browserSessionId,
      consumers: new Map(),
      activeActions: 0,
      captureRequested: false,
      lastCaptureStartedMs: 0,
      generation: 1,
      controller: new AbortController(),
      closed: false,
    };
    this.schedules.set(tab.tabId, schedule);
    return schedule;
  }

  private arm(schedule: TabSchedule, delay?: number): void {
    if (!this.isCurrent(schedule, schedule.generation)) return;
    const waitMs = Math.max(0, delay ?? this.interval(schedule));
    const dueMs = performance.now() + waitMs;
    if (schedule.timer !== undefined && schedule.timerDueMs !== undefined && schedule.timerDueMs <= dueMs) return;
    if (schedule.timer !== undefined) clearTimeout(schedule.timer);
    schedule.timerDueMs = dueMs;
    schedule.timer = setTimeout(() => {
      delete schedule.timer;
      delete schedule.timerDueMs;
      this.runCapture(schedule);
    }, waitMs);
  }

  private runCapture(schedule: TabSchedule): void {
    if (!this.isCurrent(schedule, schedule.generation)) return;
    if (schedule.capturePromise !== undefined) { schedule.captureRequested = true; this.droppedFrames++; return; }
    const generation = schedule.generation;
    const promise = this.capture(schedule, generation, schedule.controller.signal);
    schedule.capturePromise = promise;
    void promise.catch(() => undefined).finally(() => {
      if (schedule.capturePromise === promise) delete schedule.capturePromise;
      if (!this.isCurrent(schedule, generation)) return;
      if (schedule.captureRequested) { schedule.captureRequested = false; this.arm(schedule); }
      else this.arm(schedule);
    });
  }

  private interval(schedule: TabSchedule): number { if (schedule.activeActions > 0) return this.burstIntervalMs; for (const consumer of schedule.consumers.values()) if (consumer.interest === "selected") return this.selectedIntervalMs; return this.idleIntervalMs; }

  private async capture(schedule: TabSchedule, generation: number, signal: AbortSignal): Promise<void> {
    this.assertCurrent(schedule, generation, signal);
    if (schedule.consumers.size === 0 && schedule.activeActions === 0) return;
    const elapsed = performance.now() - schedule.lastCaptureStartedMs;
    const minimum = this.interval(schedule);
    if (schedule.lastCaptureStartedMs > 0 && elapsed < minimum) { this.arm(schedule, minimum - elapsed); return; }
    const tab = this.registry.getById(schedule.tabId);
    if (tab === undefined || tab.state !== "open") throw new BrowserProtocolError("TAB_NOT_FOUND", "Frame tab is no longer available.");
    schedule.lastCaptureStartedMs = performance.now();
    let artifactId: string | undefined;
    const transaction = async (captureSignal: AbortSignal): Promise<void> => {
      try {
        await this.motor.ensureOverlay(tab, captureSignal);
        this.assertCurrent(schedule, generation, captureSignal);
        const targetId = tab.targetId;
        const cdpSessionId = tab.cdpSessionId;
        const documentGeneration = tab.documentGeneration;
        const viewportGeneration = tab.viewportGeneration;
        const controlEpoch = this.currentEpoch();
        const address: TabAddress = { browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId, controlEpoch };
        const before = await layout(tab, captureSignal);
        this.assertCurrent(schedule, generation, captureSignal);
        const result = await frameConnection(tab).send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, tab.cdpSessionId, { signal: captureSignal });
        await this.afterScreenshotForTest?.();
        this.assertCurrent(schedule, generation, captureSignal);
        const after = await layout(tab, captureSignal);
        const capturedMonotonicMs = performance.now();
        if (tab.targetId !== targetId || tab.documentGeneration !== documentGeneration || tab.viewportGeneration !== viewportGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Frame target changed during capture.");
        if (before.width !== after.width || before.height !== after.height || before.dpr !== after.dpr || Math.abs(before.scrollX - after.scrollX) > 2 || Math.abs(before.scrollY - after.scrollY) > 2) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Frame viewport changed during capture.");
        const bytes = Buffer.from(result.data, "base64");
        for (const [key, consumer] of schedule.consumers) if (!sameAddress(consumer.address, address)) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); }
        this.assertCurrent(schedule, generation, captureSignal);
        if (schedule.consumers.size === 0 && schedule.activeActions === 0) throw new BrowserProtocolError("OPERATION_CANCELLED", "Frame capture has no current consumer.");
        const artifact = await this.artifacts.put(this.actor, bytes, { browserSessionId: tab.browserSessionId, tabId: tab.tabId, purpose: "workspace-frame", mediaType: "image/png", signal: captureSignal });
        artifactId = artifact.artifactId;
        await this.commitBarrierForTest?.();
        this.assertCurrent(schedule, generation, captureSignal);
        this.validateCaptured(address, targetId, cdpSessionId, documentGeneration, viewportGeneration);
        if (schedule.consumers.size === 0 && schedule.activeActions === 0) throw new BrowserProtocolError("OPERATION_CANCELLED", "Frame capture has no current consumer.");
        this.artifacts.pinFrameArtifact(this.actor, artifact.artifactId, `${tab.browserSessionId}\u0000${tab.tabId}`);
        this.assertCurrent(schedule, generation, captureSignal);
        const frame: FrameEvent = {
          protocolVersion: PROTOCOL_VERSION, kind: "frame.available", address,
          documentGeneration, viewportGeneration,
          frameSequence: this.registry.incrementFrame(tab), capturedMonotonicMs, publishedMonotonicMs: performance.now(),
          mediaType: "image/png", byteLength: bytes.byteLength, artifactId: artifact.artifactId, sha256: artifact.sha256,
          viewport: { width: after.width, height: after.height, devicePixelRatio: after.dpr }, url: after.url, title: after.title, cursor: this.motor.state,
        };
        this.assertCurrent(schedule, generation, captureSignal);
        this.latest.set(tab.tabId, frame);
        this.emit("frame", frame);
        artifactId = undefined;
      } catch (error) {
        if (artifactId !== undefined) this.artifacts.revokeIfOwned(this.actor, artifactId);
        if (error instanceof CdpCommandTimeoutError && error.method === "Page.captureScreenshot") {
          this.captureCoordinator?.recordFrameScreenshotTimeout();
          this.droppedFrames++;
        }
        if (tab.state !== "open" && this.schedules.has(schedule.tabId)) void this.stop(schedule.tabId);
        throw error;
      }
    };
    if (this.captureCoordinator === undefined) await transaction(signal);
    else await this.captureCoordinator.runFrame(tab.tabId, signal, transaction);
  }

  private isCurrent(schedule: TabSchedule, generation: number): boolean { return !this.closed && !schedule.closed && schedule.generation === generation && this.schedules.get(schedule.tabId) === schedule; }
  private assertCurrent(schedule: TabSchedule, generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.isCurrent(schedule, generation)) throw new BrowserProtocolError("OPERATION_CANCELLED", "Frame schedule is no longer active.");
  }

  private validateCaptured(address: TabAddress, targetId: string, cdpSessionId: string, documentGeneration: number, viewportGeneration: number): void {
    if (this.currentEpoch() !== address.controlEpoch) throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
    let current: TabRecord;
    try { current = this.registry.resolve(address); }
    catch { throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed before frame publication."); }
    if (current.targetId !== targetId || current.cdpSessionId !== cdpSessionId || current.documentGeneration !== documentGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Document changed before frame publication.");
    if (current.viewportGeneration !== viewportGeneration) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Viewport changed before frame publication.");
  }
}

interface FrameConnection { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string, options?: { signal?: AbortSignal }): Promise<T> }
const connections = new WeakMap<TabRecord, FrameConnection>();
export function bindFrameTab(tab: TabRecord, connection: FrameConnection): void { connections.set(tab, connection); }
function frameConnection(tab: TabRecord): FrameConnection { const connection = connections.get(tab); if (connection === undefined) throw new BrowserProtocolError("CDP_DISCONNECTED", "Tab has no CDP connection."); return connection; }
async function layout(tab: TabRecord, signal?: AbortSignal): Promise<Layout> { const expression = "({url:location.href,title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX:scrollX,scrollY:scrollY})"; const response = await frameConnection(tab).send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true }, tab.cdpSessionId, signal ? { signal } : {}); const value = response.result?.value; if (response.exceptionDetails !== undefined || !isLayout(value)) throw new BrowserProtocolError("CDP_ERROR", "Could not inspect frame viewport."); return value; }
function isLayout(value: unknown): value is Layout { if (typeof value !== "object" || value === null) return false; const item = value as Partial<Layout>; return typeof item.url === "string" && typeof item.title === "string" && [item.width, item.height, item.dpr, item.scrollX, item.scrollY].every((number) => typeof number === "number" && Number.isFinite(number)); }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
