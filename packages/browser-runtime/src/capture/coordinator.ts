import { BrowserProtocolError } from "@webx/browser-protocol";

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_TIMING_SAMPLES = 2_048;

export interface CaptureTimingDistribution {
  readonly count: number;
  readonly retainedCount: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

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
  readonly agentRequests: number;
  readonly frameRequests: number;
  readonly agentScreenshotAttempts: number;
  readonly frameScreenshotAttempts: number;
  readonly agentScreenshotRetries: number;
  readonly completedAgent: number;
  readonly completedFrame: number;
  readonly failedAgent: number;
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
  readonly agentQueueWaitMs: CaptureTimingDistribution;
  readonly frameQueueWaitMs: CaptureTimingDistribution;
  readonly agentTransactionMs: CaptureTimingDistribution;
  readonly frameTransactionMs: CaptureTimingDistribution;
  readonly processActiveTransactions: number;
  readonly processMaxObservedConcurrent: number;
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
  private static processActiveTransactions = 0;
  private static processMaxObservedConcurrent = 0;
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
  private agentRequests = 0;
  private frameRequests = 0;
  private agentScreenshotAttempts = 0;
  private frameScreenshotAttempts = 0;
  private agentScreenshotRetries = 0;
  private completedAgent = 0;
  private completedFrame = 0;
  private failedAgent = 0;
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
  private readonly agentQueueWaitSamples: number[] = [];
  private readonly frameQueueWaitSamples: number[] = [];
  private readonly agentTransactionSamples: number[] = [];
  private readonly frameTransactionSamples: number[] = [];
  private agentQueueWaitCount = 0;
  private frameQueueWaitCount = 0;
  private agentTransactionCount = 0;
  private frameTransactionCount = 0;

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
      agentRequests: this.agentRequests,
      frameRequests: this.frameRequests,
      agentScreenshotAttempts: this.agentScreenshotAttempts,
      frameScreenshotAttempts: this.frameScreenshotAttempts,
      agentScreenshotRetries: this.agentScreenshotRetries,
      completedAgent: this.completedAgent,
      completedFrame: this.completedFrame,
      failedAgent: this.failedAgent,
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
      agentQueueWaitMs: distribution(this.agentQueueWaitCount, this.agentQueueWaitSamples),
      frameQueueWaitMs: distribution(this.frameQueueWaitCount, this.frameQueueWaitSamples),
      agentTransactionMs: distribution(this.agentTransactionCount, this.agentTransactionSamples),
      frameTransactionMs: distribution(this.frameTransactionCount, this.frameTransactionSamples),
      processActiveTransactions: SessionCaptureCoordinator.processActiveTransactions,
      processMaxObservedConcurrent: SessionCaptureCoordinator.processMaxObservedConcurrent,
      closed: this.closed,
    };
  }

  runAgent<T>(tabId: string, signal: AbortSignal | undefined, transaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.agentRequests = increment(this.agentRequests);
    if (this.closed) return Promise.reject(cancelled("Session capture coordinator is closed."));
    signal?.throwIfAborted();
    if (this.agentQueue.length >= this.maxAgentQueue) {
      this.rejectedAgent = increment(this.rejectedAgent);
      return Promise.reject(new BrowserProtocolError("LIMIT_EXCEEDED", "Agent screenshot capture queue is full.", true));
    }
    return this.enqueue("agent", tabId, signal, transaction) as Promise<T>;
  }

  runFrame<T>(tabId: string, signal: AbortSignal | undefined, transaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.frameRequests = increment(this.frameRequests);
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

  recordAgentScreenshotAttempt(): void { this.agentScreenshotAttempts = increment(this.agentScreenshotAttempts); }
  recordFrameScreenshotAttempt(): void { this.frameScreenshotAttempts = increment(this.frameScreenshotAttempts); }
  recordAgentScreenshotRetry(): void { this.agentScreenshotRetries = increment(this.agentScreenshotRetries); }
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
    const transactionStartedMs = this.monotonicNow();
    if (job.kind === "agent") {
      this.agentWaitMaxMs = Math.max(this.agentWaitMaxMs, waitMs);
      this.agentQueueWaitCount = increment(this.agentQueueWaitCount);
      recordTiming(this.agentQueueWaitSamples, waitMs);
    } else {
      this.frameWaitMaxMs = Math.max(this.frameWaitMaxMs, waitMs);
      this.frameQueueWaitCount = increment(this.frameQueueWaitCount);
      recordTiming(this.frameQueueWaitSamples, waitMs);
    }
    this.maxObservedConcurrent = Math.max(this.maxObservedConcurrent, 1);
    SessionCaptureCoordinator.processActiveTransactions = increment(SessionCaptureCoordinator.processActiveTransactions);
    SessionCaptureCoordinator.processMaxObservedConcurrent = Math.max(SessionCaptureCoordinator.processMaxObservedConcurrent, SessionCaptureCoordinator.processActiveTransactions);
    const promise = this.execute(job)
      .then((value) => this.resolveActive(job, value), (error: unknown) => this.rejectActive(job, error))
      .finally(() => {
        const durationMs = Math.max(0, this.monotonicNow() - transactionStartedMs);
        SessionCaptureCoordinator.processActiveTransactions = Math.max(0, SessionCaptureCoordinator.processActiveTransactions - 1);
        if (job.kind === "agent") {
          this.agentTransactionCount = increment(this.agentTransactionCount);
          recordTiming(this.agentTransactionSamples, durationMs);
        } else {
          this.frameTransactionCount = increment(this.frameTransactionCount);
          recordTiming(this.frameTransactionSamples, durationMs);
        }
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
    else if (job.kind === "agent") this.failedAgent = increment(this.failedAgent);
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
function recordTiming(samples: number[], value: number): void {
  samples.push(Number.isFinite(value) ? Math.max(0, value) : 0);
  if (samples.length > MAX_TIMING_SAMPLES) samples.splice(0, samples.length - MAX_TIMING_SAMPLES);
}
function distribution(count: number, values: readonly number[]): CaptureTimingDistribution {
  if (values.length === 0) return { count, retainedCount: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  return {
    count,
    retainedCount: values.length,
    min: sorted[0] ?? 0,
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BrowserProtocolError("INVALID_REQUEST", `${name} bound is invalid.`);
  return value;
}
