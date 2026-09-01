import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserProtocolError, type WorkspaceBrokerRequest } from "@webx/browser-protocol";
import { HumanInputController } from "../src/control/human-input.js";
import { bindMotorTab, SessionMotor, type DirectHumanInputEvent } from "../src/motor/session-motor.js";
import type { TabRecord } from "../src/targets/registry.js";

function target(): TabRecord {
  return {
    browserSessionId: "session:human-input", tabId: "tab:human-input", targetId: "target:human-input", cdpSessionId: "cdp:human-input",
    documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: "about:blank", title: "",
  };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof BrowserProtocolError && error.code === expected;
}

describe("shared direct human input lane", () => {
  it("coalesces only adjacent pointer samples and preserves transition order without generating a path", async () => {
    const tab = target();
    const sent: Array<{ readonly method: string; readonly params: Readonly<Record<string, unknown>> }> = [];
    bindMotorTab(tab, { connected: true, async send<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      sent.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      return {} as T;
    } });
    const motor = new SessionMotor(tab.browserSessionId, 17);
    const controller = new HumanInputController(motor);
    controller.start(tab.tabId, 2);
    let admitted = false;
    const events: DirectHumanInputEvent[] = [
      { kind: "pointerMove", point: { x: 10, y: 20 } },
      { kind: "pointerMove", point: { x: 30, y: 40 } },
      { kind: "pointerDown", point: { x: 30, y: 40 }, button: "left", clickCount: 1 },
      { kind: "pointerMove", point: { x: 50, y: 60 } },
      { kind: "pointerUp", point: { x: 50, y: 60 }, button: "left", clickCount: 1 },
    ];
    const result = await controller.dispatch(tab, 2, events, () => { admitted = true; });
    assert.equal(admitted, true);
    assert.equal(result.coalescedPointerMoveCount, 1);
    assert.deepEqual(sent.filter((item) => item.method === "Input.dispatchMouseEvent").map((item) => [item.params.type, item.params.x, item.params.y, item.params.buttons]), [
      ["mouseMoved", 30, 40, 0],
      ["mousePressed", 30, 40, 1],
      ["mouseMoved", 50, 60, 1],
      ["mouseReleased", 50, 60, 0],
    ]);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
    assert.deepEqual({ x: motor.state.x, y: motor.state.y }, { x: 50, y: 60 });
  });

  it("uses the shared pressed registry for repeat, transition validation, and cleanup", async () => {
    const tab = target();
    const sent: Array<Readonly<Record<string, unknown>>> = [];
    bindMotorTab(tab, { connected: true, async send<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      sent.push(params);
      return {} as T;
    } });
    const motor = new SessionMotor(tab.browserSessionId, 19);
    const controller = new HumanInputController(motor);
    controller.start(tab.tabId, 2);
    await controller.dispatch(tab, 2, [{ kind: "keyDown", key: "ArrowDown", location: 0, modifiers: 0, repeat: false }, { kind: "keyDown", key: "ArrowDown", location: 0, modifiers: 0, repeat: true }], () => undefined);
    assert.deepEqual(motor.heldInputState.keys, ["ArrowDown"]);
    await assert.rejects(controller.dispatch(tab, 2, [{ kind: "keyDown", key: "ArrowDown", location: 0, modifiers: 0, repeat: false }], () => undefined), code("INPUT_UNSUPPORTED"));
    await motor.releaseAll(tab);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
    assert.equal(sent.filter((params) => params.type === "keyDown").length, 2);
    assert.equal(sent.filter((params) => params.type === "keyUp").length, 1);
  });

  it("preserves the remaining held-button mask during multi-button cleanup", async () => {
    const tab = target();
    const sent: Array<Readonly<Record<string, unknown>>> = [];
    bindMotorTab(tab, { connected: true, async send<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      if (method === "Input.dispatchMouseEvent") sent.push(params);
      return {} as T;
    } });
    const motor = new SessionMotor(tab.browserSessionId, 21);
    const controller = new HumanInputController(motor);
    controller.start(tab.tabId, 2);
    await controller.dispatch(tab, 2, [
      { kind: "pointerDown", point: { x: 5, y: 6 }, button: "left", clickCount: 1 },
      { kind: "pointerDown", point: { x: 5, y: 6 }, button: "right", clickCount: 1 },
    ], () => undefined);
    await motor.releaseAll(tab);
    assert.deepEqual(sent.filter((params) => params.type === "mouseReleased").map((params) => [params.button, params.buttons]), [["left", 2], ["right", 0]]);
    assert.deepEqual(motor.heldInputState, { buttons: [], keys: [] });
  });

  it("enforces the newer-painted-frame guard while allowing non-mutating movement", () => {
    const motor = new SessionMotor("session:guard", 23);
    const controller = new HumanInputController(motor);
    controller.start("tab:guard", 2);
    const clickRelease: DirectHumanInputEvent[] = [{ kind: "pointerUp", point: { x: 1, y: 1 }, button: "left", clickCount: 1 }];
    assert.equal(controller.noteFrameGuard(10, clickRelease), true);
    controller.assertFrameGuard(10, [{ kind: "pointerMove", point: { x: 2, y: 2 } }]);
    assert.throws(() => controller.assertFrameGuard(10, [{ kind: "text", text: "x" }]), code("INPUT_FRAME_STALE"));
    controller.assertFrameGuard(11, [{ kind: "text", text: "x" }]);
  });

  it("keeps one batch in flight and applies the pointer dispatch rate bound", async () => {
    const tab = target();
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let block = false;
    bindMotorTab(tab, { connected: true, async send<T>(method: string): Promise<T> {
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      if (block && method === "Input.dispatchMouseEvent") await new Promise<void>((resolve) => { release = resolve; enteredResolve(); });
      return {} as T;
    } });
    const motor = new SessionMotor(tab.browserSessionId, 29);
    const controller = new HumanInputController(motor, () => 500);
    controller.start(tab.tabId, 2);
    block = true;
    const first = controller.dispatch(tab, 2, [{ kind: "pointerMove", point: { x: 1, y: 1 } }], () => undefined);
    await entered;
    await assert.rejects(controller.dispatch(tab, 2, [{ kind: "pointerMove", point: { x: 2, y: 2 } }], () => undefined), code("INPUT_RATE_LIMITED"));
    release();
    await first;
    block = false;
    for (let index = 1; index < 60; index++) await controller.dispatch(tab, 2, [{ kind: "pointerMove", point: { x: index, y: index } }], () => undefined);
    await assert.rejects(controller.dispatch(tab, 2, [{ kind: "pointerMove", point: { x: 61, y: 61 } }], () => undefined), code("INPUT_RATE_LIMITED"));
  });

  it("binds retained retries to every normalized event semantic without a second side effect", () => {
    type InputEvents = Extract<WorkspaceBrokerRequest, { readonly kind: "workspace.input.batch" }>["events"];
    const secret = "phase4a-ledger-secret-DoNotRetain-雪";
    const cases: Array<{ readonly original: InputEvents; readonly conflict: InputEvents }> = [
      { original: [{ kind: "pointerMove", point: { imageX: 10, imageY: 20 } }], conflict: [{ kind: "pointerMove", point: { imageX: 11, imageY: 20 } }] },
      { original: [{ kind: "pointerMove", point: { imageX: 10, imageY: 20 } }], conflict: [{ kind: "pointerMove", point: { imageX: 10, imageY: 21 } }] },
      { original: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "left", clickCount: 1 }], conflict: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "right", clickCount: 1 }] },
      { original: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "left", clickCount: 1 }], conflict: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "left", clickCount: 2 }] },
      { original: [{ kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 1, deltaY: 2 }], conflict: [{ kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 2, deltaY: 2 }] },
      { original: [{ kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 1, deltaY: 2 }], conflict: [{ kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 1, deltaY: 3 }] },
      { original: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: false }], conflict: [{ kind: "keyDown", key: "A", code: "KeyB", location: 0, modifiers: 0, repeat: false }] },
      { original: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: false }], conflict: [{ kind: "keyDown", key: "A", code: "KeyA", location: 1, modifiers: 0, repeat: false }] },
      { original: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: false }], conflict: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 2, repeat: false }] },
      { original: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: false }], conflict: [{ kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: true }] },
      { original: [{ kind: "text", text: secret }], conflict: [{ kind: "text", text: "phase4a-ledger-secret-Different-Ω" }] },
      { original: [{ kind: "pointerMove", point: { imageX: 10, imageY: 20 } }, { kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 1, deltaY: 2 }], conflict: [{ kind: "wheel", point: { imageX: 10, imageY: 20 }, deltaX: 1, deltaY: 2 }, { kind: "pointerMove", point: { imageX: 10, imageY: 20 } }] },
      { original: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "left", clickCount: 1 }, { kind: "pointerMove", point: { imageX: 20, imageY: 30 } }, { kind: "pointerUp", point: { imageX: 20, imageY: 30 }, button: "left", clickCount: 1 }], conflict: [{ kind: "pointerDown", point: { imageX: 10, imageY: 20 }, button: "left", clickCount: 1 }, { kind: "pointerMove", point: { imageX: 21, imageY: 30 } }, { kind: "pointerUp", point: { imageX: 20, imageY: 30 }, button: "left", clickCount: 1 }] },
    ];
    const motor = new SessionMotor("session:fingerprint", 30);
    const controller = new HumanInputController(motor);
    const acknowledgement = { kind: "workspaceInputAck" as const, inputBatchSequence: 1, acceptedEventCount: 1, coalescedPointerMoveCount: 0, awaitingNewFrame: true };
    for (const [index, testCase] of cases.entries()) {
      controller.start("tab:human-input", 2);
      let sideEffects = 0;
      const accept = (events: InputEvents): typeof acknowledgement => {
        const digest = controller.semanticFingerprint(inputRequest(events));
        const retained = controller.retainedAcknowledgement(1, `operation:case:${index}`, digest);
        if (retained !== undefined) return retained;
        sideEffects++;
        controller.retainAcknowledgement(`operation:case:${index}`, digest, acknowledgement);
        return acknowledgement;
      };
      assert.deepEqual(accept(testCase.original), acknowledgement);
      assert.deepEqual(accept(testCase.original), acknowledgement);
      assert.equal(sideEffects, 1);
      assert.throws(() => accept(testCase.conflict), code("CONTROL_LEASE_CONFLICT"));
      assert.equal(sideEffects, 1);
      assert.equal(JSON.stringify(controller).includes(secret), false);
    }
  });

  it("retains only bounded sequence identity and sanitized acknowledgement, not human text", async () => {
    const tab = target();
    bindMotorTab(tab, { connected: true, async send<T>(method: string): Promise<T> {
      if (method === "Runtime.evaluate") return { result: { value: true } } as T;
      return {} as T;
    } });
    const motor = new SessionMotor(tab.browserSessionId, 31);
    const controller = new HumanInputController(motor);
    controller.start(tab.tabId, 2);
    const secret = "phase3b-secret-DoNotRetain";
    await controller.dispatch(tab, 2, [{ kind: "text", text: secret }], () => undefined);
    const acknowledgement = { kind: "workspaceInputAck" as const, inputBatchSequence: 1, acceptedEventCount: 1, coalescedPointerMoveCount: 0, awaitingNewFrame: true };
    const request = inputRequest([{ kind: "text", text: secret }]);
    const digest = controller.semanticFingerprint(request);
    controller.retainAcknowledgement("operation:human-text", digest, acknowledgement);
    assert.deepEqual(controller.retainedAcknowledgement(1, "operation:human-text", digest), acknowledgement);
    const conflictingDigest = controller.semanticFingerprint(inputRequest([{ kind: "text", text: "different-secret-same-shape" }]));
    assert.throws(() => controller.retainedAcknowledgement(1, "operation:human-text", conflictingDigest), code("CONTROL_LEASE_CONFLICT"));
    assert.throws(() => controller.retainedAcknowledgement(1, "operation:conflict", digest), code("CONTROL_LEASE_CONFLICT"));
    assert.throws(() => controller.retainedAcknowledgement(2, "operation:human-text", digest), code("CONTROL_LEASE_CONFLICT"));
    assert.equal(JSON.stringify(controller).includes(secret), false);
    assert.equal(JSON.stringify(motor).includes(secret), false);
  });
});

function inputRequest(events: Extract<WorkspaceBrokerRequest, { readonly kind: "workspace.input.batch" }>["events"]): Extract<WorkspaceBrokerRequest, { readonly kind: "workspace.input.batch" }> {
  return {
    protocolVersion: "browser.v3",
    kind: "workspace.input.batch",
    requestId: "request:human-text",
    operationId: "operation:human-text",
    deadline: new Date(Date.now() + 10_000).toISOString(),
    browserSessionId: "session:human-input",
    tabId: "tab:human-input",
    controlEpoch: 2,
    leaseId: "lease_control_test_0001",
    inputBatchSequence: 1,
    inputTargetGeneration: 1,
    frame: {
      runtimeInstanceId: "runtime_human_input_test",
      subscriptionId: "subscription_human_input_test",
      controlEpoch: 2,
      frameSequence: 1,
      documentGeneration: 1,
      viewportGeneration: 1,
      imagePixelWidth: 1280,
      imagePixelHeight: 720,
    },
    events,
  };
}
