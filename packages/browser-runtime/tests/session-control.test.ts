import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { BrowserProtocolError } from "@webx/browser-protocol";
import {
  SessionControlAuthority,
  SessionControlError,
  type SanitizedSessionControl,
  type SessionControlHooks,
} from "../src/control/session-control.js";

interface Harness {
  authority: SessionControlAuthority;
  hooks: SessionControlHooks;
  snapshots: SanitizedSessionControl[];
  terminalReasons: string[];
  setReady(value: boolean): void;
  setHeld(value: number): void;
  failAgentSettlement(value: boolean): void;
  epoch(): number;
}

function harness(options: { leaseExpiryMs?: number; disconnectGraceMs?: number; heartbeatIntervalMs?: number } = {}): Harness {
  let epoch = 1;
  let ready = true;
  let held = 0;
  let failSettlement = false;
  const snapshots: SanitizedSessionControl[] = [];
  const terminalReasons: string[] = [];
  const hooks: SessionControlHooks = {
    browserSessionId: "session:control",
    currentEpoch: () => epoch,
    advanceEpoch: () => ++epoch,
    assertAcquireReady: () => { if (!ready) throw new SessionControlError("CONTROL_NOT_READY", "Browser view is preparing.", true); },
    invalidateAgentAuthority: () => undefined,
    awaitAgentSettlement: async () => { if (failSettlement) throw new Error("not settled"); },
    stopHumanInput: () => undefined,
    awaitHumanInputSettlement: async () => undefined,
    releaseHeldInput: async () => { held = 0; },
    heldInputCount: () => held,
    establishHumanFrameStream: async () => undefined,
    invalidateHumanAuthority: () => undefined,
    establishAgentFrameStream: async () => undefined,
    changed: (state) => snapshots.push(state),
    terminalCleanupRequired: (reason) => terminalReasons.push(reason),
  };
  const authority = new SessionControlAuthority(hooks, {
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 250,
    leaseExpiryMs: options.leaseExpiryMs ?? 500,
    disconnectGraceMs: options.disconnectGraceMs ?? 250,
    takeoverTimeoutMs: 500,
    returnTimeoutMs: 500,
    randomLeaseId: () => "lease_control_0001",
  });
  return {
    authority, hooks, snapshots, terminalReasons,
    setReady: (value) => { ready = value; },
    setHeld: (value) => { held = value; },
    failAgentSettlement: (value) => { failSettlement = value; },
    epoch: () => epoch,
  };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof BrowserProtocolError && error.code === expected;
}

function acquire(connectionId: string, expectedControlEpoch: number) {
  return { connectionId, subscriptionId: "subscription_control_0001", tabId: "tab:one", expectedControlEpoch };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); });

describe("browserd session control authority", () => {
  it("performs monotonic explicit takeover and return without exposing authority in snapshots", async () => {
    const item = harness();
    const lease = await item.authority.acquire(acquire("workspace-secret-connection", 1));
    assert.equal(item.authority.state, "human");
    assert.equal(lease.controlEpoch, 2);
    assert.equal(lease.inputTargetGeneration, 1);
    assert.equal(lease.nextInputBatchSequence, 1);
    const snapshot = item.authority.snapshot();
    assert.deepEqual(snapshot, { controlState: "human", controlEpoch: 2, controlTransfer: "none", selectedHumanControlTabId: "tab:one", leaseExpiry: "expiring" });
    assert.equal(JSON.stringify(snapshot).includes(lease.leaseId), false);
    assert.equal(JSON.stringify(snapshot).includes("workspace-secret-connection"), false);

    const proof = { connectionId: "workspace-secret-connection", leaseId: lease.leaseId, browserSessionId: "session:control", tabId: "tab:one", controlEpoch: 2, inputTargetGeneration: 1 };
    item.authority.authorizeInput(proof, 1);
    assert.equal(item.authority.commitInputBatch(proof, 1), 2);
    assert.throws(() => item.authority.authorizeInput(proof, 1), code("INPUT_SEQUENCE_STALE"));

    const returned = await item.authority.release({ connectionId: proof.connectionId, leaseId: proof.leaseId });
    assert.deepEqual(returned, { controlState: "agent", controlEpoch: 3 });
    assert.equal(item.authority.state, "agent");
    assert.throws(() => item.authority.authorizeInput({ ...proof, controlEpoch: 3 }, 2), code("CONTROL_LEASE_REQUIRED"));
    assert.equal(item.epoch(), 3);
  });

  it("rejects stale epochs, unready targets, and takeover races before granting a lease", async () => {
    const item = harness();
    await assert.rejects(item.authority.acquire(acquire("connection:a", 2)), code("CONTROL_LEASE_CONFLICT"));
    item.setReady(false);
    await assert.rejects(item.authority.acquire(acquire("connection:a", 1)), code("CONTROL_NOT_READY"));
    item.setReady(true);
    const lease = await item.authority.acquire(acquire("connection:a", 1));
    await assert.rejects(item.authority.acquire(acquire("connection:b", 2)), code("CONTROL_LEASE_CONFLICT"));
    assert.throws(() => item.authority.heartbeat("connection:b", lease.leaseId), code("CONTROL_LEASE_CONFLICT"));
    await item.authority.release({ connectionId: "connection:a", leaseId: lease.leaseId });
  });

  it("fences a failed takeover again before restoring agent authority", async () => {
    const item = harness();
    item.failAgentSettlement(true);
    await assert.rejects(item.authority.acquire(acquire("connection:a", 1)), code("CONTROL_TRANSFER_PENDING"));
    assert.equal(item.authority.state, "agent");
    assert.equal(item.epoch(), 3, "failed E2 takeover must restore agent only at E3");
    assert.deepEqual(item.terminalReasons, []);
  });

  it("enters disconnected grace, rejects input, and returns automatically without lease reclaim", async () => {
    vi.useFakeTimers();
    const item = harness({ leaseExpiryMs: 1_000, disconnectGraceMs: 250, heartbeatIntervalMs: 250 });
    const lease = await item.authority.acquire(acquire("connection:a", 1));
    item.setHeld(1);
    item.authority.workspaceDisconnected("connection:a");
    assert.equal(item.authority.state, "human-disconnected");
    assert.equal(item.authority.snapshot().leaseExpiry, "grace");
    assert.throws(() => item.authority.authorizeInput({ connectionId: "connection:a", leaseId: lease.leaseId, browserSessionId: "session:control", tabId: "tab:one", controlEpoch: 2, inputTargetGeneration: 1 }, 1), code("CONTROL_LEASE_EXPIRED"));
    assert.throws(() => item.authority.heartbeat("connection:new", lease.leaseId), code("CONTROL_LEASE_CONFLICT"));

    await vi.advanceTimersByTimeAsync(251);
    await flush();
    assert.equal(item.authority.state, "agent");
    assert.equal(item.epoch(), 3);
    assert.equal(item.terminalReasons.length, 0);
  });

  it("expires a silent live lease and returns with a new epoch", async () => {
    vi.useFakeTimers();
    const item = harness({ leaseExpiryMs: 500, disconnectGraceMs: 500, heartbeatIntervalMs: 250 });
    await item.authority.acquire(acquire("connection:a", 1));
    await vi.advanceTimersByTimeAsync(501);
    await flush();
    assert.equal(item.authority.state, "agent");
    assert.equal(item.epoch(), 3);
  });

  it("keeps both controllers blocked and requests terminal cleanup when held input cannot settle", async () => {
    let epoch = 1;
    let held = 1;
    const terminal: string[] = [];
    const hooks: SessionControlHooks = {
      browserSessionId: "session:control",
      currentEpoch: () => epoch,
      advanceEpoch: () => ++epoch,
      assertAcquireReady: () => undefined,
      invalidateAgentAuthority: () => undefined,
      awaitAgentSettlement: async () => undefined,
      stopHumanInput: () => undefined,
      awaitHumanInputSettlement: async () => undefined,
      releaseHeldInput: async () => { /* Deliberately ambiguous. */ },
      heldInputCount: () => held,
      establishHumanFrameStream: async () => undefined,
      invalidateHumanAuthority: () => undefined,
      establishAgentFrameStream: async () => undefined,
      changed: () => undefined,
      terminalCleanupRequired: (reason) => terminal.push(reason),
    };
    const authority = new SessionControlAuthority(hooks, { heartbeatIntervalMs: 250, leaseExpiryMs: 500, disconnectGraceMs: 250, takeoverTimeoutMs: 500, returnTimeoutMs: 500, randomLeaseId: () => "lease_control_0001" });
    await assert.rejects(authority.acquire(acquire("connection:a", 1)), code("CONTROL_TRANSFER_PENDING"));
    assert.equal(authority.state, "return-pending");
    assert.throws(() => authority.assertAgentAdmission(), code("CONTROL_TRANSFER_PENDING"));
    assert.deepEqual(terminal, ["takeover-cleanup-failed"]);
    held = 0;
    authority.close();
  });
});
