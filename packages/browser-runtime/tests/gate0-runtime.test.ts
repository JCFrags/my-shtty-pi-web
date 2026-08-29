import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type BrowserRequest } from "@webx/browser-protocol";
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
