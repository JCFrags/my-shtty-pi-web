import { EventEmitter } from "node:events";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type FrameEvent, type TabAddress } from "@webx/browser-protocol";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionCaptureCoordinator } from "../capture/coordinator.js";
import type { CaptureProofIdentity } from "../capture/readiness.js";
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
  minimumIntervalMs: number;
  recoverySuccessesRemaining: number;
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
  frameTimeoutRecoveryMs?: number;
  latestRetentionMs?: number;
  commitBarrierForTest?: () => Promise<void>;
  afterScreenshotForTest?: () => Promise<void>;
  captureCoordinator?: SessionCaptureCoordinator;
}

export interface FrameCaptureOutcome {
  readonly identity: CaptureProofIdentity;
  readonly selectedAtStart: boolean;
  readonly result: "succeeded" | "failed";
}

export class FrameScheduler extends EventEmitter {
  private readonly schedules = new Map<string, TabSchedule>();
  private readonly consumerAddresses = new Map<string, TabAddress>();
  private readonly latest = new Map<string, FrameEvent>();
  private readonly latestEvictions = new Map<string, NodeJS.Timeout>();
  private readonly idleIntervalMs: number;
  private readonly selectedIntervalMs: number;
  private readonly burstIntervalMs: number;
  private readonly frameTimeoutRecoveryMs: number;
  private readonly latestRetentionMs: number;
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
    this.frameTimeoutRecoveryMs = options.frameTimeoutRecoveryMs ?? 2_000;
    this.latestRetentionMs = options.latestRetentionMs ?? 2_000;
    this.commitBarrierForTest = options.commitBarrierForTest;
    this.afterScreenshotForTest = options.afterScreenshotForTest;
    this.captureCoordinator = options.captureCoordinator;
    motor.on("actionStart", this.onActionStart);
    motor.on("actionEnd", this.onActionEnd);
    motor.on("sample", this.onSample);
  }

  get subscriptionCount(): number { let count = 0; for (const schedule of this.schedules.values()) count += schedule.consumers.size; return count; }
  get timerCount(): number { let count = 0; for (const schedule of this.schedules.values()) if (schedule.timer !== undefined) count++; return count; }
  get retainedLatestCount(): number { return this.latestEvictions.size; }

  subscribe(key: string, address: TabAddress, interest: "idle" | "selected" = "selected", deferInitialCapture = false): void {
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
    this.arm(schedule, deferInitialCapture ? this.interval(schedule) : 0);
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
  async removeConsumerAndSettle(key: string): Promise<void> {
    this.consumerAddresses.delete(key);
    for (const schedule of [...this.schedules.values()]) {
      if (!schedule.consumers.delete(key)) continue;
      if (schedule.consumers.size === 0 && schedule.activeActions === 0) await this.stop(schedule.tabId);
      return;
    }
  }
  removeConsumerPrefix(prefix: string): void { for (const schedule of [...this.schedules.values()]) { for (const key of [...schedule.consumers.keys()]) if (key.startsWith(prefix)) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(schedule.tabId); } }
  invalidateEpoch(epoch: number): void { for (const schedule of [...this.schedules.values()]) { for (const [key, consumer] of schedule.consumers) if (consumer.address.controlEpoch !== epoch) { schedule.consumers.delete(key); this.consumerAddresses.delete(key); } if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(schedule.tabId); } }
  hasConsumer(key: string, address: TabAddress): boolean { const consumer = this.schedules.get(address.tabId)?.consumers.get(key); return consumer !== undefined && sameAddress(consumer.address, address); }
  requestCapture(tabId: string): void { const schedule = this.schedules.get(tabId); if (schedule !== undefined) this.arm(schedule, 0); }
  latestFrame(tabId: string): FrameEvent | undefined { return this.latest.get(tabId); }
  latestValidFrame(address: TabAddress, maxAgeMs = 2_000): FrameEvent | undefined {
    const frame = this.latest.get(address.tabId);
    if (frame === undefined || !sameAddress(frame.address, address) || performance.now() - frame.capturedMonotonicMs > maxAgeMs) return undefined;
    let tab: TabRecord;
    try { tab = this.registry.resolve(address); } catch { return undefined; }
    if (tab.documentGeneration !== frame.documentGeneration || tab.viewportGeneration !== frame.viewportGeneration) return undefined;
    if (!this.artifacts.hasWorkspaceFrame(this.actor, frame.artifactId, address.browserSessionId, address.tabId, frame.sha256, frame.byteLength)) return undefined;
    return frame;
  }

  async stop(tabId: string, retainLatestMs = this.latestRetentionMs): Promise<void> {
    const schedule = this.schedules.get(tabId);
    if (schedule === undefined) { if (retainLatestMs <= 0) this.evictLatest(tabId); return; }
    if (!schedule.closed) {
      schedule.closed = true;
      schedule.generation++;
      schedule.controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "Frame capture was stopped."));
      if (schedule.timer !== undefined) { clearTimeout(schedule.timer); delete schedule.timer; delete schedule.timerDueMs; }
      for (const key of schedule.consumers.keys()) this.consumerAddresses.delete(key);
      schedule.consumers.clear();
      schedule.captureRequested = false;
      this.schedules.delete(tabId);
      this.retainLatest(schedule.browserSessionId, schedule.tabId, retainLatestMs);
    }
    await schedule.capturePromise?.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.motor.off("actionStart", this.onActionStart);
    this.motor.off("actionEnd", this.onActionEnd);
    this.motor.off("sample", this.onSample);
    await Promise.all([...this.schedules.keys()].map(async (tabId) => await this.stop(tabId, 0)));
    for (const tabId of [...this.latest.keys()]) this.evictLatest(tabId);
    this.consumerAddresses.clear();
  }

  private readonly onActionStart = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions++; this.arm(schedule, 0); };
  private readonly onActionEnd = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule === undefined) return; schedule.activeActions = Math.max(0, schedule.activeActions - 1); if (schedule.consumers.size === 0 && schedule.activeActions === 0) void this.stop(tabId); };
  private readonly onSample = ({ tabId }: { tabId: string }): void => { const schedule = this.schedules.get(tabId); if (schedule !== undefined && schedule.activeActions > 0) this.arm(schedule, this.burstIntervalMs); };

  private schedule(tab: TabRecord): TabSchedule {
    const existing = this.schedules.get(tab.tabId);
    if (existing !== undefined) return existing;
    const eviction = this.latestEvictions.get(tab.tabId);
    if (eviction !== undefined) { clearTimeout(eviction); this.latestEvictions.delete(tab.tabId); }
    const schedule: TabSchedule = {
      tabId: tab.tabId,
      browserSessionId: tab.browserSessionId,
      consumers: new Map(),
      activeActions: 0,
      captureRequested: false,
      lastCaptureStartedMs: 0,
      minimumIntervalMs: 0,
      recoverySuccessesRemaining: 0,
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

  private interval(schedule: TabSchedule): number {
    const base = schedule.activeActions > 0 ? this.burstIntervalMs : [...schedule.consumers.values()].some((consumer) => consumer.interest === "selected") ? this.selectedIntervalMs : this.idleIntervalMs;
    return schedule.recoverySuccessesRemaining > 0 ? Math.max(base, schedule.minimumIntervalMs, this.frameTimeoutRecoveryMs) : Math.max(base, schedule.minimumIntervalMs);
  }

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
    let attempt: { identity: CaptureProofIdentity; selectedAtStart: boolean } | undefined;
    const transaction = async (captureSignal: AbortSignal): Promise<void> => {
      const targetId = tab.targetId;
      const cdpSessionId = tab.cdpSessionId;
      const documentGeneration = tab.documentGeneration;
      const viewportGeneration = tab.viewportGeneration;
      const controlEpoch = this.currentEpoch();
      const address: TabAddress = { browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId, controlEpoch };
      attempt = {
        identity: { browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId, documentGeneration, viewportGeneration, controlEpoch },
        selectedAtStart: [...schedule.consumers.values()].some((consumer) => consumer.interest === "selected" && sameAddress(consumer.address, address)),
      };
      try {
        await this.motor.ensureOverlay(tab, captureSignal);
        this.assertCurrent(schedule, generation, captureSignal);
        const before = await layout(tab, captureSignal);
        this.assertCurrent(schedule, generation, captureSignal);
        this.captureCoordinator?.recordFrameScreenshotAttempt();
        const result = await frameConnection(tab).send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, tab.cdpSessionId, { signal: captureSignal });
        await this.afterScreenshotForTest?.();
        this.assertCurrent(schedule, generation, captureSignal);
        const after = await layout(tab, captureSignal);
        const capturedMonotonicMs = performance.now();
        if (tab.targetId !== targetId || tab.documentGeneration !== documentGeneration || tab.viewportGeneration !== viewportGeneration) throw new BrowserProtocolError("DOCUMENT_CHANGED", "Frame target changed during capture.");
        if (before.width !== after.width || before.height !== after.height || before.dpr !== after.dpr || Math.abs(before.scrollX - after.scrollX) > 2 || Math.abs(before.scrollY - after.scrollY) > 2) throw new BrowserProtocolError("VIEWPORT_CHANGED", "Frame viewport changed during capture.");
        const bytes = Buffer.from(result.data, "base64");
        if (bytes.byteLength > 4 * 1024 * 1024) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Workspace frame exceeds the delivery limit.", true);
        const imageDimensions = decodePngDimensions(bytes);
        const captureScaleX = imageDimensions.width / after.width;
        const captureScaleY = imageDimensions.height / after.height;
        if (!Number.isFinite(captureScaleX) || !Number.isFinite(captureScaleY) || captureScaleX <= 0 || captureScaleY <= 0 || Math.abs(captureScaleX - captureScaleY) > 0.02) throw new BrowserProtocolError("CDP_ERROR", "Workspace frame dimensions do not match the captured viewport.");
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
          imagePixelWidth: imageDimensions.width, imagePixelHeight: imageDimensions.height,
          viewport: { width: after.width, height: after.height, devicePixelRatio: after.dpr }, url: after.url, title: after.title, cursor: this.motor.state,
        };
        this.assertCurrent(schedule, generation, captureSignal);
        this.latest.set(tab.tabId, frame);
        this.emit("frame", frame);
        schedule.recoverySuccessesRemaining = Math.max(0, schedule.recoverySuccessesRemaining - 1);
        artifactId = undefined;
      } catch (error) {
        if (artifactId !== undefined) this.artifacts.revokeIfOwned(this.actor, artifactId);
        if (error instanceof CdpCommandTimeoutError && error.method === "Page.captureScreenshot") {
          schedule.minimumIntervalMs = Math.max(schedule.minimumIntervalMs, Math.min(1_000, this.frameTimeoutRecoveryMs));
          schedule.recoverySuccessesRemaining = Math.max(schedule.recoverySuccessesRemaining, 3);
          this.captureCoordinator?.recordFrameScreenshotTimeout();
          this.droppedFrames++;
          // Chrome can continue compositor work after the CDP request times out.
          // Keep this session's capture permit during a bounded recovery dwell so
          // a queued agent screenshot does not inherit that still-busy capture.
          await abortableDelay(this.frameTimeoutRecoveryMs, captureSignal);
        }
        if (tab.state !== "open" && this.schedules.has(schedule.tabId)) void this.stop(schedule.tabId);
        throw error;
      }
    };
    try {
      if (this.captureCoordinator === undefined) await transaction(signal);
      else await this.captureCoordinator.runFrame(tab.tabId, signal, transaction);
      if (attempt !== undefined) this.emit("captureOutcome", { ...attempt, result: "succeeded" } satisfies FrameCaptureOutcome);
    } catch (error) {
      if (attempt !== undefined && isReadinessFailure(error)) this.emit("captureOutcome", { ...attempt, result: "failed" } satisfies FrameCaptureOutcome);
      throw error;
    }
  }

  private retainLatest(browserSessionId: string, tabId: string, retainLatestMs: number): void {
    const prior = this.latestEvictions.get(tabId);
    if (prior !== undefined) clearTimeout(prior);
    if (retainLatestMs <= 0 || this.latest.get(tabId) === undefined) { this.evictLatest(tabId, browserSessionId); return; }
    const timer = setTimeout(() => {
      if (this.latestEvictions.get(tabId) !== timer || this.schedules.has(tabId)) return;
      this.evictLatest(tabId, browserSessionId);
    }, retainLatestMs);
    timer.unref?.();
    this.latestEvictions.set(tabId, timer);
  }

  private evictLatest(tabId: string, browserSessionId?: string): void {
    const timer = this.latestEvictions.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.latestEvictions.delete(tabId);
    const frame = this.latest.get(tabId);
    this.latest.delete(tabId);
    const sessionId = browserSessionId ?? frame?.address.browserSessionId;
    if (sessionId !== undefined) this.artifacts.releaseFrameRing(sessionId, tabId);
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
function isReadinessFailure(error: unknown): boolean { return !(error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED"); }
function decodePngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.byteLength < 24 || bytes.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new BrowserProtocolError("CDP_ERROR", "Workspace frame is not a valid PNG image.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 32_768 || height > 32_768) throw new BrowserProtocolError("CDP_ERROR", "Workspace frame dimensions are invalid.");
  return { width, height };
}
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  signal.throwIfAborted();
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const complete = (): void => { signal.removeEventListener("abort", abort); resolveDelay(); };
    const timer = setTimeout(complete, ms);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); rejectDelay(signal.reason ?? new BrowserProtocolError("OPERATION_CANCELLED", "Frame timeout recovery was cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
