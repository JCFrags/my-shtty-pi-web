import type { ActorIdentity, DispatchState, OperationState, OperationStatus, ProtocolError } from "@webx/browser-protocol";
import { actorKey } from "../actor/identity.js";

interface MutableOperation {
  readonly actor: string;
  readonly operationId: string;
  readonly laneKey: string;
  readonly browserSessionId?: string;
  readonly tabId?: string;
  readonly controlEpoch?: number;
  readonly deadlineMonotonicMs: number;
  readonly controller: AbortController;
  state: OperationState;
  dispatchState: DispatchState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: ProtocolError;
  result?: unknown;
  task: OperationTask<unknown>;
}

export interface OperationContext {
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  markPartiallyDispatched(): void;
  markDispatched(): void;
  checkpoint(): void;
}

export type OperationTask<T> = (context: OperationContext) => Promise<T>;

export interface SubmitOptions {
  operationId: string;
  laneKey: string;
  deadline: string;
  browserSessionId?: string;
  tabId?: string;
  controlEpoch?: number;
}

export interface OperationRegistryOptions {
  maxOperations?: number;
  retentionMs?: number;
  maxQueuedPerLane?: number;
  nowWall?: () => number;
  nowMonotonic?: () => number;
}

export class OperationRegistry {
  private readonly operations = new Map<string, MutableOperation>();
  private readonly queues = new Map<string, MutableOperation[]>();
  private readonly runningLanes = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private readonly maxOperations: number;
  private readonly retentionMs: number;
  private readonly maxQueuedPerLane: number;
  private readonly wall: () => number;
  private readonly monotonic: () => number;

  constructor(options: OperationRegistryOptions = {}) {
    this.maxOperations = options.maxOperations ?? 2048;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxQueuedPerLane = options.maxQueuedPerLane ?? 32;
    this.wall = options.nowWall ?? Date.now;
    this.monotonic = options.nowMonotonic ?? (() => performance.now());
  }

  get size(): number { return this.operations.size; }

  currentEpoch(actor: ActorIdentity, browserSessionId: string): number {
    return this.epochs.get(epochKey(actor, browserSessionId)) ?? 1;
  }

  incrementEpoch(actor: ActorIdentity, browserSessionId: string): number {
    const key = epochKey(actor, browserSessionId);
    const next = this.currentEpoch(actor, browserSessionId) + 1;
    this.epochs.set(key, next);
    for (const operation of this.operations.values()) {
      if (operation.actor === actorKey(actor) && operation.browserSessionId === browserSessionId && operation.controlEpoch !== undefined && operation.controlEpoch < next && !isTerminal(operation.state)) {
        this.cancelMutable(operation, "CONTROL_EPOCH_STALE", "Control changed before the operation completed.");
      }
    }
    return next;
  }

  submit<T>(actor: ActorIdentity, options: SubmitOptions, task: OperationTask<T>): OperationStatus {
    this.prune();
    const key = operationKey(actor, options.operationId);
    const duplicate = this.operations.get(key);
    if (duplicate !== undefined) return publicStatus(duplicate);
    if (this.operations.size >= this.maxOperations) throw new Error("Operation registry is full.");
    const deadlineWall = Date.parse(options.deadline);
    const remaining = deadlineWall - this.wall();
    if (!Number.isFinite(deadlineWall) || remaining <= 0) throw new Error("Operation deadline has expired.");
    if (options.browserSessionId !== undefined && options.controlEpoch !== undefined && options.controlEpoch !== this.currentEpoch(actor, options.browserSessionId)) {
      throw new Error("Control epoch is stale.");
    }
    const lane = this.queues.get(options.laneKey) ?? [];
    if (lane.length >= this.maxQueuedPerLane) throw new Error("Operation lane is full.");
    const operation: MutableOperation = {
      actor: actorKey(actor), operationId: options.operationId, laneKey: options.laneKey,
      ...(options.browserSessionId !== undefined ? { browserSessionId: options.browserSessionId } : {}),
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
      ...(options.controlEpoch !== undefined ? { controlEpoch: options.controlEpoch } : {}),
      deadlineMonotonicMs: this.monotonic() + remaining,
      controller: new AbortController(), state: "queued", dispatchState: "not-dispatched",
      queuedAt: new Date(this.wall()).toISOString(), task: task as OperationTask<unknown>,
    };
    this.operations.set(key, operation);
    lane.push(operation);
    this.queues.set(options.laneKey, lane);
    void this.drain(options.laneKey);
    return publicStatus(operation);
  }

  status(actor: ActorIdentity, operationId: string): OperationStatus {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new Error("Operation not found.");
    return publicStatus(operation);
  }

  result(actor: ActorIdentity, operationId: string): unknown {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new Error("Operation not found.");
    return operation.result;
  }

  async wait(actor: ActorIdentity, operationId: string, signal?: AbortSignal): Promise<OperationStatus> {
    while (true) {
      const status = this.status(actor, operationId);
      if (isTerminal(status.state)) return status;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); resolve(); }, 5);
        const abort = (): void => { cleanup(); reject(signal?.reason ?? new Error("Operation wait cancelled.")); };
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  cancel(actor: ActorIdentity, operationId: string): OperationStatus {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new Error("Operation not found.");
    if (!isTerminal(operation.state)) this.cancelMutable(operation, "OPERATION_CANCELLED", "The operation was cancelled.");
    return publicStatus(operation);
  }

  failSession(actor: ActorIdentity, browserSessionId: string, message = "Browser session failed."): void {
    for (const operation of this.operations.values()) {
      if (operation.actor === actorKey(actor) && operation.browserSessionId === browserSessionId && !isTerminal(operation.state)) {
        this.failMutable(operation, "BROWSER_EXITED", message);
      }
    }
  }

  failTab(actor: ActorIdentity, browserSessionId: string, tabId: string): void {
    for (const operation of this.operations.values()) {
      if (operation.actor === actorKey(actor) && operation.browserSessionId === browserSessionId && operation.tabId === tabId && !isTerminal(operation.state)) {
        this.failMutable(operation, "TARGET_CRASHED", "Browser target closed.");
      }
    }
  }

  prune(): void {
    const cutoff = this.wall() - this.retentionMs;
    for (const [key, operation] of this.operations) {
      if (isTerminal(operation.state) && operation.finishedAt !== undefined && Date.parse(operation.finishedAt) <= cutoff) this.operations.delete(key);
    }
  }

  private async drain(laneKey: string): Promise<void> {
    if (this.runningLanes.has(laneKey)) return;
    this.runningLanes.add(laneKey);
    try {
      const queue = this.queues.get(laneKey);
      while (queue && queue.length > 0) {
        const operation = queue.shift();
        if (operation === undefined || operation.state !== "queued") continue;
        if (this.monotonic() >= operation.deadlineMonotonicMs) { this.expireMutable(operation); continue; }
        if (operation.browserSessionId !== undefined && operation.controlEpoch !== undefined) {
          const actor = splitActor(operation.actor);
          if (operation.controlEpoch !== this.currentEpoch(actor, operation.browserSessionId)) { this.cancelMutable(operation, "CONTROL_EPOCH_STALE", "Control epoch is stale."); continue; }
        }
        operation.state = "running";
        operation.startedAt = new Date(this.wall()).toISOString();
        const deadlineTimer = setTimeout(() => {
          if (!isTerminal(operation.state)) {
            operation.controller.abort(new Error("Operation deadline exceeded."));
            this.expireMutable(operation);
          }
        }, Math.max(0, operation.deadlineMonotonicMs - this.monotonic()));
        const context: OperationContext = {
          signal: operation.controller.signal,
          deadlineMonotonicMs: operation.deadlineMonotonicMs,
          markPartiallyDispatched: () => { if (!isTerminal(operation.state) && operation.dispatchState === "not-dispatched") operation.dispatchState = "partially-dispatched"; },
          markDispatched: () => { if (!isTerminal(operation.state)) operation.dispatchState = "dispatched"; },
          checkpoint: () => {
            if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
            if (this.monotonic() >= operation.deadlineMonotonicMs) throw new Error("Operation deadline exceeded.");
            if (operation.browserSessionId !== undefined && operation.controlEpoch !== undefined && operation.controlEpoch !== this.currentEpoch(splitActor(operation.actor), operation.browserSessionId)) throw new Error("Control epoch is stale.");
          },
        };
        try {
          const result = await operation.task(context);
          if (!isTerminal(operation.state)) { operation.result = result; operation.state = "committed"; operation.finishedAt = new Date(this.wall()).toISOString(); }
        } catch (error) {
          if (!isTerminal(operation.state)) this.failMutable(operation, "CDP_ERROR", error instanceof Error ? error.message : "Operation failed.");
        } finally { clearTimeout(deadlineTimer); }
      }
    } finally {
      this.runningLanes.delete(laneKey);
      if ((this.queues.get(laneKey)?.length ?? 0) === 0) this.queues.delete(laneKey);
      else void this.drain(laneKey);
    }
  }

  private cancelMutable(operation: MutableOperation, code: "OPERATION_CANCELLED" | "CONTROL_EPOCH_STALE", message: string): void {
    operation.controller.abort(new Error(message));
    operation.state = "cancelled";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = errorRecord(code, message);
  }
  private failMutable(operation: MutableOperation, code: ProtocolError["code"], message: string): void {
    operation.controller.abort(new Error(message));
    operation.state = "failed";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = errorRecord(code, message);
  }
  private expireMutable(operation: MutableOperation): void {
    operation.controller.abort(new Error("Operation deadline exceeded."));
    operation.state = "expired";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = errorRecord("DEADLINE_EXCEEDED", "Operation deadline exceeded.");
  }
}

function publicStatus(operation: MutableOperation): OperationStatus {
  return {
    kind: "operation", operationId: operation.operationId, state: operation.state, dispatchState: operation.dispatchState,
    queuedAt: operation.queuedAt,
    ...(operation.startedAt !== undefined ? { startedAt: operation.startedAt } : {}),
    ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
    ...(operation.error !== undefined ? { error: operation.error } : {}),
  };
}
function errorRecord(code: ProtocolError["code"], message: string): ProtocolError { return { code, message: message.slice(0, 512), retryable: false }; }
function isTerminal(state: OperationState): boolean { return state === "committed" || state === "failed" || state === "cancelled" || state === "expired"; }
function operationKey(actor: ActorIdentity, operationId: string): string { return `${actorKey(actor)}\u0000${operationId}`; }
function epochKey(actor: ActorIdentity, browserSessionId: string): string { return `${actorKey(actor)}\u0000${browserSessionId}`; }
function splitActor(key: string): ActorIdentity { const [principalId = "", agentSessionId = ""] = key.split("\u0000"); return { principalId, agentSessionId }; }
