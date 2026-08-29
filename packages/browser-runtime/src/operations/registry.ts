import { createHash } from "node:crypto";
import { BrowserProtocolError, type ActorIdentity, type DispatchState, type OperationState, type OperationStatus, type ProtocolError } from "@webx/browser-protocol";
import { actorKey } from "../actor/identity.js";

interface MutableOperation {
  readonly actor: string;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly laneKey: string;
  readonly browserSessionId?: string;
  readonly tabId?: string;
  readonly controlEpoch?: number;
  readonly failOnTargetTermination: boolean;
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
  fingerprint?: string;
  laneKey: string;
  deadline: string;
  browserSessionId?: string;
  tabId?: string;
  controlEpoch?: number;
  failOnTargetTermination?: boolean;
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
        this.cancelMutable(operation, new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control changed before the operation completed."));
      }
    }
    return next;
  }

  submit<T>(actor: ActorIdentity, options: SubmitOptions, task: OperationTask<T>): OperationStatus {
    this.prune();
    const key = operationKey(actor, options.operationId);
    const fingerprint = options.fingerprint ?? canonicalOperationFingerprint({ laneKey: options.laneKey, browserSessionId: options.browserSessionId, tabId: options.tabId, controlEpoch: options.controlEpoch });
    const duplicate = this.operations.get(key);
    if (duplicate !== undefined) {
      if (duplicate.fingerprint !== fingerprint) throw new BrowserProtocolError("OPERATION_CONFLICT", "Operation ID was reused for different mutation semantics.");
      return publicStatus(duplicate);
    }
    if (this.operations.size >= this.maxOperations) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Operation registry is full.", true);
    const deadlineWall = Date.parse(options.deadline);
    const remaining = deadlineWall - this.wall();
    if (!Number.isFinite(deadlineWall) || remaining <= 0) throw new BrowserProtocolError("DEADLINE_EXCEEDED", "Operation deadline has expired.");
    if (options.browserSessionId !== undefined && options.controlEpoch !== undefined && options.controlEpoch !== this.currentEpoch(actor, options.browserSessionId)) {
      throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
    }
    const lane = this.queues.get(options.laneKey) ?? [];
    if (lane.length >= this.maxQueuedPerLane) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Operation lane is full.", true);
    const operation: MutableOperation = {
      actor: actorKey(actor), operationId: options.operationId, fingerprint, laneKey: options.laneKey,
      ...(options.browserSessionId !== undefined ? { browserSessionId: options.browserSessionId } : {}),
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
      ...(options.controlEpoch !== undefined ? { controlEpoch: options.controlEpoch } : {}),
      failOnTargetTermination: options.failOnTargetTermination ?? true,
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

  lookup(actor: ActorIdentity, operationId: string, fingerprint: string): OperationStatus | undefined {
    this.prune();
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) return undefined;
    if (operation.fingerprint !== fingerprint) throw new BrowserProtocolError("OPERATION_CONFLICT", "Operation ID was reused for different mutation semantics.");
    return publicStatus(operation);
  }

  status(actor: ActorIdentity, operationId: string): OperationStatus {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new BrowserProtocolError("OPERATION_NOT_FOUND", "Operation not found.");
    return publicStatus(operation);
  }

  result(actor: ActorIdentity, operationId: string): unknown {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new BrowserProtocolError("OPERATION_NOT_FOUND", "Operation not found.");
    return operation.result;
  }

  async wait(actor: ActorIdentity, operationId: string, signal?: AbortSignal): Promise<OperationStatus> {
    signal?.throwIfAborted();
    while (true) {
      const status = this.status(actor, operationId);
      if (isTerminal(status.state)) return status;
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { cleanup(); reject(signal?.reason ?? new BrowserProtocolError("OPERATION_CANCELLED", "Operation wait cancelled.")); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 5);
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }

  cancel(actor: ActorIdentity, operationId: string): OperationStatus {
    const operation = this.operations.get(operationKey(actor, operationId));
    if (operation === undefined) throw new BrowserProtocolError("OPERATION_NOT_FOUND", "Operation not found.");
    if (!isTerminal(operation.state)) this.cancelMutable(operation, new BrowserProtocolError("OPERATION_CANCELLED", "The operation was cancelled."));
    return publicStatus(operation);
  }

  failSession(actor: ActorIdentity, browserSessionId: string, code: "BROWSER_EXITED" | "CDP_DISCONNECTED" = "BROWSER_EXITED"): void {
    for (const operation of this.operations.values()) {
      if (operation.actor === actorKey(actor) && operation.browserSessionId === browserSessionId && !isTerminal(operation.state)) {
        this.failMutable(operation, new BrowserProtocolError(code, code === "CDP_DISCONNECTED" ? "Browser connection disconnected." : "Browser session exited.", true));
      }
    }
  }

  failTab(actor: ActorIdentity, browserSessionId: string, tabId: string): void {
    for (const operation of this.operations.values()) {
      if (operation.actor === actorKey(actor) && operation.browserSessionId === browserSessionId && operation.tabId === tabId && operation.failOnTargetTermination && !isTerminal(operation.state)) {
        this.failMutable(operation, new BrowserProtocolError("TARGET_CRASHED", "Browser target closed."));
      }
    }
  }

  prune(): void {
    const cutoff = this.wall() - this.retentionMs;
    for (const [key, operation] of this.operations) {
      if (isTerminal(operation.state) && operation.finishedAt !== undefined && Date.parse(operation.finishedAt) <= cutoff) this.operations.delete(key);
    }
  }

  clear(): void {
    for (const operation of this.operations.values()) if (!isTerminal(operation.state)) this.failMutable(operation, new BrowserProtocolError("BROWSER_EXITED", "Browser runtime stopped."));
    this.queues.clear();
    this.operations.clear();
    this.epochs.clear();
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
          if (operation.controlEpoch !== this.currentEpoch(actor, operation.browserSessionId)) { this.cancelMutable(operation, new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.")); continue; }
        }
        operation.state = "running";
        operation.startedAt = new Date(this.wall()).toISOString();
        const deadlineTimer = setTimeout(() => {
          if (!isTerminal(operation.state)) {
            operation.controller.abort(new BrowserProtocolError("DEADLINE_EXCEEDED", "Operation deadline exceeded."));
            this.expireMutable(operation);
          }
        }, Math.max(0, operation.deadlineMonotonicMs - this.monotonic()));
        const context: OperationContext = {
          signal: operation.controller.signal,
          deadlineMonotonicMs: operation.deadlineMonotonicMs,
          markPartiallyDispatched: () => { if (!isTerminal(operation.state) && operation.dispatchState === "not-dispatched") operation.dispatchState = "partially-dispatched"; },
          markDispatched: () => { if (!isTerminal(operation.state)) operation.dispatchState = "dispatched"; },
          checkpoint: () => {
            operation.controller.signal.throwIfAborted();
            if (this.monotonic() >= operation.deadlineMonotonicMs) throw new BrowserProtocolError("DEADLINE_EXCEEDED", "Operation deadline exceeded.");
            if (operation.browserSessionId !== undefined && operation.controlEpoch !== undefined && operation.controlEpoch !== this.currentEpoch(splitActor(operation.actor), operation.browserSessionId)) throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
          },
        };
        try {
          const result = await operation.task(context);
          if (!isTerminal(operation.state)) { operation.result = result; operation.state = "committed"; operation.finishedAt = new Date(this.wall()).toISOString(); }
        } catch (error) {
          if (!isTerminal(operation.state)) this.failMutable(operation, toProtocolError(error));
        } finally { clearTimeout(deadlineTimer); }
      }
    } finally {
      this.runningLanes.delete(laneKey);
      if ((this.queues.get(laneKey)?.length ?? 0) === 0) this.queues.delete(laneKey);
      else void this.drain(laneKey);
    }
  }

  private cancelMutable(operation: MutableOperation, error: BrowserProtocolError): void {
    this.removeQueued(operation);
    operation.controller.abort(error);
    operation.state = "cancelled";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = error.sanitized();
  }
  private failMutable(operation: MutableOperation, error: BrowserProtocolError): void {
    this.removeQueued(operation);
    operation.controller.abort(error);
    operation.state = "failed";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = error.sanitized();
  }
  private expireMutable(operation: MutableOperation): void {
    this.removeQueued(operation);
    const error = new BrowserProtocolError("DEADLINE_EXCEEDED", "Operation deadline exceeded.");
    operation.controller.abort(error);
    operation.state = "expired";
    operation.finishedAt = new Date(this.wall()).toISOString();
    operation.error = error.sanitized();
  }

  private removeQueued(operation: MutableOperation): void {
    if (operation.state !== "queued") return;
    const queue = this.queues.get(operation.laneKey);
    if (queue === undefined) return;
    const index = queue.indexOf(operation);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0 && !this.runningLanes.has(operation.laneKey)) this.queues.delete(operation.laneKey);
  }
}

export function canonicalOperationFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BrowserProtocolError("INVALID_REQUEST", "Operation fingerprint contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new BrowserProtocolError("INVALID_REQUEST", "Operation fingerprint contains an unsupported value.");
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
function toProtocolError(error: unknown): BrowserProtocolError {
  if (error instanceof BrowserProtocolError) return error;
  return new BrowserProtocolError("INTERNAL_ERROR", "Browser operation failed.");
}
function isTerminal(state: OperationState): boolean { return state === "committed" || state === "failed" || state === "cancelled" || state === "expired"; }
function operationKey(actor: ActorIdentity, operationId: string): string { return `${actorKey(actor)}\u0000${operationId}`; }
function epochKey(actor: ActorIdentity, browserSessionId: string): string { return `${actorKey(actor)}\u0000${browserSessionId}`; }
function splitActor(key: string): ActorIdentity { const [principalId = "", agentSessionId = ""] = key.split("\u0000"); return { principalId, agentSessionId }; }
