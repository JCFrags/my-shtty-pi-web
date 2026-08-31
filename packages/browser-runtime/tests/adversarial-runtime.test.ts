import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { bindMotorTab, SessionMotor } from "../src/motor/session-motor.js";
import { canonicalOperationFingerprint, OperationRegistry } from "../src/operations/registry.js";
import type { TabRecord } from "../src/targets/registry.js";

const actor = { principalId: "owner:adversarial", agentSessionId: "agent:adversarial" } as const;
const other = { principalId: "owner:other", agentSessionId: "agent:other" } as const;
const deadline = (): string => new Date(Date.now() + 5_000).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Sent = { method: string; params: Readonly<Record<string, unknown>> };
function motorFixture(handler?: (event: Sent, signal?: AbortSignal) => Promise<unknown>) {
  const tab: TabRecord = {
    browserSessionId: "session:motor-adversarial", tabId: "tab:motor-adversarial", targetId: "target:motor-adversarial", cdpSessionId: "cdp:motor-adversarial",
    documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: "about:blank", title: "",
  };
  const sent: Sent[] = [];
  bindMotorTab(tab, {
    connected: true,
    async send<T>(method: string, params: Readonly<Record<string, unknown>>, _sessionId: string, options?: { signal?: AbortSignal }): Promise<T> {
      const event = { method, params };
      sent.push(event);
      if (handler !== undefined) return await handler(event, options?.signal) as T;
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      return {} as T;
    },
  });
  return { tab, sent };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await sleep(2); }
  throw new Error("Timed out waiting for deterministic fixture state.");
}

describe("pressed input cleanup", () => {
  it("releases a click cancelled during dwell after mousePressed", async () => {
    const fixture = motorFixture();
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 1);
    registry.submit(actor, { operationId: "click-dwell", laneKey: "motor", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "click", at: { x: 81, y: 81 }, button: "left" }, context, async () => undefined);
    });
    await waitFor(() => fixture.sent.some((event) => event.params.type === "mousePressed"));
    registry.cancel(actor, "click-dwell");
    await waitFor(() => fixture.sent.some((event) => event.params.type === "mouseReleased"));
    assert.equal((await registry.wait(actor, "click-dwell")).dispatchState, "dispatched");
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("releases the first press before cancellation between double-click presses", async () => {
    const fixture = motorFixture();
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 2);
    registry.submit(actor, { operationId: "double-between", laneKey: "motor", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "doubleClick", at: { x: 81, y: 81 }, button: "left" }, context, async () => undefined);
    });
    await waitFor(() => fixture.sent.filter((event) => event.params.type === "mouseReleased").length === 1);
    registry.cancel(actor, "double-between");
    await registry.wait(actor, "double-between");
    assert.equal(fixture.sent.filter((event) => event.params.type === "mousePressed").length, 1);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("attempts cleanup after an ambiguous mousePressed failure", async () => {
    const fixture = motorFixture(async (event) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "mousePressed") throw new BrowserProtocolError("CDP_ERROR", "command timed out", true);
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 3);
    registry.submit(actor, { operationId: "press-timeout", laneKey: "motor", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "click", at: { x: 81, y: 81 }, button: "left" }, context, async () => undefined);
    });
    assert.equal((await registry.wait(actor, "press-timeout")).error?.code, "CDP_ERROR");
    assert.ok(fixture.sent.some((event) => event.params.type === "mouseReleased"));
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("uses an independent cleanup signal after keyDown cancellation", async () => {
    let operationSignal: AbortSignal | undefined;
    const fixture = motorFixture(async (event, signal) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "keyDown") {
        operationSignal = signal;
        return await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (event.params.type === "keyUp") assert.notEqual(signal, operationSignal);
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 4);
    registry.submit(actor, { operationId: "key-cancel", laneKey: "motor", deadline: deadline() }, async (context) => { await motor.pressKey(fixture.tab, "a", context); });
    await waitFor(() => fixture.sent.some((event) => event.params.type === "keyDown"));
    registry.cancel(actor, "key-cancel");
    await waitFor(() => fixture.sent.some((event) => event.params.type === "keyUp"));
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("retains ambiguous held key state after keyUp failure and clears it after retry", async () => {
    let failKeyUp = true;
    const fixture = motorFixture(async (event) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "keyUp" && failKeyUp) throw new BrowserProtocolError("CDP_ERROR", "keyUp failed");
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 5);
    registry.submit(actor, { operationId: "key-up-fail", laneKey: "motor", deadline: deadline() }, async (context) => { await motor.pressKey(fixture.tab, "a", context); });
    assert.equal((await registry.wait(actor, "key-up-fail")).state, "failed");
    assert.deepEqual(motor.heldInputState.keys, ["KeyA"]);
    failKeyUp = false;
    await motor.releaseAll(fixture.tab);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("clears tracked input after the active target becomes terminal", async () => {
    let failRelease = true;
    const fixture = motorFixture(async (event) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "mouseReleased" && failRelease) throw new BrowserProtocolError("CDP_ERROR", "release failed");
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 7);
    registry.submit(actor, { operationId: "terminal-held", laneKey: "motor", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "click", at: { x: 81, y: 81 }, button: "left" }, context, async () => undefined);
    });
    assert.equal((await registry.wait(actor, "terminal-held")).state, "failed");
    assert.deepEqual(motor.heldInputState.buttons, ["left"]);
    fixture.tab.state = "closed";
    failRelease = false;
    await motor.releaseAll(fixture.tab);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("does not dispatch wheel after cancellation or deadline while the post-path guard is blocked", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const fixture = motorFixture();
      const registry = new OperationRegistry();
      const motor = new SessionMotor("session:motor-adversarial", mode === "cancel" ? 8 : 9);
      let guardEntered = false;
      let releaseGuard!: () => void;
      const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
      registry.submit(actor, { operationId: `wheel-${mode}`, laneKey: `wheel-${mode}`, deadline: new Date(Date.now() + (mode === "cancel" ? 5_000 : 500)).toISOString() }, async (context) => {
        await motor.coordinate(fixture.tab, { kind: "wheel", at: { x: 81, y: 81 }, deltaX: 0, deltaY: 100 }, context, async () => { guardEntered = true; await guard; });
      });
      await waitFor(() => guardEntered);
      if (mode === "cancel") registry.cancel(actor, `wheel-${mode}`);
      else await waitFor(() => registry.status(actor, `wheel-${mode}`).state === "expired");
      releaseGuard();
      const status = await registry.wait(actor, `wheel-${mode}`);
      assert.equal(status.dispatchState, "partially-dispatched");
      assert.equal(fixture.sent.some((event) => event.params.type === "mouseWheel"), false);
    }
  });

  it("checks cancellation again after the post-path guard resolves and before wheel send", async () => {
    const fixture = motorFixture();
    const motor = new SessionMotor("session:motor-adversarial", 10);
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      deadlineMonotonicMs: performance.now() + 1_000,
      markPartiallyDispatched() {}, markDispatched() {},
      checkpoint() { controller.signal.throwIfAborted(); },
    };
    await assert.rejects(() => motor.coordinate(fixture.tab, { kind: "wheel", at: { x: 81, y: 81 }, deltaX: 0, deltaY: 100 }, context, async () => { controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled")); }));
    assert.equal(fixture.sent.some((event) => event.params.type === "mouseWheel"), false);
  });

  it("fails a drag when release fails, retains held state, and performs one bounded retry", async () => {
    let releases = 0;
    const fixture = motorFixture(async (event) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "mouseReleased") { releases++; throw new BrowserProtocolError("CDP_ERROR", "release failed"); }
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 11);
    registry.submit(actor, { operationId: "drag-release-fail", laneKey: "drag-release-fail", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "drag", from: { x: 80, y: 80 }, to: { x: 82, y: 82 } }, context, async () => undefined);
    });
    const status = await registry.wait(actor, "drag-release-fail");
    assert.equal(status.state, "failed");
    assert.equal(status.error?.code, "CDP_ERROR");
    assert.equal(status.dispatchState, "dispatched");
    assert.equal(releases, 2);
    assert.deepEqual(motor.heldInputState.buttons, ["left"]);
  });

  it("still fails the drag truthfully when the bounded release retry succeeds", async () => {
    let releases = 0;
    const fixture = motorFixture(async (event) => {
      if (event.method === "Runtime.evaluate") return { result: { value: true } };
      if (event.params.type === "mouseReleased" && ++releases === 1) throw new BrowserProtocolError("CDP_ERROR", "first release failed");
      return {};
    });
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 12);
    registry.submit(actor, { operationId: "drag-release-retry", laneKey: "drag-release-retry", deadline: deadline() }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "drag", from: { x: 80, y: 80 }, to: { x: 82, y: 82 } }, context, async () => undefined);
    });
    const status = await registry.wait(actor, "drag-release-retry");
    assert.equal(status.state, "failed");
    assert.equal(status.error?.code, "CDP_ERROR");
    assert.equal(releases, 2);
    assert.deepEqual(motor.heldInputState.buttons, []);
  });

  it("routes epoch cancellation through mouse release", async () => {
    const fixture = motorFixture();
    const registry = new OperationRegistry();
    const motor = new SessionMotor("session:motor-adversarial", 6);
    registry.submit(actor, { operationId: "epoch-held", laneKey: "motor", deadline: deadline(), browserSessionId: fixture.tab.browserSessionId, tabId: fixture.tab.tabId, controlEpoch: 1 }, async (context) => {
      await motor.coordinate(fixture.tab, { kind: "click", at: { x: 81, y: 81 }, button: "left" }, context, async () => undefined);
    });
    await waitFor(() => fixture.sent.some((event) => event.params.type === "mousePressed"));
    registry.incrementEpoch(actor, fixture.tab.browserSessionId);
    await waitFor(() => fixture.sent.some((event) => event.params.type === "mouseReleased"));
    assert.equal((await registry.wait(actor, "epoch-held")).error?.code, "CONTROL_EPOCH_STALE");
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });
});

describe("operation semantic fingerprints", () => {
  it("is stable across object insertion order", () => {
    assert.equal(canonicalOperationFingerprint({ z: 1, a: { y: 2, x: 3 } }), canonicalOperationFingerprint({ a: { x: 3, y: 2 }, z: 1 }));
  });

  it("deduplicates queued, running, success, and failure without a second side effect", async () => {
    const registry = new OperationRegistry();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const options = { operationId: "same", fingerprint: canonicalOperationFingerprint({ kind: "action.coordinate", at: { x: 1, y: 2 } }), laneKey: "lane", deadline: deadline() };
    registry.submit(actor, options, async () => { executions++; await gate; return "ok"; });
    registry.submit(actor, options, async () => { executions++; return "wrong"; });
    await waitFor(() => registry.status(actor, "same").state === "running");
    registry.submit(actor, options, async () => { executions++; return "wrong"; });
    release();
    assert.equal((await registry.wait(actor, "same")).state, "committed");
    registry.submit(actor, options, async () => { executions++; return "wrong"; });
    assert.equal(executions, 1);

    const failed = { operationId: "failed", fingerprint: "failed-fingerprint", laneKey: "failed", deadline: deadline() };
    registry.submit(actor, failed, async () => { executions++; throw new BrowserProtocolError("NAVIGATION_DENIED", "denied"); });
    assert.equal((await registry.wait(actor, "failed")).error?.code, "NAVIGATION_DENIED");
    registry.submit(actor, failed, async () => { executions++; return "wrong"; });
    assert.equal(executions, 2);
  });

  it("rejects changed action, coordinate, tab, and session semantics", () => {
    const registry = new OperationRegistry();
    const base = { operationId: "conflict", fingerprint: canonicalOperationFingerprint({ kind: "action.coordinate", tabId: "tab:a", at: { x: 1, y: 2 } }), laneKey: "lane", deadline: deadline() };
    registry.submit(actor, base, async () => undefined);
    for (const semantic of [
      { kind: "action.type", tabId: "tab:a", text: "x" },
      { kind: "action.coordinate", tabId: "tab:a", at: { x: 2, y: 2 } },
      { kind: "action.coordinate", tabId: "tab:b", at: { x: 1, y: 2 } },
      { kind: "session.create" },
    ]) {
      assert.throws(() => registry.submit(actor, { ...base, fingerprint: canonicalOperationFingerprint(semantic) }, async () => undefined), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    }
    assert.throws(() => registry.status(other, "conflict"), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_NOT_FOUND");
  });
});
