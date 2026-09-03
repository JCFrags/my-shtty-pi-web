const assert = require("node:assert/strict");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

const { BrowserAgentRuntime } = require("../dist/agent/runtime.js");
const { TerminalBrowserDriver } = require("../dist/agent/terminal-browser-driver.js");
const { Registry } = require("../dist/registry.js");

function driverFixture(driverOptions = {}) {
  const events = [];
  const sleeps = [];
  const target = {
    agentPointer: (event) => events.push(event),
    releaseAgentPointer: () => events.push({ kind: "release" }),
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "https://example.test/",
    runJs: async () => null,
  };
  const observer = {
    observe: async () => ({
      documentId: "document-1",
      snapshot: { url: "https://example.test/", title: "", viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, elements: [], text: "" },
    }),
    currentDocumentId: async () => "document-1",
    ensureVisible: async () => ({ x: 1, y: 2, width: 3, height: 4 }),
  };
  const driver = new TerminalBrowserDriver(target, observer, {
    sleep: async (ms) => sleeps.push(ms),
    ...driverOptions,
  });
  return { driver, events, sleeps, observer };
}

function clickArgs(overrides = {}) {
  return {
    samples: [{ x: 10, y: 12, t: 0 }],
    target: { x: 20, y: 24 },
    button: "left",
    dblclick: false,
    preClickDwellMs: 3,
    pressMs: 7,
    mode: "content",
    ...overrides,
  };
}

test("driver movement replays coordinates in order", async () => {
  const { driver, events } = driverFixture();
  await driver.move([
    { x: 1, y: 2, t: 0 },
    { x: 3, y: 4, t: 1 },
    { x: 5, y: 6, t: 2 },
  ], "content");
  assert.deepEqual(events, [
    { kind: "move", x: 1, y: 2 },
    { kind: "move", x: 3, y: 4 },
    { kind: "move", x: 5, y: 6 },
  ]);
});

test("driver timing uses relative sample deltas", async () => {
  const { driver, sleeps } = driverFixture();
  await driver.move([
    { x: 1, y: 2, t: 25 },
    { x: 3, y: 4, t: 40 },
    { x: 5, y: 6, t: 40 },
  ], "content");
  assert.deepEqual(sleeps, [25, 15]);
});

test("driver click produces move, down, and up in order", async () => {
  const { driver, events, sleeps } = driverFixture();
  await driver.click(clickArgs());
  assert.deepEqual(events, [
    { kind: "move", x: 10, y: 12 },
    { kind: "down", x: 20, y: 24, button: "left" },
    { kind: "up", x: 20, y: 24, button: "left" },
  ]);
  assert.deepEqual(sleeps, [3, 7]);
});

test("driver double-click produces two complete click cycles", async () => {
  const { driver, events } = driverFixture();
  await driver.click(clickArgs({ dblclick: true }));
  assert.deepEqual(events, [
    { kind: "move", x: 10, y: 12 },
    { kind: "down", x: 20, y: 24, button: "left" },
    { kind: "up", x: 20, y: 24, button: "left" },
    { kind: "down", x: 20, y: 24, button: "left" },
    { kind: "up", x: 20, y: 24, button: "left" },
  ]);
});

test("cursorState uses viewport center before the first movement", async () => {
  const { driver } = driverFixture();
  assert.deepEqual(await driver.cursorState(), { x: 50, y: 40 });
  await driver.move([{ x: 9, y: 11, t: 0 }], "content");
  assert.deepEqual(await driver.cursorState(), { x: 9, y: 11 });
});

test("ensureVisible returns the observer result", async () => {
  const { driver, observer } = driverFixture();
  const expected = { x: 1, y: 2, width: 3, height: 4 };
  assert.deepEqual(await driver.ensureVisible("e1"), expected);
  assert.deepEqual(await observer.ensureVisible("e1"), expected);
});

test("unsupported driver methods fail explicitly", async () => {
  const { driver } = driverFixture();
  await assert.rejects(driver.type({ text: "hello", mode: "content" }), /not supported/);
  await assert.rejects(driver.navigate("https://example.test/"), /not supported/);
  await assert.rejects(driver.click(clickArgs({ mode: "debugger" })), /only supports content delivery/);
});

test("driver guard prevents native input after invalidation", async () => {
  const { driver, events } = driverFixture({
    beforeInput: () => { throw new Error("page changed since observation"); },
  });
  await assert.rejects(driver.click(clickArgs()), /page changed since observation/);
  assert.deepEqual(events, [{ kind: "release" }]);
});

function runtimeFixture() {
  let documentId = "document-1";
  let nextObservation = 0;
  let clickedRef = null;
  const observer = {
    observe: async () => ({
      documentId,
      snapshot: {
        url: "https://example.test/",
        title: "Example",
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        elements: [{ ref: "e1", tag: "button", role: "button", name: "Increment", rect: { x: 1, y: 2, width: 20, height: 10 }, editable: false, visible: true, inViewport: true }],
        text: "Count: 0",
      },
    }),
    currentDocumentId: async () => documentId,
    ensureVisible: async () => null,
  };
  const target = {
    runJs: async () => null,
    agentPointer: () => {},
    releaseAgentPointer: () => {},
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "https://example.test/",
  };
  const actionServiceFactory = async () => ({
    click: async ({ ref }) => {
      clickedRef = ref;
      return { x: 12, y: 14 };
    },
  });
  const runtime = new BrowserAgentRuntime(target, {
    observer,
    actionServiceFactory,
    observationId: () => `observation-${++nextObservation}`,
  });
  return {
    runtime,
    observer,
    setDocumentId: (value) => { documentId = value; },
    clickedRef: () => clickedRef,
  };
}

test("BrowserAgentRuntime rejects an old observationId", async () => {
  const { runtime } = runtimeFixture();
  const first = await runtime.observe();
  await runtime.observe();
  await assert.rejects(
    runtime.click({ ref: "e1", observationId: first.observationId, expectedControlEpoch: 1 }),
    /stale or unknown observation/,
  );
});

test("BrowserAgentRuntime rejects a stale control epoch", async () => {
  const { runtime } = runtimeFixture();
  const observation = await runtime.observe();
  await assert.rejects(
    runtime.click({ ref: "e1", observationId: observation.observationId, expectedControlEpoch: 2 }),
    /stale control epoch/,
  );
});

test("BrowserAgentRuntime rejects a replaced document", async () => {
  const { runtime, setDocumentId } = runtimeFixture();
  const observation = await runtime.observe();
  setDocumentId("document-2");
  await assert.rejects(
    runtime.click({ ref: "e1", observationId: observation.observationId, expectedControlEpoch: 1 }),
    /page changed since observation/,
  );
});

test("BrowserAgentRuntime delegates a valid click to ActionService", async () => {
  const { runtime, clickedRef } = runtimeFixture();
  const observation = await runtime.observe();
  const result = await runtime.click({
    ref: "e1",
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  assert.equal(clickedRef(), "e1");
  assert.deepEqual(result, {
    ref: "e1",
    point: { x: 12, y: 14 },
    documentId: "document-1",
    controlEpoch: 1,
    url: "https://example.test/",
  });
});

function registryRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("registry request timed out"));
    }, 2000);
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

test("socket request parsing rejects malformed observe and click requests", async () => {
  const key = `agent-test-${randomUUID()}`;
  const host = {
    key,
    tty: null,
    splitDir: null,
    parentTty: null,
    state: () => ({ url: "about:blank", title: "", favicon: null, loading: false, canGoBack: false, canGoForward: false, findMatches: null, zoom: 1 }),
    interop: () => ({ mode: "browser" }),
    where: async () => ({ terminal: null, tab: null, pane: null }),
    openAppTab: () => ({ tab: 1 }),
    openTab: () => 1,
    activateTab: () => true,
    agentTabSwitchAllowed: () => true,
    agentObserve: async () => ({}),
    agentClick: async () => ({}),
    closeTab: () => true,
    agentTouch: () => true,
    agentRelease: () => {},
    tabs: () => [],
    targets: async () => [],
    viewport: () => ({ width: 100, height: 80 }),
  };
  const registry = new Registry(host);
  try {
    const malformed = [
      { id: "1", cmd: "agent.observe" },
      { id: "2", cmd: "agent.observe", tab: 1, maxElements: 0 },
      { id: "3", cmd: "agent.observe", tab: 1, includeText: "yes" },
      { id: "4", cmd: "agent.click", tab: 1, observationId: "obs", expectedControlEpoch: 1 },
      { id: "5", cmd: "agent.click", tab: 1, ref: "e1", observationId: "obs", expectedControlEpoch: 0 },
    ];
    for (const request of malformed) {
      const response = await registryRequest(registry.socketPath, request);
      assert.equal(response.id, request.id);
      assert.equal(response.ok, false);
      assert.equal(typeof response.error, "string");
      assert.equal(response.error.includes("\n"), false);
    }
  } finally {
    registry.dispose();
  }
});
