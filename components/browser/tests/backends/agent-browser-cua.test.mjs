import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_BROWSER_IDENTITY,
  AgentBrowserRunner,
  composeCuaCommands,
  validateCssPoint,
  validateVisualBinding,
} from "../../scripts/lib/agent-browser.mjs";

const geometry = Object.freeze({
  viewportWidth: 640,
  viewportHeight: 480,
  imageWidth: 1280,
  imageHeight: 960,
  deviceScaleFactor: 2,
  scrollX: 0,
  scrollY: 0,
  coordinateSpace: "css_viewport_top_left",
});

function binding(overrides = {}) {
  return {
    ...AGENT_BROWSER_IDENTITY,
    engineGeneration: "generation-1",
    tabId: "tab-1",
    sequence: 7,
    screenshotSha256: "a".repeat(64),
    capturedAt: "2026-08-12T07:30:00.000Z",
    geometry,
    ...overrides,
  };
}

test("installed agent-browser has the exact frozen runtime identity", () => {
  const runner = new AgentBrowserRunner({ session: `identity-${process.pid}` });
  const identity = runner.validateIdentity();
  assert.equal(identity.pathId, "agent-browser/chrome");
  assert.equal(identity.backendVersion, "0.33.1");
  assert.equal(identity.backendExecutableSha256, "6e04d06605c4ca62da36e3263086e0f7ceae808b55508de2c3958d4b7fe430aa");
});

test("adapter rejects unsupported engines and reports touch honestly", () => {
  assert.throws(
    () => new AgentBrowserRunner({ session: "wrong-engine", engine: "lightpanda" }),
    /expected agent-browser\/chrome/,
  );
  assert.equal(AGENT_BROWSER_IDENTITY.touch, false);
  assert.throws(() => composeCuaCommands({ type: "touch", x: 1, y: 1 }, geometry), /unsupported: touch/);
});

test("CSS viewport coordinates reject every invalid edge", () => {
  assert.deepEqual(validateCssPoint(0, 0, geometry), { x: 0, y: 0 });
  assert.deepEqual(validateCssPoint(639.999, 479.999, geometry), { x: 639.999, y: 479.999 });
  for (const point of [[-1, 0], [0, -1], [640, 0], [0, 480], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => validateCssPoint(point[0], point[1], geometry), /coordinate_out_of_range/);
  }
});

test("stale screenshot bindings fail closed", () => {
  const current = binding();
  assert.equal(validateVisualBinding(current, current), current);
  for (const changed of [
    binding({ sequence: 6 }),
    binding({ screenshotSha256: "b".repeat(64) }),
    binding({ engineGeneration: "generation-2" }),
    binding({ tabId: "tab-2" }),
    binding({ geometry: { ...geometry, viewportWidth: 639 } }),
  ]) {
    assert.throws(() => validateVisualBinding(changed, current), /stale_visual_binding/);
  }
});

test("mouse click, double-click, wheel, and drag use explicit low-level composition", () => {
  assert.deepEqual(composeCuaCommands({ type: "click", x: 180, y: 120 }, geometry), [
    ["mouse", "move", "180", "120"],
    ["mouse", "down", "left"],
    ["mouse", "up", "left"],
  ]);
  assert.equal(composeCuaCommands({ type: "double_click", x: 1, y: 2 }, geometry).length, 5);
  assert.deepEqual(composeCuaCommands({ type: "mouse_down", x: 3, y: 4 }, geometry), [
    ["mouse", "move", "3", "4"], ["mouse", "down", "left"],
  ]);
  assert.deepEqual(composeCuaCommands({ type: "mouse_up", x: 3, y: 4 }, geometry), [
    ["mouse", "move", "3", "4"], ["mouse", "up", "left"],
  ]);
  assert.deepEqual(composeCuaCommands({ type: "wheel", deltaX: 5, deltaY: -6 }, geometry), [["mouse", "wheel", "-6", "5"]]);
  const drag = composeCuaCommands({ type: "drag", fromX: 10, fromY: 20, toX: 110, toY: 220 }, geometry);
  assert.equal(drag.length, 11);
  assert.deepEqual(drag[0], ["mouse", "move", "10", "20"]);
  assert.deepEqual(drag.at(-1), ["mouse", "up", "left"]);
});

test("async command cancellation waits for child settlement", async () => {
  const runner = new AgentBrowserRunner({ binary: process.execPath, session: `cancel-${process.pid}` });
  const controller = new AbortController();
  const pending = runner.runAsync(["-e", "setInterval(() => {}, 1000)"], { json: false, signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 25);
  const result = await pending;
  assert.equal(result.settlement, "cancelled");
  assert.notEqual(result.signal, undefined);
});
