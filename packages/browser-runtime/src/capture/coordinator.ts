import { BrowserProtocolError } from "@webx/browser-protocol";

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export interface SessionCaptureCoordinatorOptions {
  maxAgentQueue?: number;
  maxFrameTabs?: number;
  maxConsecutiveAgents?: number;
  monotonicNow?: () => number;
}

export interface SessionCaptureDiagnostics {
  readonly active: 0 | 1;
  readonly activeKind?: "agent" | "frame";
  readonly activeTabId?: string;
  readonly agentQueued: number;
  readonly frameQueued: number;
  readonly maxObservedConcurrent: number;
  readonly maxObservedAgentQueue: number;
  readonly maxObservedFrameQueue: number;
  readonly completedAgent: number;
  readonly completedFrame: number;
  readonly rejectedAgent: number;
  readonly droppedFrame: number;
  readonly coalescedFrame: number;
  readonly cancelled: number;
  readonly agentWaitMaxMs: number;
  readonly frameWaitMaxMs: number;
  readonly agentScreenshotTimeouts: number;
  readonly recoveredAgentScreenshotTimeouts: number;
  readonly unrecoveredAgentScreenshotTimeouts: number;
  readonly frameScreenshotTimeouts: number;
  readonly closed: boolean;
}

type CaptureKind = "agent" | "frame";
interface CaptureJob {
  readonly kind: CaptureKind;
  readonly tabId: string;
  readonly queuedAtMs: number;
  readonly controller: AbortController;
  readonly transaction: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  removeCallerAbort: () => void;
  settled: boolean;
}

export class SessionCaptureCoordinator {
  private readonly maxAgentQueue: number;
  private readonly maxFrameTabs: number;
  private readonly maxConsecutiveAgents: number;
  private readonly monotonicNow: () => number;
  private readonly agentQueue: CaptureJob[] = [];
  private readonly frameQueue = new Map<string, CaptureJob>();
  private activeJob: CaptureJob | undefined;
  private activePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private consecutiveAgents = 0;
  private closed = false;
  private maxObservedConcurrent = 0;
  private maxObservedAgentQueue = 0;
  private maxObservedFrameQueue = 0;
  private completedAgent = 0;
  private completedFrame = 0;
  private rejectedAgent = 0;
  private droppedFrame = 0;
  private coalescedFrame = 0;
  private cancelled = 0;
  private agentWaitMaxMs = 0;
  private frameWaitMaxMs = 0;
  private agentScreenshotTimeouts = 0;
  private recoveredAgentScreenshotTimeouts = 0;
  private unrecoveredAgentScreenshotTimeouts = 0;
  private frameScreenshotTimeouts = 0;

  constructor(options: SessionCaptureCoordinatorOptions = {}) {
    this.maxAgentQueue = boundedInteger(options.maxAgentQueue ?? 8, 1, 8, "agent capture queue");
    this.maxFrameTabs = boundedInteger(options.maxFrameTabs ?? 8, 1, 8, "frame capture queue");
    this.maxConsecutiveAgents = boundedInteger(options.maxConsecutiveAgents ?? 4, 1, 8, "capture fairness");
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  get diagnostics(): SessionCaptureDiagnostics {
    return {
      active: this.activeJob === undefined ? 0 : 1,
      ...(this.activeJob === undefined ? {} : { activeKind: this.activeJob.kind, activeTabId: this.activeJob.tabId }),
      agentQueued: this.agentQueue.length,
      frameQueued: this.frameQueue.size,
      maxObservedConcurrent: this.maxObservedConcurrent,
      maxObservedAgentQueue: this.maxObservedAgentQueue,
      maxObservedFrameQueue: this.maxObservedFrameQueue,
      completedAgent: this.completedAgent,
      completedFrame: this.completedFrame,
      rejectedAgent: this.rejectedAgent,
      droppedFrame: this.droppedFrame,
      coalescedFrame: this.coalescedFrame,
      cancelled: this.cancelled,
      agentWaitMaxMs: this.agentWaitMaxMs,
      frameWaitMaxMs: this.frameWaitMaxMs,
      agentScreenshotTimeouts: this.agentScreenshotTimeouts,
      recoveredAgentScreenshotTimeouts: this.recoveredAgentScreenshotTimeouts,
      unrecoveredAgentScreenshotTimeouts: this.unrecoveredAgentScreenshotTimeouts,
      frameScreenshotTimeouts: this.frameScreenshotTimeouts,
      closed: this.closed,
    };
  }

  runAgent<T>(tabId: string, signal: AbortSignal | undefined, transaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(cancelled("Session capture coordinator is closed."));
    signal?.throwIfAborted();
    if (this.agentQueue.length >= this.maxAgentQueue) {
      this.rejectedAgent = increment(this.rejectedAgent);
      return Promise.reject(new BrowserProtocolError("LIMIT_EXCEEDED", "Agent screenshot capture queue is full.", true));
    }
    return this.enqueue("agent", tabId, signal, transaction) as Promise<T>;
  }

  runFrame<T>(tabId: string, signal: AbortSignal | undefined, transaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(cancelled("Session capture coordinator is closed."));
    signal?.throwIfAborted();
    const existing = this.frameQueue.get(tabId);
    if (existing !== undefined) {
      this.frameQueue.delete(tabId);
      this.coalescedFrame = increment(this.coalescedFrame);
      this.droppedFrame = increment(this.droppedFrame);
      this.rejectQueued(existing, cancelled("Workspace frame capture was replaced by a newer intent."));
    } else if (this.frameQueue.size >= this.maxFrameTabs) {
      this.droppedFrame = increment(this.droppedFrame);
      return Promise.reject(new BrowserProtocolError("LIMIT_EXCEEDED", "Workspace frame capture queue is full.", true));
    }
    return this.enqueue("frame", tabId, signal, transaction) as Promise<T>;
  }

  cancelTab(tabId: string): void {
    for (const job of [...this.agentQueue]) if (job.tabId === tabId) this.rejectQueued(job, cancelled("Tab capture was cancelled."));
    const frame = this.frameQueue.get(tabId);
    if (frame !== undefined) this.rejectQueued(frame, cancelled("Tab capture was cancelled."));
    if (this.activeJob?.tabId === tabId) this.activeJob.controller.abort(cancelled("Tab capture was cancelled."));
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return await this.closePromise;
    if (this.closed && this.activePromise === undefined) return;
    this.closed = true;
    const reason = cancelled("Session capture coordinator is closed.");
    for (const job of [...this.agentQueue]) this.rejectQueued(job, reason);
    for (const job of [...this.frameQueue.values()]) this.rejectQueued(job, reason);
    this.activeJob?.controller.abort(reason);
    const promise = this.activePromise?.catch(() => undefined) ?? Promise.resolve();
    this.closePromise = promise;
    try { await promise; }
    finally { if (this.closePromise === promise) this.closePromise = undefined; }
  }

  recordAgentScreenshotTimeout(): void { this.agentScreenshotTimeouts = increment(this.agentScreenshotTimeouts); }
  recordRecoveredAgentScreenshotTimeout(): void { this.recoveredAgentScreenshotTimeouts = increment(this.recoveredAgentScreenshotTimeouts); }
  recordUnrecoveredAgentScreenshotTimeout(): void { this.unrecoveredAgentScreenshotTimeouts = increment(this.unrecoveredAgentScreenshotTimeouts); }
  recordFrameScreenshotTimeout(): void { this.frameScreenshotTimeouts = increment(this.frameScreenshotTimeouts); }

  private enqueue<T>(kind: CaptureKind, tabId: string, callerSignal: AbortSignal | undefined, transaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const job: CaptureJob = {
        kind,
        tabId,
        queuedAtMs: this.monotonicNow(),
        controller,
        transaction,
        resolve: (value) => resolve(value as T),
        reject,
        removeCallerAbort: () => undefined,
        settled: false,
      };
      const callerAbort = (): void => {
        const reason = callerSignal?.reason ?? cancelled("Capture request was cancelled.");
        if (this.activeJob === job) controller.abort(reason);
        else this.rejectQueued(job, reason);
      };
      job.removeCallerAbort = (): void => callerSignal?.removeEventListener("abort", callerAbort);
      callerSignal?.addEventListener("abort", callerAbort, { once: true });
      if (callerSignal?.aborted) { callerAbort(); return; }
      if (kind === "agent") {
        this.agentQueue.push(job);
        this.maxObservedAgentQueue = Math.max(this.maxObservedAgentQueue, this.agentQueue.length);
      } else {
        this.frameQueue.set(tabId, job);
        this.maxObservedFrameQueue = Math.max(this.maxObservedFrameQueue, this.frameQueue.size);
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed || this.activeJob !== undefined) return;
    const job = this.takeNext();
    if (job === undefined) return;
    this.activeJob = job;
    const waitMs = Math.max(0, this.monotonicNow() - job.queuedAtMs);
    if (job.kind === "agent") this.agentWaitMaxMs = Math.max(this.agentWaitMaxMs, waitMs);
    else this.frameWaitMaxMs = Math.max(this.frameWaitMaxMs, waitMs);
    this.maxObservedConcurrent = Math.max(this.maxObservedConcurrent, 1);
    const promise = this.execute(job)
      .then((value) => this.resolveActive(job, value), (error: unknown) => this.rejectActive(job, error))
      .finally(() => {
        if (this.activeJob === job) this.activeJob = undefined;
        if (this.activePromise === promise) this.activePromise = undefined;
        if (!this.closed) this.pump();
      });
    this.activePromise = promise;
  }

  private async execute(job: CaptureJob): Promise<unknown> {
    const signal = job.controller.signal;
    signal.throwIfAborted();
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (callback: (value: unknown) => void, value: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = (): void => finish(reject, signal.reason ?? cancelled("Capture transaction was cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void Promise.resolve()
        .then(async () => await job.transaction(signal))
        .then((value) => finish(resolve, value), (error: unknown) => finish(reject, error));
    });
  }

  private takeNext(): CaptureJob | undefined {
    if (this.agentQueue.length > 0 && (this.frameQueue.size === 0 || this.consecutiveAgents < this.maxConsecutiveAgents)) {
      this.consecutiveAgents++;
      return this.agentQueue.shift();
    }
    const frame = this.frameQueue.entries().next().value as [string, CaptureJob] | undefined;
    if (frame !== undefined) {
      this.frameQueue.delete(frame[0]);
      this.consecutiveAgents = 0;
      return frame[1];
    }
    if (this.agentQueue.length > 0) {
      this.consecutiveAgents++;
      return this.agentQueue.shift();
    }
    return undefined;
  }

  private resolveActive(job: CaptureJob, value: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.removeCallerAbort();
    if (job.kind === "agent") this.completedAgent = increment(this.completedAgent);
    else this.completedFrame = increment(this.completedFrame);
    job.resolve(value);
  }

  private rejectActive(job: CaptureJob, error: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.removeCallerAbort();
    if (job.controller.signal.aborted) this.cancelled = increment(this.cancelled);
    job.reject(error);
  }

  private rejectQueued(job: CaptureJob, error: unknown): void {
    if (job.settled) return;
    const agentIndex = this.agentQueue.indexOf(job);
    if (agentIndex >= 0) this.agentQueue.splice(agentIndex, 1);
    if (this.frameQueue.get(job.tabId) === job) this.frameQueue.delete(job.tabId);
    job.settled = true;
    job.removeCallerAbort();
    job.controller.abort(error);
    this.cancelled = increment(this.cancelled);
    job.reject(error);
    if (!this.closed) this.pump();
  }
}

function cancelled(message: string): BrowserProtocolError { return new BrowserProtocolError("OPERATION_CANCELLED", message); }
function increment(value: number): number { return Math.min(MAX_COUNTER, value + 1); }
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BrowserProtocolError("INVALID_REQUEST", `${name} bound is invalid.`);
  return value;
}
