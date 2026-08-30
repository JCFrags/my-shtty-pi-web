import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { SessionCaptureCoordinator } from "../src/capture/coordinator.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 500; index++) { if (predicate()) return; await sleep(1); } throw new Error("fixture timeout"); }
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

function cancelled(error: unknown): boolean { return error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED"; }

describe("session capture coordinator", () => {
  it("serializes complete transactions within one session", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const transaction = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      try { await gate.promise; } finally { active--; }
    };
    const first = coordinator.runAgent("tab-a", undefined, transaction);
    const second = coordinator.runFrame("tab-a", undefined, transaction);
    await waitFor(() => active === 1 && coordinator.diagnostics.frameQueued === 1);
    assert.equal(peak, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(peak, 1);
    assert.equal(coordinator.diagnostics.maxObservedConcurrent, 1);
  });

  it("allows different sessions to capture concurrently", async () => {
    const first = new SessionCaptureCoordinator();
    const second = new SessionCaptureCoordinator();
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const transaction = async (): Promise<void> => { active++; peak = Math.max(peak, active); try { await gate.promise; } finally { active--; } };
    const a = first.runAgent("tab-a", undefined, transaction);
    const b = second.runFrame("tab-b", undefined, transaction);
    await waitFor(() => active === 2);
    assert.equal(peak, 2);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it("bounds the agent queue at eight", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    const active = coordinator.runFrame("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    const queued = Array.from({ length: 8 }, (_, index) => coordinator.runAgent(`agent-${index}`, undefined, async () => undefined));
    assert.equal(coordinator.diagnostics.agentQueued, 8);
    await assert.rejects(() => coordinator.runAgent("overflow", undefined, async () => undefined), (error) => error instanceof BrowserProtocolError && error.code === "LIMIT_EXCEEDED");
    assert.equal(coordinator.diagnostics.rejectedAgent, 1);
    gate.resolve();
    await active;
    await Promise.all(queued);
  });

  it("keeps agent FIFO priority while serving a queued frame after a bounded burst", async () => {
    const coordinator = new SessionCaptureCoordinator({ maxConsecutiveAgents: 2 });
    const gate = deferred();
    const order: string[] = [];
    const active = coordinator.runFrame("active", undefined, async () => { order.push("active"); await gate.promise; });
    await waitFor(() => coordinator.diagnostics.active === 1);
    const frame = coordinator.runFrame("queued-frame", undefined, async () => { order.push("frame"); });
    const agents = ["agent-a", "agent-b", "agent-c"].map((name) => coordinator.runAgent(name, undefined, async () => { order.push(name); }));
    gate.resolve();
    await Promise.all([active, frame, ...agents]);
    assert.deepEqual(order, ["active", "agent-a", "agent-b", "frame", "agent-c"]);
  });

  it("coalesces a queued frame per tab by replacing the older intent", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    const active = coordinator.runAgent("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    let olderRan = false;
    let newerRan = false;
    const older = coordinator.runFrame("tab-a", undefined, async () => { olderRan = true; });
    const newer = coordinator.runFrame("tab-a", undefined, async () => { newerRan = true; });
    await assert.rejects(() => older, cancelled);
    assert.equal(coordinator.diagnostics.frameQueued, 1);
    assert.equal(coordinator.diagnostics.coalescedFrame, 1);
    gate.resolve();
    await active;
    await newer;
    assert.equal(olderRan, false);
    assert.equal(newerRan, true);
  });

  it("bounds queued frame intents to the browser tab limit", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    const active = coordinator.runAgent("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    const frames = Array.from({ length: 8 }, (_, index) => coordinator.runFrame(`tab-${index}`, undefined, async () => undefined));
    await assert.rejects(() => coordinator.runFrame("tab-overflow", undefined, async () => undefined), (error) => error instanceof BrowserProtocolError && error.code === "LIMIT_EXCEEDED");
    assert.equal(coordinator.diagnostics.frameQueued, 8);
    gate.resolve();
    await active;
    await Promise.all(frames);
  });

  it("removes a cancelled queued request before it can execute", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    const active = coordinator.runFrame("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    const controller = new AbortController();
    let ran = false;
    const queued = coordinator.runAgent("queued", controller.signal, async () => { ran = true; });
    controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    await assert.rejects(() => queued, cancelled);
    assert.equal(coordinator.diagnostics.agentQueued, 0);
    gate.resolve();
    await active;
    assert.equal(ran, false);
  });

  it("cancels one tab without disturbing other queued tabs", async () => {
    const coordinator = new SessionCaptureCoordinator();
    const gate = deferred();
    const active = coordinator.runAgent("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    const cancelledAgent = coordinator.runAgent("cancelled-tab", undefined, async () => undefined);
    const cancelledFrame = coordinator.runFrame("cancelled-tab", undefined, async () => undefined);
    let survivorRan = false;
    const survivor = coordinator.runAgent("survivor", undefined, async () => { survivorRan = true; });
    coordinator.cancelTab("cancelled-tab");
    await assert.rejects(() => cancelledAgent, cancelled);
    await assert.rejects(() => cancelledFrame, cancelled);
    gate.resolve();
    await active;
    await survivor;
    assert.equal(survivorRan, true);
  });

  it("aborts active and queued transactions and settles before close returns", async () => {
    const coordinator = new SessionCaptureCoordinator();
    let activeAborted = false;
    const active = coordinator.runAgent("active", undefined, async (signal) => await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { activeAborted = true; reject(signal.reason); }, { once: true })));
    await waitFor(() => coordinator.diagnostics.active === 1);
    const queued = coordinator.runFrame("queued", undefined, async () => undefined);
    const closes = [coordinator.close(), coordinator.close()];
    await assert.rejects(() => active, cancelled);
    await assert.rejects(() => queued, cancelled);
    await Promise.all(closes);
    assert.equal(activeAborted, true);
    assert.equal(coordinator.diagnostics.active, 0);
    assert.equal(coordinator.diagnostics.agentQueued, 0);
    assert.equal(coordinator.diagnostics.frameQueued, 0);
    assert.equal(coordinator.diagnostics.closed, true);
  });

  it("reports bounded wait and timeout diagnostics without payload data", async () => {
    let now = 100;
    const coordinator = new SessionCaptureCoordinator({ monotonicNow: () => now });
    const gate = deferred();
    const active = coordinator.runFrame("active", undefined, async () => await gate.promise);
    await waitFor(() => coordinator.diagnostics.active === 1);
    const agent = coordinator.runAgent("agent", undefined, async () => undefined);
    now = 145;
    coordinator.recordAgentScreenshotTimeout();
    coordinator.recordRecoveredAgentScreenshotTimeout();
    coordinator.recordFrameScreenshotTimeout();
    gate.resolve();
    await Promise.all([active, agent]);
    const diagnostics = coordinator.diagnostics;
    assert.equal(diagnostics.agentWaitMaxMs, 45);
    assert.equal(diagnostics.agentScreenshotTimeouts, 1);
    assert.equal(diagnostics.recoveredAgentScreenshotTimeouts, 1);
    assert.equal(diagnostics.frameScreenshotTimeouts, 1);
    assert.equal(JSON.stringify(diagnostics).includes("data"), false);
  });
});
