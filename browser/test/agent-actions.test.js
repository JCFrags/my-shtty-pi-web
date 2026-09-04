const assert = require("node:assert/strict");
const { test } = require("node:test");

const { BrowserAgentRuntime } = require("../dist/agent/runtime.js");
const { BrowserControl } = require("../dist/agent/control.js");
const { TerminalBrowserDriver } = require("../dist/agent/terminal-browser-driver.js");

function driverFixture(options = {}) {
  const events = [];
  const sleeps = [];
  const target = {
    agentPointer: (event) => events.push(event),
    releaseAgentPointer: () => {},
    releaseAgentInput: () => events.push({ kind: "release" }),
    agentKeyDown: (key) => events.push({ kind: "key-down", key: key.canonical, modifiers: [...key.modifiers] }),
    agentKeyChar: (key) => events.push({ kind: "char", text: key.character }),
    agentKeyUp: (key) => events.push({ kind: "key-up", key: key.canonical }),
    agentSelectAll: async () => events.push({ kind: "select-all" }),
    agentInsertText: async (text) => events.push({ kind: "insert-text", length: text.length }),
    agentWheel: async (x, y, dx, dy) => events.push({ kind: "wheel", x, y, dx, dy }),
    agentNavigate: async (url) => url,
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "file:///example.html",
    runJs: async () => null,
  };
  const observer = {
    observe: async () => ({
      documentId: "document-1",
      snapshot: {
        url: "file:///example.html",
        title: "",
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        elements: [],
        text: "",
      },
    }),
    currentDocumentId: async () => "document-1",
    ensureVisible: async () => null,
    refState: async () => ({ exists: true, connected: true, editable: true }),
    probe: async () => ({ exists: true, visible: true, refText: "", documentText: "" }),
  };
  const driver = new TerminalBrowserDriver(target, observer, {
    sleep: async (ms) => sleeps.push(ms),
    random: options.random || (() => 0.5),
    beforeInput: options.beforeInput,
  });
  return { driver, target, observer, events, sleeps };
}

function typeArgs(overrides = {}) {
  return {
    text: "Ada",
    perKeyMinMs: 10,
    perKeyMaxMs: 20,
    mode: "content",
    ...overrides,
  };
}

test("type with a schedule honors relative delays and correction order", async () => {
  const { driver, events, sleeps } = driverFixture();
  await driver.type(typeArgs({
    text: "ab",
    schedule: [
      { t: "key", ch: "a", delayMs: 11 },
      { t: "back", delayMs: 7 },
      { t: "key", ch: "b", delayMs: 13 },
    ],
  }));
  assert.deepEqual(sleeps, [11, 7, 13]);
  assert.deepEqual(events.map(({ kind, key, text }) => ({ kind, key, text })), [
    { kind: "key-down", key: "a", text: undefined },
    { kind: "char", key: undefined, text: "a" },
    { kind: "key-up", key: "a", text: undefined },
    { kind: "key-down", key: "Backspace", text: undefined },
    { kind: "key-up", key: "Backspace", text: undefined },
    { kind: "key-down", key: "b", text: undefined },
    { kind: "char", key: undefined, text: "b" },
    { kind: "key-up", key: "b", text: undefined },
  ]);
});

test("natural type uses an injectable bounded delay and Unicode code points", async () => {
  const { driver, events, sleeps } = driverFixture({ random: () => 0.5 });
  await driver.type(typeArgs({ text: "A😀", perKeyMinMs: 10, perKeyMaxMs: 20 }));
  assert.deepEqual(sleeps, [15, 15]);
  assert.deepEqual(events.filter((event) => event.kind === "char").map((event) => event.text), ["A", "😀"]);
});

test("scheduled typing combines surrogate pairs into one Unicode key", async () => {
  const { driver, events, sleeps } = driverFixture();
  await driver.type(typeArgs({
    text: "😀",
    schedule: [
      { t: "key", ch: "\ud83d", delayMs: 4 },
      { t: "key", ch: "\ude00", delayMs: 6 },
    ],
  }));
  assert.deepEqual(sleeps, [10]);
  assert.deepEqual(events.filter((event) => event.kind === "char").map((event) => event.text), ["😀"]);
});

test("replace selects all before native insertion and permits empty text", async () => {
  const { driver, events } = driverFixture();
  await driver.type(typeArgs({ text: "", replace: true }));
  assert.deepEqual(events, [
    { kind: "select-all" },
    { kind: "insert-text", length: 0 },
  ]);
});

test("non-replace empty text and embedded NUL are rejected", async () => {
  const { driver } = driverFixture();
  await assert.rejects(driver.type(typeArgs({ text: "" })), /must not be empty/);
  await assert.rejects(driver.type(typeArgs({ text: "a\0b" })), /NUL/);
});

test("pressKey normalizes Shift+Tab and Control+A", async () => {
  const { driver, events } = driverFixture();
  await driver.pressKey("Shift+Tab", "content");
  await driver.pressKey("Ctrl+A", "content");
  assert.deepEqual(events, [
    { kind: "key-down", key: "Shift+Tab", modifiers: ["shift"] },
    { kind: "key-up", key: "Shift+Tab" },
    { kind: "key-down", key: "Control+A", modifiers: ["ctrl"] },
    { kind: "key-up", key: "Control+A" },
  ]);
});

test("pressKey releases a held key after takeover and ignores the duplicate up", async () => {
  let calls = 0;
  const { driver, events } = driverFixture({
    beforeInput: () => {
      calls += 1;
      if (calls === 2) throw new Error("agent control is human");
    },
  });
  await assert.rejects(driver.pressKey("x", "content"), /agent control is human/);
  assert.deepEqual(events.map((event) => event.kind), ["key-down", "key-up", "release"]);
});

test("scroll distributes exact signed deltas with gradual easing", async () => {
  const { driver, events, sleeps } = driverFixture();
  await driver.scroll({ dx: 10, dy: 20, steps: 4, mode: "content" });
  const wheels = events.filter((event) => event.kind === "wheel");
  assert.equal(wheels.length, 6);
  assert.equal(wheels.reduce((sum, event) => sum + event.dx, 0), 10);
  assert.equal(wheels.reduce((sum, event) => sum + event.dy, 0), 20);
  assert.deepEqual(wheels[0], { kind: "wheel", x: 50, y: 40, dx: 0, dy: 1 });
  assert.deepEqual(wheels.map((event) => event.dy), [1, 3, 6, 6, 3, 1]);
  assert.deepEqual(sleeps, [24, 24, 24, 24, 24]);
});

test("medium scrolls use a visible eased schedule", async () => {
  const { driver, events, sleeps } = driverFixture();
  await driver.scroll({ dx: 0, dy: 1200, steps: 3, mode: "content" });
  const deltas = events.filter((event) => event.kind === "wheel").map((event) => event.dy);
  assert.equal(deltas.length, 20);
  assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), 1200);
  assert.equal(sleeps.reduce((sum, delay) => sum + delay, 0), 456);
  assert.ok(deltas[0] < deltas[Math.floor(deltas.length / 2)]);
  assert.ok(deltas.at(-1) < deltas[Math.floor(deltas.length / 2)]);
});

test("scroll clamps steps and rejects invalid bounds", async () => {
  const { driver, events } = driverFixture();
  await driver.scroll({ dx: 0, dy: 240, steps: 999, mode: "content" });
  assert.ok(events.filter((event) => event.kind === "wheel").length <= 80);
  await assert.rejects(driver.scroll({ dx: 0, dy: 0, steps: 1, mode: "content" }), /nonzero/);
  await assert.rejects(driver.scroll({ dx: 20_001, dy: 0, steps: 1, mode: "content" }), /too large/);
});

test("scroll stops before a later wheel after the guard refuses", async () => {
  let calls = 0;
  const { driver, events } = driverFixture({
    beforeInput: () => {
      calls += 1;
      if (calls === 2) throw new Error("stale control epoch");
    },
  });
  await assert.rejects(driver.scroll({ dx: 0, dy: 20, steps: 3, mode: "content" }), /stale control epoch/);
  assert.equal(events.filter((event) => event.kind === "wheel").length, 1);
  assert.equal(events.at(-1).kind, "release");
});

function runtimeFixture(options = {}) {
  const control = options.control || new BrowserControl();
  const calls = [];
  const target = {
    agentPointer: () => {},
    releaseAgentPointer: () => {},
    releaseAgentInput: () => {},
    agentKeyDown: async () => {},
    agentKeyChar: () => {},
    agentKeyUp: () => {},
    agentSelectAll: async () => {},
    agentInsertText: async () => {},
    agentWheel: async () => {},
    agentNavigate: async (url) => url,
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "file:///example.html",
    runJs: async () => null,
  };
  const observer = {
    observe: async () => ({
      documentId: "document-1",
      snapshot: {
        url: "file:///example.html",
        title: "Example",
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        elements: [{ ref: "e1", tag: "input", role: "textbox", name: "Name", rect: { x: 1, y: 2, width: 20, height: 10 }, editable: true, visible: true, inViewport: true }],
        text: "Value: old",
      },
    }),
    currentDocumentId: async () => "document-1",
    ensureVisible: async () => null,
    refState: async () => options.refState || ({ exists: true, connected: true, editable: true }),
    probe: async () => ({ exists: true, visible: true, refText: "", documentText: "" }),
  };
  const actionServiceFactory = options.actionServiceFactory || (async () => ({
    click: async () => ({ x: 1, y: 1 }),
    type: async (value) => calls.push({ kind: "type", value }),
    pressKey: async (key) => calls.push({ kind: "press-key", key }),
    scroll: async (value) => calls.push({ kind: "scroll", value }),
    navigate: async () => {},
    getUrl: async () => "file:///example.html",
    waitFor: async () => false,
  }));
  const runtime = new BrowserAgentRuntime(target, {
    control,
    observer,
    actionServiceFactory,
    observationId: () => "observation-1",
  });
  return { runtime, control, calls };
}

test("runtime type validates a live editable ref and omits text from metadata", async () => {
  const { runtime, calls } = runtimeFixture();
  const observation = await runtime.observe();
  const result = await runtime.type({
    ref: "e1",
    text: "Ada",
    replace: true,
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  assert.deepEqual(result, {
    ref: "e1",
    characters: 3,
    documentId: "document-1",
    controlEpoch: 1,
    url: "file:///example.html",
  });
  assert.deepEqual(calls, [{ kind: "type", value: { ref: "e1", text: "Ada", replace: true } }]);
  assert.equal(JSON.stringify(result).includes("Ada"), false);
});

test("runtime rejects a ref that is no longer editable", async () => {
  const { runtime, calls } = runtimeFixture({ refState: { exists: true, connected: true, editable: false } });
  const observation = await runtime.observe();
  await assert.rejects(runtime.type({
    ref: "e1",
    text: "Ada",
    replace: false,
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  }), /not editable/);
  assert.deepEqual(calls, []);
});

test("runtime refuses an observation-bound action in human state before dispatch", async () => {
  const { runtime, control, calls } = runtimeFixture();
  const observation = await runtime.observe();
  control.takeHuman("keyboard");
  await assert.rejects(runtime.pressKey({
    key: "Enter",
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  }), /agent control is human|stale control epoch|stale or unknown observation/);
  assert.deepEqual(calls, []);
});
