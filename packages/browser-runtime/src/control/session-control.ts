import { randomBytes } from "node:crypto";
import { BrowserProtocolError } from "@webx/browser-protocol";

export type SessionControlState = "agent" | "takeover-pending" | "human" | "human-disconnected" | "return-pending";
export type ControlTransferState = "none" | "taking-control" | "returning-control";
export type LeaseExpiryState = "none" | "healthy" | "expiring" | "grace";

export type SessionControlErrorCode =
  | "CONTROL_NOT_READY"
  | "CONTROL_TRANSFER_PENDING"
  | "CONTROL_HELD_BY_HUMAN"
  | "CONTROL_LEASE_REQUIRED"
  | "CONTROL_LEASE_EXPIRED"
  | "CONTROL_LEASE_CONFLICT";

export class SessionControlError extends BrowserProtocolError {
  constructor(readonly code: SessionControlErrorCode, message: string, readonly retryable: boolean) {
    super(code, message, retryable);
    this.name = "SessionControlError";
  }
}

export interface SanitizedSessionControl {
  readonly controlState: SessionControlState;
  readonly controlEpoch: number;
  readonly controlTransfer: ControlTransferState;
  readonly selectedHumanControlTabId?: string;
  readonly leaseExpiry: LeaseExpiryState;
}

export interface ControlLeaseResult {
  readonly leaseId: string;
  readonly controlState: "human";
  readonly controlEpoch: number;
  readonly selectedTabId: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresInMs: number;
  readonly inputTargetGeneration: number;
  readonly nextInputBatchSequence: number;
}

export interface ControlReleaseResult {
  readonly controlState: "agent";
  readonly controlEpoch: number;
}

export interface ControlLeaseProof {
  readonly connectionId: string;
  readonly leaseId: string;
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly controlEpoch: number;
  readonly inputTargetGeneration: number;
}

export interface AcquireControlRequest {
  readonly connectionId: string;
  readonly tabId: string;
  readonly subscriptionId: string;
  readonly expectedControlEpoch: number;
}

export interface ReleaseControlRequest {
  readonly connectionId: string;
  readonly leaseId: string;
}

export interface SessionControlHooks {
  readonly browserSessionId: string;
  currentEpoch(): number;
  advanceEpoch(): number;
  assertAcquireReady(tabId: string): void;
  invalidateAgentAuthority(nextEpoch: number): void;
  awaitAgentSettlement(signal: AbortSignal): Promise<void>;
  stopHumanInput(): void;
  awaitHumanInputSettlement(signal: AbortSignal): Promise<void>;
  releaseHeldInput(signal: AbortSignal): Promise<void>;
  heldInputCount(): number;
  establishHumanFrameStream(connectionId: string, subscriptionId: string, tabId: string, epoch: number, signal: AbortSignal): Promise<void>;
  invalidateHumanAuthority(nextEpoch: number): void;
  establishAgentFrameStream(epoch: number, signal: AbortSignal): Promise<void>;
  changed(state: SanitizedSessionControl): void;
  terminalCleanupRequired(reason: string): void;
}

export interface SessionControlOptions {
  readonly heartbeatIntervalMs?: number;
  readonly leaseExpiryMs?: number;
  readonly disconnectGraceMs?: number;
  readonly takeoverTimeoutMs?: number;
  readonly returnTimeoutMs?: number;
  readonly monotonicNow?: () => number;
  readonly randomLeaseId?: () => string;
}

interface HumanLease {
  readonly leaseId: string;
  readonly connectionId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly issuedMonotonicMs: number;
  lastHeartbeatMonotonicMs: number;
  expiresMonotonicMs: number;
  readonly inputTargetGeneration: number;
  nextInputBatchSequence: number;
}

interface TransitionIdentity {
  readonly sequence: number;
  readonly direction: "takeover" | "return";
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Browserd-owned session authority. It never exposes connection or lease identity in snapshots. */
export class SessionControlAuthority {
  private stateValue: SessionControlState = "agent";
  private transition: TransitionIdentity | undefined;
  private transitionSequence = 0;
  private lease: HumanLease | undefined;
  private leaseGeneration = 0;
  private inputTargetGeneration = 0;
  private leaseTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private disconnectedDeadlineMs: number | undefined;
  private closed = false;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseExpiryMs: number;
  private readonly disconnectGraceMs: number;
  private readonly takeoverTimeoutMs: number;
  private readonly returnTimeoutMs: number;
  private readonly now: () => number;
  private readonly randomLeaseId: () => string;

  constructor(private readonly hooks: SessionControlHooks, options: SessionControlOptions = {}) {
    this.heartbeatIntervalMs = bounded(options.heartbeatIntervalMs ?? 2_000, 250, 30_000, "heartbeat interval");
    this.leaseExpiryMs = bounded(options.leaseExpiryMs ?? 8_000, this.heartbeatIntervalMs * 2, 60_000, "lease expiry");
    this.disconnectGraceMs = bounded(options.disconnectGraceMs ?? 5_000, 250, 30_000, "disconnect grace");
    this.takeoverTimeoutMs = bounded(options.takeoverTimeoutMs ?? 5_000, 100, 30_000, "takeover timeout");
    this.returnTimeoutMs = bounded(options.returnTimeoutMs ?? 2_000, 100, 30_000, "return timeout");
    this.now = options.monotonicNow ?? (() => performance.now());
    this.randomLeaseId = options.randomLeaseId ?? (() => `lease_${randomBytes(24).toString("base64url")}`);
  }

  get state(): SessionControlState { return this.stateValue; }
  get controlEpoch(): number { return this.hooks.currentEpoch(); }
  get expectedHeartbeatIntervalMs(): number { return this.heartbeatIntervalMs; }

  snapshot(): SanitizedSessionControl {
    const controlTransfer: ControlTransferState = this.stateValue === "takeover-pending" ? "taking-control" : this.stateValue === "return-pending" ? "returning-control" : "none";
    const selectedHumanControlTabId = this.stateValue === "human" || this.stateValue === "human-disconnected" ? this.lease?.tabId : undefined;
    let leaseExpiry: LeaseExpiryState = "none";
    if (this.stateValue === "human-disconnected") leaseExpiry = "grace";
    else if (this.stateValue === "human" && this.lease !== undefined) leaseExpiry = this.lease.expiresMonotonicMs - this.now() <= this.heartbeatIntervalMs * 2 ? "expiring" : "healthy";
    return {
      controlState: this.stateValue,
      controlEpoch: this.controlEpoch,
      controlTransfer,
      ...(selectedHumanControlTabId === undefined ? {} : { selectedHumanControlTabId }),
      leaseExpiry,
    };
  }

  assertAgentAdmission(): void {
    if (this.stateValue === "agent") return;
    if (this.stateValue === "takeover-pending" || this.stateValue === "return-pending") throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control transfer is pending.", true);
    throw new SessionControlError("CONTROL_HELD_BY_HUMAN", "Browser control is held by the local user.", true);
  }

  async acquire(request: AcquireControlRequest): Promise<ControlLeaseResult> {
    this.assertOpen();
    if (this.stateValue !== "agent") {
      if (this.stateValue === "takeover-pending" || this.stateValue === "return-pending") throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control transfer is pending.", true);
      throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control cannot be acquired.", true);
    }
    if (request.expectedControlEpoch !== this.controlEpoch) throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control state changed.", true);
    this.hooks.assertAcquireReady(request.tabId);

    const transition = this.beginTransition("takeover", "takeover-pending");
    const takeoverEpoch = this.advanceEpoch();
    this.hooks.invalidateAgentAuthority(takeoverEpoch);
    try {
      await withBudget(this.takeoverTimeoutMs, async (signal) => {
        await this.hooks.awaitAgentSettlement(signal);
        this.assertTransition(transition);
        await this.hooks.releaseHeldInput(signal);
        this.assertTransition(transition);
        if (this.hooks.heldInputCount() !== 0) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Input cleanup did not settle.", true);
        await this.hooks.establishHumanFrameStream(request.connectionId, request.subscriptionId, request.tabId, takeoverEpoch, signal);
        this.assertTransition(transition);
      });
      this.leaseGeneration = increment(this.leaseGeneration, "lease generation");
      this.inputTargetGeneration = increment(this.inputTargetGeneration, "input target generation");
      const issued = this.now();
      const lease: HumanLease = {
        leaseId: this.randomLeaseId(), connectionId: request.connectionId, tabId: request.tabId,
        generation: this.leaseGeneration, issuedMonotonicMs: issued, lastHeartbeatMonotonicMs: issued,
        expiresMonotonicMs: issued + this.leaseExpiryMs, inputTargetGeneration: this.inputTargetGeneration,
        nextInputBatchSequence: 1,
      };
      this.lease = lease;
      this.transition = undefined;
      this.stateValue = "human";
      this.armLeaseTimer(lease);
      this.publish();
      return this.leaseResult(lease);
    } catch (error) {
      await this.recoverFailedTakeover(transition);
      if (error instanceof SessionControlError) throw error;
      throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control could not be transferred safely.", true);
    }
  }

  heartbeat(connectionId: string, leaseId: string): ControlLeaseResult {
    this.assertOpen();
    const lease = this.requireLease(connectionId, leaseId, false);
    const now = this.now();
    if (now >= lease.expiresMonotonicMs) {
      this.expireLease(lease, "lease-expired");
      throw new SessionControlError("CONTROL_LEASE_EXPIRED", "Browser control lease expired.", true);
    }
    lease.lastHeartbeatMonotonicMs = now;
    lease.expiresMonotonicMs = now + this.leaseExpiryMs;
    this.armLeaseTimer(lease);
    this.publish();
    return this.leaseResult(lease);
  }

  authorizeInputLease(proof: ControlLeaseProof): void {
    this.assertOpen();
    const lease = this.requireLease(proof.connectionId, proof.leaseId, true);
    if (proof.browserSessionId !== this.hooks.browserSessionId || proof.tabId !== lease.tabId || proof.controlEpoch !== this.controlEpoch || proof.inputTargetGeneration !== lease.inputTargetGeneration) {
      throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control lease does not match the input target.", false);
    }
  }

  authorizeInput(proof: ControlLeaseProof, batchSequence: number): void {
    this.authorizeInputLease(proof);
    const lease = this.lease as HumanLease;
    if (batchSequence !== lease.nextInputBatchSequence) throw new BrowserProtocolError("INPUT_SEQUENCE_STALE", "Browser input sequence is stale.", false);
  }

  commitInputBatch(proof: ControlLeaseProof, batchSequence: number): number {
    this.authorizeInput(proof, batchSequence);
    const lease = this.lease as HumanLease;
    lease.nextInputBatchSequence = increment(lease.nextInputBatchSequence, "input batch sequence");
    return lease.nextInputBatchSequence;
  }

  async release(request: ReleaseControlRequest): Promise<ControlReleaseResult> {
    this.assertOpen();
    const lease = this.requireLease(request.connectionId, request.leaseId, false, true);
    return await this.returnToAgent(lease, "explicit-return");
  }

  workspaceDisconnected(connectionId: string): void {
    if (this.closed) return;
    const lease = this.lease;
    if (lease === undefined || lease.connectionId !== connectionId || (this.stateValue !== "human" && this.stateValue !== "human-disconnected")) return;
    this.stateValue = "human-disconnected";
    this.hooks.stopHumanInput();
    if (this.leaseTimer !== undefined) { clearTimeout(this.leaseTimer); this.leaseTimer = undefined; }
    this.disconnectedDeadlineMs = this.now() + this.disconnectGraceMs;
    this.armGraceTimer(lease);
    this.publish();
    void this.releaseHeldInputAfterDisconnect(lease);
  }

  async controlledTabClosed(tabId: string): Promise<void> {
    const lease = this.lease;
    if (lease === undefined || lease.tabId !== tabId || (this.stateValue !== "human" && this.stateValue !== "human-disconnected")) return;
    await this.returnToAgent(lease, "controlled-tab-closed");
  }

  close(): void {
    if (this.closed) return;
    const mustFence = this.stateValue !== "agent";
    this.closed = true;
    this.clearTimers();
    this.hooks.stopHumanInput();
    this.lease = undefined;
    this.transition = undefined;
    this.disconnectedDeadlineMs = undefined;
    if (mustFence) {
      try {
        const terminalEpoch = this.advanceEpoch();
        this.hooks.invalidateHumanAuthority(terminalEpoch);
      } catch { /* The terminal browser session remains unavailable. */ }
    }
    this.stateValue = "agent";
    this.publish();
  }

  private async returnToAgent(lease: HumanLease, reason: string): Promise<ControlReleaseResult> {
    if (this.lease !== lease) throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control lease is not current.", false);
    if (this.stateValue === "return-pending") throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control return is pending.", true);
    const transition = this.beginTransition("return", "return-pending");
    this.clearTimers();
    this.hooks.stopHumanInput();
    try {
      await withBudget(this.returnTimeoutMs, async (signal) => {
        await this.hooks.awaitHumanInputSettlement(signal);
        this.assertTransition(transition);
        await this.hooks.releaseHeldInput(signal);
        this.assertTransition(transition);
        if (this.hooks.heldInputCount() !== 0) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Input cleanup did not settle.", true);
      });
      if (this.lease !== lease) throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control lease is not current.", false);
      this.lease = undefined;
      this.disconnectedDeadlineMs = undefined;
      this.inputTargetGeneration = increment(this.inputTargetGeneration, "input target generation");
      const agentEpoch = this.advanceEpoch();
      this.hooks.invalidateHumanAuthority(agentEpoch);
      await withBudget(this.returnTimeoutMs, async (signal) => {
        await this.hooks.establishAgentFrameStream(agentEpoch, signal);
        this.assertTransition(transition);
      });
      this.transition = undefined;
      this.stateValue = "agent";
      this.publish();
      return { controlState: "agent", controlEpoch: agentEpoch };
    } catch (error) {
      this.stateValue = "return-pending";
      this.publish();
      this.hooks.terminalCleanupRequired(reason);
      if (error instanceof SessionControlError) throw error;
      throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control return could not settle safely.", true);
    }
  }

  private async recoverFailedTakeover(transition: TransitionIdentity): Promise<void> {
    if (this.transition !== transition || this.closed) return;
    this.stateValue = "return-pending";
    this.publish();
    this.hooks.stopHumanInput();
    try {
      await withBudget(this.returnTimeoutMs, async (signal) => {
        await this.hooks.awaitHumanInputSettlement(signal);
        await this.hooks.releaseHeldInput(signal);
        if (this.hooks.heldInputCount() !== 0) throw new Error("held input remains");
      });
      this.lease = undefined;
      this.inputTargetGeneration = increment(this.inputTargetGeneration, "input target generation");
      const agentEpoch = this.advanceEpoch();
      this.hooks.invalidateHumanAuthority(agentEpoch);
      await withBudget(this.returnTimeoutMs, async (signal) => await this.hooks.establishAgentFrameStream(agentEpoch, signal));
      if (this.transition !== transition || this.closed) return;
      this.transition = undefined;
      this.stateValue = "agent";
      this.publish();
    } catch {
      this.stateValue = "return-pending";
      this.publish();
      this.hooks.terminalCleanupRequired("takeover-cleanup-failed");
    }
  }

  private async releaseHeldInputAfterDisconnect(lease: HumanLease): Promise<void> {
    try {
      await withBudget(this.returnTimeoutMs, async (signal) => await this.hooks.releaseHeldInput(signal));
    } catch {
      if (this.lease === lease && this.stateValue === "human-disconnected") this.publish();
    }
  }

  private expireLease(lease: HumanLease, reason: string): void {
    if (this.closed || this.lease !== lease || (this.stateValue !== "human" && this.stateValue !== "human-disconnected")) return;
    this.stateValue = "human-disconnected";
    this.hooks.stopHumanInput();
    this.publish();
    void this.returnToAgent(lease, reason).catch(() => undefined);
  }

  private requireLease(connectionId: string, leaseId: string, requireHuman: boolean, allowDisconnected = false): HumanLease {
    const lease = this.lease;
    if (lease === undefined) throw new SessionControlError("CONTROL_LEASE_REQUIRED", "A current browser control lease is required.", false);
    if (lease.connectionId !== connectionId || lease.leaseId !== leaseId) throw new SessionControlError("CONTROL_LEASE_CONFLICT", "Browser control lease is not current.", false);
    if (this.now() >= lease.expiresMonotonicMs) {
      this.expireLease(lease, "lease-expired");
      throw new SessionControlError("CONTROL_LEASE_EXPIRED", "Browser control lease expired.", true);
    }
    if (this.stateValue === "human-disconnected" && !allowDisconnected) throw new SessionControlError("CONTROL_LEASE_EXPIRED", "Browser control connection is no longer active.", true);
    if (requireHuman && this.stateValue !== "human") throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control is not accepting input.", true);
    if (!requireHuman && this.stateValue !== "human" && !(allowDisconnected && this.stateValue === "human-disconnected")) {
      throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control transfer is pending.", true);
    }
    return lease;
  }

  private leaseResult(lease: HumanLease): ControlLeaseResult {
    return {
      leaseId: lease.leaseId,
      controlState: "human",
      controlEpoch: this.controlEpoch,
      selectedTabId: lease.tabId,
      leaseGeneration: lease.generation,
      leaseExpiresInMs: Math.max(0, Math.ceil(lease.expiresMonotonicMs - this.now())),
      inputTargetGeneration: lease.inputTargetGeneration,
      nextInputBatchSequence: lease.nextInputBatchSequence,
    };
  }

  private beginTransition(direction: TransitionIdentity["direction"], state: SessionControlState): TransitionIdentity {
    this.transitionSequence = increment(this.transitionSequence, "control transition");
    const transition = { sequence: this.transitionSequence, direction } as const;
    this.transition = transition;
    this.stateValue = state;
    this.publish();
    return transition;
  }

  private assertTransition(expected: TransitionIdentity): void {
    if (this.closed || this.transition !== expected) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control transition was superseded.", true);
  }

  private advanceEpoch(): number {
    const previous = this.controlEpoch;
    if (!Number.isSafeInteger(previous) || previous < 1 || previous >= MAX_SAFE) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control epoch is unavailable.", false);
    const next = this.hooks.advanceEpoch();
    if (next !== previous + 1 || !Number.isSafeInteger(next)) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control epoch did not advance safely.", false);
    return next;
  }

  private armLeaseTimer(lease: HumanLease): void {
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer);
    const delay = Math.max(0, lease.expiresMonotonicMs - this.now());
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      if (this.lease !== lease) return;
      if (this.now() < lease.expiresMonotonicMs) { this.armLeaseTimer(lease); return; }
      this.expireLease(lease, "lease-expired");
    }, delay);
    this.leaseTimer.unref?.();
  }

  private armGraceTimer(lease: HumanLease): void {
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    const deadline = this.disconnectedDeadlineMs ?? this.now();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (this.lease !== lease || this.stateValue !== "human-disconnected") return;
      if (this.now() < deadline) { this.armGraceTimer(lease); return; }
      void this.returnToAgent(lease, "disconnect-grace-expired").catch(() => undefined);
    }, Math.max(0, deadline - this.now()));
    this.graceTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer);
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.leaseTimer = undefined;
    this.graceTimer = undefined;
  }

  private publish(): void { this.hooks.changed(this.snapshot()); }
  private assertOpen(): void { if (this.closed) throw new SessionControlError("CONTROL_NOT_READY", "Browser control is unavailable.", true); }
}

async function withBudget<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control transfer timed out.", true);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([task(controller.signal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function increment(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE) throw new SessionControlError("CONTROL_TRANSFER_PENDING", `${name} is exhausted.`, false);
  return value + 1;
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} bound is invalid`);
  return value;
}
