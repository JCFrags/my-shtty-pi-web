import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type BrowserRequest, type FrameEvent } from "@webx/browser-protocol";
import { BrowserRuntime } from "../src/registry/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.allSettled(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });
async function profileRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "gate0-runtime-")); roots.push(root); return root; }
const actor = { principalId: "owner:gate0", agentSessionId: "agent:gate0" } as const;
const deadline = (): string => new Date(Date.now() + 10_000).toISOString();
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fakeSession(close: () => Promise<void> = async () => undefined) {
  return { actor, close, offFrame: () => undefined, frames: { removeConsumer: () => undefined }, observations: { hasUsable: () => true }, dom: { hasUsable: () => true } };
}
function fakeWorkspaceSession(browserSessionId: string, tabId: string, latest?: FrameEvent) {
  const address = { browserSessionId, tabId, targetId: `target_${tabId}_123456789`, controlEpoch: 1 };
  const consumers = new Set<string>();
  let failSubscribe = false;
  let deferredSubscribeCount = 0;
  return {
    actor,
    address,
    consumers,
    get deferredSubscribeCount() { return deferredSubscribeCount; },
    set failSubscribe(value: boolean) { failSubscribe = value; },
    descriptor: () => ({ kind: "session", browserSessionId, controlEpoch: 1, state: "ready", personaId: "persona_1234567890123456", cursor: { x: 0, y: 0, visible: true, pathSequence: 0, sampleSequence: 0, personaId: "persona_1234567890123456" }, tabs: [{ kind: "tab", address, documentGeneration: 1, viewportGeneration: 1, state: "ready", url: "about:blank", title: "", frameSequence: latest?.frameSequence ?? 0 }] }),
    subscribeFrames: (key: string, _address: unknown, _interest: unknown, deferInitialCapture = false) => { if (failSubscribe) throw new BrowserProtocolError("CDP_DISCONNECTED", "injected subscribe failure", true); if (deferInitialCapture) deferredSubscribeCount++; consumers.add(key); },
    invalidateFrameConsumer: (key: string) => { consumers.delete(key); },
    settleFrameConsumerRemoval: async (key: string) => { consumers.delete(key); },
    latestValidWorkspaceFrame: () => latest,
    close: async () => undefined,
    offFrame: () => undefined,
    frames: { removeConsumer: (key: string) => consumers.delete(key) },
    observations: { hasUsable: () => true },
    dom: { hasUsable: () => true },
  };
}
function workspaceFrame(browserSessionId: string, tabId: string, sequence = 7): FrameEvent {
  return { protocolVersion: "browser.v2", kind: "frame.available", address: { browserSessionId, tabId, targetId: `target_${tabId}_123456789`, controlEpoch: 1 }, documentGeneration: 1, viewportGeneration: 1, frameSequence: sequence, capturedMonotonicMs: performance.now(), publishedMonotonicMs: performance.now(), mediaType: "image/png", byteLength: 3, artifactId: "artifact_1234567890123456", sha256: "a".repeat(64), viewport: { width: 1, height: 1, devicePixelRatio: 1 }, url: "about:blank", title: "", cursor: { x: 0, y: 0, visible: true, pathSequence: 0, sampleSequence: 0, personaId: "persona_1234567890123456" } };
}

describe("Gate 0 runtime bounds, health, and retryable cleanup", () => {
  it("reports truthful executable, display, egress, runtime, and global capacity health", async () => {
    const priorDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":gate0";
    try {
      const runtime = new BrowserRuntime({ chrome: { executable: "/bin/true", profileRoot: await profileRoot() }, egressConfigured: false, maxSessionsGlobal: 1 });
      const request = { protocolVersion: PROTOCOL_VERSION, kind: "capabilities.get", requestId: "request:health", operationId: "operation:health", deadline: deadline() } as BrowserRequest;
      const first = await runtime.dispatch(actor, request) as Record<string, unknown>;
      assert.equal(first.executableAvailable, true);
      assert.equal(first.displayAvailable, true);
      assert.equal(first.profileRootUsable, true);
      assert.equal(first.egressConfigured, false);
      assert.equal(first.available, false);
      const internal = runtime as unknown as { sessions: Map<string, unknown> };
      internal.sessions.set("session:capacity", fakeSession());
      const second = await runtime.dispatch(actor, { ...request, requestId: "request:capacity" }) as { sessionCapacity: { current: number; available: number } };
      assert.deepEqual(second.sessionCapacity, { current: 1, limit: 1, available: 0 });
      await runtime.close();
    } finally {
      if (priorDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = priorDisplay;
    }
  });

  it("rolls back runtime subscription insertion when scheduler subscription fails", async () => {
    const runtime = new BrowserRuntime({ chrome: { profileRoot: await profileRoot() } });
    const internal = runtime as unknown as { sessions: Map<string, unknown> };
    const address = { browserSessionId: "session:subscription", tabId: "tab:subscription", targetId: "target:subscription", controlEpoch: 1 };
    internal.sessions.set(address.browserSessionId, {
      ...fakeSession(),
      subscribeFrames: () => { throw new BrowserProtocolError("TAB_NOT_FOUND", "Tab not found."); },
    });
    const request = { protocolVersion: PROTOCOL_VERSION, kind: "frames.subscribe", requestId: "request:subscription", operationId: "operation:subscription", deadline: deadline(), address, subscriptionId: "subscription_gate0", interest: "selected" } as BrowserRequest;
    await assert.rejects(() => runtime.dispatch(actor, request, undefined, "connection:gate0"), (error) => error instanceof BrowserProtocolError && error.code === "TAB_NOT_FOUND");
    assert.equal(runtime.subscriptionCount, 0);
    await runtime.close();
  });

  it("atomically replaces 200 workspace selections, preserves the former selection on failure, and prunes its ledger", async () => {
    const runtime = new BrowserRuntime({ chrome: { profileRoot: await profileRoot() } });
    const internal = runtime as unknown as { sessions: Map<string, unknown> };
    const frameA = workspaceFrame("session:a", "tab:a", 11);
    const frameB = workspaceFrame("session:b", "tab:b", 17);
    const sessionA = fakeWorkspaceSession("session:a", "tab:a", frameA);
    const sessionB = fakeWorkspaceSession("session:b", "tab:b", frameB);
    internal.sessions.set("session:a", sessionA);
    internal.sessions.set("session:b", sessionB);
    const connectionId = "workspace:gate0";
    let current = { subscriptionId: "subscription_gate0_0000", browserSessionId: "session:a", tabId: "tab:a" };
    runtime.workspaceSubscribeFrames(connectionId, current.subscriptionId, current.browserSessionId, current.tabId, "selected");
    runtime.recordWorkspaceFrameDelivered(connectionId, current.subscriptionId, frameA);
    assert.equal(runtime.workspaceSubscriptionCount, 1);
    assert.equal(runtime.workspaceLedgerCount, 1);
    assert.throws(() => runtime.workspaceReplaceFrames(connectionId, { subscriptionId: "subscription_gate0_stale", browserSessionId: "session:a", tabId: "tab:a" }, { ...current, interest: "selected" }), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    assert.equal(runtime.workspaceSubscriptionCount, 1);
    assert.equal(runtime.workspaceLedgerCount, 1);

    sessionB.failSubscribe = true;
    assert.throws(() => runtime.workspaceReplaceFrames(connectionId, current, { subscriptionId: "subscription_gate0_fail", browserSessionId: "session:b", tabId: "tab:b", interest: "selected" }), (error) => error instanceof BrowserProtocolError && error.code === "CDP_DISCONNECTED");
    assert.equal(runtime.workspaceSubscriptionCount, 1);
    assert.equal(runtime.workspaceLedgerCount, 1);
    assert.equal(runtime.workspaceFrameDeliveries(connectionId, frameA)[0]?.subscriptionId, current.subscriptionId);
    sessionB.failSubscribe = false;

    for (let index = 1; index <= 200; index++) {
      const toB = index % 2 === 1;
      const next = { subscriptionId: `subscription_gate0_${String(index).padStart(4, "0")}`, browserSessionId: toB ? "session:b" : "session:a", tabId: toB ? "tab:b" : "tab:a", interest: "selected" as const };
      const cached = runtime.workspaceReplaceFrames(connectionId, current, next);
      assert.equal(cached?.frameSequence, toB ? 17 : 11);
      assert.equal(cached?.sha256, "a".repeat(64));
      assert.equal(runtime.workspaceSubscriptionCount, 1);
      assert.equal(runtime.workspaceLedgerCount, 0);
      assert.equal(runtime.workspaceFrameDeliveries(connectionId, toB ? frameA : frameB).length, 0);
      assert.deepEqual(runtime.workspaceFrameDeliveries(connectionId, toB ? frameB : frameA).map((item) => item.subscriptionId), [next.subscriptionId]);
      current = next;
    }
    assert.equal(sessionA.consumers.size + sessionB.consumers.size, 1);
    assert.equal(sessionA.deferredSubscribeCount + sessionB.deferredSubscribeCount, 200, "cached handoffs must defer redundant immediate captures");
    await runtime.close();
  });

  it("shares concurrent runtime close and retries residual session cleanup after failure", async () => {
    const runtime = new BrowserRuntime({ chrome: { profileRoot: await profileRoot() } });
    const internal = runtime as unknown as { sessions: Map<string, unknown> };
    let calls = 0;
    internal.sessions.set("session:retry", fakeSession(async () => { calls++; if (calls === 1) throw new Error("injected session cleanup failure"); }));
    await assert.rejects(() => runtime.close(), /runtime cleanup failed/i);
    assert.equal(calls, 1);
    await runtime.close();
    assert.equal(calls, 2);

    const concurrent = new BrowserRuntime({ chrome: { profileRoot: await profileRoot() } });
    const concurrentInternal = concurrent as unknown as { sessions: Map<string, unknown> };
    const gate = deferred();
    let concurrentCalls = 0;
    concurrentInternal.sessions.set("session:concurrent", fakeSession(async () => { concurrentCalls++; await gate.promise; }));
    const first = concurrent.close();
    const second = concurrent.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(concurrentCalls, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(concurrentCalls, 1);
  });
});
