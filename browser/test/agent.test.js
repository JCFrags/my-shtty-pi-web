const assert = require("node:assert/strict");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

const { BrowserAgentRuntime } = require("../dist/agent/runtime.js");
const { BrowserControl } = require("../dist/agent/control.js");
const { TerminalBrowserDriver } = require("../dist/agent/terminal-browser-driver.js");
const { MAX_CONTROL_LINE_BYTES, Registry } = require("../dist/registry.js");

function driverFixture(driverOptions = {}) {
  const events = [];
  const sleeps = [];
  const target = {
    agentPointer: (event) => events.push(event),
    releaseAgentPointer: () => events.push({ kind: "release-pointer" }),
    releaseAgentInput: () => events.push({ kind: "release" }),
    agentKeyDown: (key) => events.push({ kind: "key-down", key: key.canonical }),
    agentKeyChar: (key) => events.push({ kind: "char", key: key.character }),
    agentKeyUp: (key) => events.push({ kind: "key-up", key: key.canonical }),
    agentSelectAll: async () => events.push({ kind: "select-all" }),
    agentInsertText: async (text) => events.push({ kind: "insert-text", length: text.length }),
    agentWheel: async (x, y, deltaX, deltaY) => events.push({ kind: "wheel", x, y, deltaX, deltaY }),
    agentNavigate: async (url) => url,
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
    refState: async () => ({ exists: true, connected: true, editable: true }),
    probe: async () => ({ exists: true, visible: true, refText: "", documentText: "" }),
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

test("driver drag holds through movement and always releases", async () => {
  const { driver, events } = driverFixture();
  await driver.drag({
    samples: [{ x: 5, y: 6, t: 0 }, { x: 15, y: 16, t: 0 }],
    target: { x: 15, y: 16 },
    button: "left",
    mode: "content",
  });
  assert.deepEqual(events, [
    { kind: "down", x: 5, y: 6, button: "left" },
    { kind: "move", x: 5, y: 6 },
    { kind: "move", x: 15, y: 16 },
    { kind: "up", x: 15, y: 16, button: "left" },
  ]);
});

test("driver drag releases before reporting an invalidated operation", async () => {
  let guards = 0;
  const { driver, events } = driverFixture({
    beforeInput: () => {
      guards += 1;
      if (guards === 3) throw new Error("page changed since observation");
    },
  });
  await assert.rejects(driver.drag({
    samples: [{ x: 5, y: 6, t: 0 }, { x: 15, y: 16, t: 0 }],
    target: { x: 15, y: 16 },
    button: "left",
    mode: "content",
  }), /page changed since observation/);
  assert.deepEqual(events.slice(-2), [
    { kind: "up", x: 15, y: 16, button: "left" },
    { kind: "release" },
  ]);
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

test("driver activity callbacks report cursor, target, and click phases", async () => {
  const activity = [];
  const { driver } = driverFixture({
    onTarget: (point) => activity.push({ kind: "target", point }),
    onPointer: (event) => activity.push(event),
  });
  await driver.click(clickArgs({ pressMs: 0 }));
  assert.deepEqual(activity, [
    { kind: "move", x: 10, y: 12 },
    { kind: "target", point: { x: 20, y: 24 } },
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

test("driver content delivery rejects debugger input", async () => {
  const { driver } = driverFixture();
  await assert.rejects(driver.type({ text: "hello", mode: "debugger", perKeyMinMs: 0, perKeyMaxMs: 0 }), /only supports content delivery/);
  await assert.rejects(driver.pressKey("Enter", "debugger"), /only supports content delivery/);
  await assert.rejects(driver.scroll({ dx: 0, dy: 10, steps: 1, mode: "debugger" }), /only supports content delivery/);
  await assert.rejects(driver.click(clickArgs({ mode: "debugger" })), /only supports content delivery/);
});

test("driver guard prevents native input after invalidation", async () => {
  const { driver, events } = driverFixture({
    beforeInput: () => { throw new Error("page changed since observation"); },
  });
  await assert.rejects(driver.click(clickArgs()), /page changed since observation/);
  assert.deepEqual(events, [{ kind: "release" }]);
});

function runtimeFixture(options = {}) {
  let documentId = "document-1";
  const control = options.control || new BrowserControl();
  let nextObservation = 0;
  let clickedRef = null;
  let released = 0;
  let capturedRect = null;
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
    releaseAgentInput: () => { released += 1; },
    agentKeyDown: async () => {},
    agentKeyChar: () => {},
    agentKeyUp: () => {},
    agentSelectAll: async () => {},
    agentInsertText: async () => {},
    agentWheel: async () => {},
    agentNavigate: async () => "https://example.test/",
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "https://example.test/",
    capturePage: options.capturePage || (async (rect) => {
      capturedRect = rect ?? null;
      const png = Buffer.alloc(24);
      png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      png.writeUInt32BE(rect ? 20 : 100, 16);
      png.writeUInt32BE(rect ? 10 : 80, 20);
      return png;
    }),
  };
  const actionServiceFactory = options.actionServiceFactory || (async () => ({
    click: async ({ ref }) => {
      clickedRef = ref;
      return { x: 12, y: 14 };
    },
  }));
  const runtime = new BrowserAgentRuntime(target, {
    control,
    observer,
    actionServiceFactory,
    onActivityChange: options.onActivityChange,
    observationId: () => `observation-${++nextObservation}`,
  });
  return {
    runtime,
    control,
    observer,
    setDocumentId: (value) => { documentId = value; },
    clickedRef: () => clickedRef,
    released: () => released,
    capturedRect: () => capturedRect,
  };
}

test("BrowserAgentRuntime releases the pointer on document invalidation", () => {
  const { runtime, released } = runtimeFixture();
  runtime.invalidateDocument();
  assert.equal(released(), 1);
});

test("BrowserAgentRuntime returns bounded visual metadata and keeps image bytes out of JSON", async () => {
  const { runtime, capturedRect } = runtimeFixture();
  const observation = await runtime.observe({ view: "both", scope: "element", ref: "e1" });
  assert.deepEqual(capturedRect(), { x: 1, y: 2, width: 20, height: 10 });
  assert.deepEqual(
    { ...observation.visual, data: undefined },
    {
      mimeType: "image/png",
      width: 20,
      height: 10,
      bytes: 24,
      scope: "element",
      rect: { x: 1, y: 2, width: 20, height: 10 },
      data: undefined,
    },
  );
  assert.equal(Buffer.isBuffer(observation.visual.data), true);
});

test("BrowserAgentRuntime rejects oversized or stale visual captures", async () => {
  const oversized = Buffer.alloc(24);
  oversized.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  oversized.writeUInt32BE(1601, 16);
  oversized.writeUInt32BE(80, 20);
  const invalid = runtimeFixture({ capturePage: async () => oversized });
  await assert.rejects(
    invalid.runtime.observe({ view: "visual" }),
    /invalid dimensions/,
  );

  let started = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = runtimeFixture({
    capturePage: async () => {
      started = true;
      await gate;
      const png = Buffer.alloc(24);
      png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      png.writeUInt32BE(100, 16);
      png.writeUInt32BE(80, 20);
      return png;
    },
  });
  const observation = stale.runtime.observe({ view: "visual" });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  stale.runtime.invalidateDocument();
  release();
  await assert.rejects(observation, /page changed during observation/);
});

test("BrowserAgentRuntime hover does not emit a click pulse", async () => {
  const activity = [];
  const { runtime } = runtimeFixture({
    onActivityChange: (value) => activity.push(value),
    actionServiceFactory: async (driver) => ({
      hover: async () => {
        await driver.move([{ x: 12, y: 14, t: 0 }], "content");
        await driver.hover({ x: 12, y: 14 });
      },
    }),
  });
  const observation = await runtime.observe();
  const result = await runtime.hover({
    target: { ref: "e1" },
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  assert.deepEqual(result.point, { x: 12, y: 14 });
  assert.equal(activity.some((value) => value?.pulse === true), false);
});

test("BrowserAgentRuntime requires visual state for coordinate drag", async () => {
  const calls = [];
  const { runtime } = runtimeFixture({
    actionServiceFactory: async () => ({
      drag: async (from, to, button) => calls.push({ from, to, button }),
    }),
  });
  const semantic = await runtime.observe();
  await assert.rejects(runtime.drag({
    from: { x: 1, y: 2 }, to: { x: 10, y: 12 }, button: "left",
    observationId: semantic.observationId, expectedControlEpoch: 1,
  }), /latest visual observation/);
  const visual = await runtime.observe({ view: "visual" });
  await runtime.drag({
    from: { x: 1, y: 2 }, to: { x: 10, y: 12 }, button: "left",
    observationId: visual.observationId, expectedControlEpoch: 1,
  });
  assert.deepEqual(calls, [{ from: { x: 1, y: 2 }, to: { x: 10, y: 12 }, button: "left" }]);
});

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

test("BrowserAgentRuntime forwards native click activity and clears it on invalidation", async () => {
  const activity = [];
  const { runtime } = runtimeFixture({
    onActivityChange: (value) => activity.push(value),
    actionServiceFactory: async (driver) => ({
      click: async () => {
        await driver.click(clickArgs({ pressMs: 0 }));
        return { x: 20, y: 24 };
      },
    }),
  });
  const observation = await runtime.observe();
  await runtime.click({ ref: "e1", observationId: observation.observationId, expectedControlEpoch: 1 });
  assert.deepEqual(runtime.activity, {
    cursor: { x: 20, y: 24 },
    target: null,
    pulse: true,
  });
  assert.notEqual(activity.length, 0);
  runtime.invalidateDocument();
  assert.equal(runtime.activity, null);
  assert.equal(activity.at(-1), null);
});

test("BrowserAgentRuntime does not recreate activity after control takeover", async () => {
  const activity = [];
  let runtime;
  const control = new BrowserControl({ onTransition: () => runtime?.invalidateControl() });
  const fixture = runtimeFixture({
    control,
    onActivityChange: (value) => {
      activity.push(value);
      if (value?.target) control.takeHuman("pointer");
    },
    actionServiceFactory: async (driver) => ({
      click: async () => {
        await driver.click(clickArgs({ pressMs: 0 }));
        return { x: 20, y: 24 };
      },
    }),
  });
  runtime = fixture.runtime;
  const observation = await runtime.observe();
  await assert.rejects(
    runtime.click({ ref: "e1", observationId: observation.observationId, expectedControlEpoch: 1 }),
    /stale control epoch/,
  );
  assert.equal(runtime.activity, null);
  assert.equal(activity.at(-1), null);
});

test("BrowserAgentRuntime stops an active click after control takeover", async () => {
  let started = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { runtime, control } = runtimeFixture({
    actionServiceFactory: async () => ({
      click: async () => {
        started = true;
        await gate;
        return { x: 12, y: 14 };
      },
    }),
  });
  const observation = await runtime.observe();
  const click = runtime.click({
    ref: "e1",
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  control.takeHuman("pointer");
  release();
  await assert.rejects(click, /stale control epoch|agent control is human/);
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

function registryBinaryRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("registry binary request timed out"));
    }, 2000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const headerText = buffer.subarray(0, newline).toString("utf8");
      const header = JSON.parse(headerText);
      const bytes = header.binaryBytes ?? 0;
      if (buffer.byteLength - newline - 1 < bytes) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ header, headerText, binary: buffer.subarray(newline + 1, newline + 1 + bytes) });
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

test("socket request parsing rejects malformed observe and click requests", async () => {
  const key = `agent-test-${randomUUID()}`;
  const hostControl = new BrowserControl();
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
    agentStatus: () => hostControl.snapshot,
    agentPause: (epoch) => hostControl.pause(epoch),
    agentResume: (epoch) => hostControl.resume(epoch),
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
    assert.deepEqual(
      (await registryRequest(registry.socketPath, { id: "6", cmd: "agent.status" })).data,
      { state: "agent", controlEpoch: 1, reason: null, busy: false },
    );
    assert.deepEqual(
      (await registryRequest(registry.socketPath, {
        id: "7",
        cmd: "agent.pause",
        expectedControlEpoch: 1,
      })).data,
      { state: "paused", controlEpoch: 2, reason: "manual-pause", busy: false },
    );
    assert.deepEqual(
      (await registryRequest(registry.socketPath, { id: "8", cmd: "agent.status" })).data,
      { state: "paused", controlEpoch: 2, reason: "manual-pause", busy: false },
    );
    assert.deepEqual(
      (await registryRequest(registry.socketPath, {
        id: "9",
        cmd: "agent.resume",
        expectedControlEpoch: 2,
      })).data,
      { state: "agent", controlEpoch: 3, reason: "manual-resume", busy: false },
    );
    const stale = await registryRequest(registry.socketPath, {
      id: "10",
      cmd: "agent.pause",
      expectedControlEpoch: 2,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /stale control epoch/);
  } finally {
    registry.dispose();
  }
});

function registryHost(key, calls = []) {
  const control = new BrowserControl();
  return {
    key,
    tty: null,
    owner: null,
    splitDir: null,
    parentTty: null,
    state: () => ({ url: "about:blank", title: "", favicon: null, loading: false, canGoBack: false, canGoForward: false, findMatches: null, zoom: 1 }),
    interop: () => ({ mode: "browser" }),
    where: async () => ({ terminal: null, tab: null, pane: null }),
    openAppTab: () => ({ tab: 1 }),
    openTab: () => 1,
    activateTab: () => true,
    agentTabSwitchAllowed: () => true,
    agentStatus: () => control.snapshot,
    agentPause: (epoch) => control.pause(epoch),
    agentResume: (epoch) => control.resume(epoch),
    agentObserve: async () => ({}),
    agentClick: async () => ({}),
    agentHover: async (_id, request) => { calls.push(["hover", request]); return { operation: "hover" }; },
    agentDrag: async (_id, request) => { calls.push(["drag", request]); return { operation: "drag" }; },
    agentType: async (_id, request) => { calls.push(["type", request]); return { operation: "type" }; },
    agentPressKey: async (_id, request) => { calls.push(["press-key", request]); return { operation: "press-key" }; },
    agentScroll: async (_id, request) => { calls.push(["scroll", request]); return { operation: "scroll" }; },
    agentNavigate: async (_id, request) => { calls.push(["navigate", request]); return { operation: "navigate" }; },
    agentGetUrl: async (_id, request) => { calls.push(["get-url", request]); return { operation: "get-url" }; },
    agentWaitFor: async (_id, request) => { calls.push(["wait-for", request]); return { operation: "wait-for" }; },
    closeTab: () => true,
    agentTouch: () => true,
    agentRelease: () => {},
    tabs: () => [],
    targets: async () => [],
    viewport: () => ({ width: 100, height: 80 }),
  };
}

test("registry publishes complete browser owner metadata", () => {
  const host = registryHost(`owner-${randomUUID()}`);
  host.owner = {
    workspaceId: "w1",
    tabId: "w1:t2",
    paneId: "w1:p3",
    sessionId: "pi-session",
    projectDir: "/tmp/project",
  };
  const registry = new Registry(host);
  try {
    assert.deepEqual(
      {
        ownerWorkspaceId: registry.record().ownerWorkspaceId,
        ownerTabId: registry.record().ownerTabId,
        ownerPaneId: registry.record().ownerPaneId,
        ownerSessionId: registry.record().ownerSessionId,
        ownerProjectDir: registry.record().ownerProjectDir,
      },
      {
        ownerWorkspaceId: "w1",
        ownerTabId: "w1:t2",
        ownerPaneId: "w1:p3",
        ownerSessionId: "pi-session",
        ownerProjectDir: "/tmp/project",
      },
    );
  } finally {
    registry.dispose();
  }
});

test("socket sends visual image bytes after bounded JSON metadata", async () => {
  const key = `visual-${randomUUID()}`;
  const host = registryHost(key);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  host.agentObserve = async () => ({
    observationId: "obs",
    documentId: "doc",
    controlEpoch: 1,
    snapshot: { url: "about:blank", title: "", viewport: { width: 2, height: 2 }, elements: [], text: "" },
    visual: {
      mimeType: "image/png",
      width: 2,
      height: 2,
      bytes: image.byteLength,
      scope: "viewport",
      rect: { x: 0, y: 0, width: 2, height: 2 },
      data: image,
    },
  });
  const registry = new Registry(host);
  try {
    const response = await registryBinaryRequest(registry.socketPath, {
      id: "visual",
      cmd: "agent.observe",
      tab: 1,
      view: "visual",
      scope: "viewport",
    });
    assert.equal(response.header.ok, true);
    assert.equal(response.header.binaryBytes, image.byteLength);
    assert.deepEqual(response.binary, image);
    assert.equal(response.headerText.includes(image.toString("base64")), false);
    assert.equal(response.headerText.includes('"type":"Buffer"'), false);
  } finally {
    registry.dispose();
  }
});

test("socket dispatches native action requests and enforces the 256 KiB line bound", async () => {
  const key = `d-${randomUUID()}`;
  const calls = [];
  const registry = new Registry(registryHost(key, calls));
  try {
    const requests = [
      { id: "hover", cmd: "agent.hover", tab: 1, ref: "e1", observationId: "obs", expectedControlEpoch: 1 },
      { id: "drag", cmd: "agent.drag", tab: 1, fromRef: "e1", toX: 10, toY: 20, observationId: "obs", expectedControlEpoch: 1 },
      { id: "type", cmd: "agent.type", tab: 1, ref: "e1", text: "Ada", observationId: "obs", expectedControlEpoch: 1 },
      { id: "press", cmd: "agent.press-key", tab: 1, key: "Enter", observationId: "obs", expectedControlEpoch: 1 },
      { id: "scroll", cmd: "agent.scroll", tab: 1, dy: 10, observationId: "obs", expectedControlEpoch: 1 },
      { id: "navigate", cmd: "agent.navigate", tab: 1, url: "about:blank", expectedControlEpoch: 1 },
      { id: "url", cmd: "agent.get-url", tab: 1, expectedControlEpoch: 1 },
      { id: "wait", cmd: "agent.wait-for", tab: 1, text: "ready", timeoutMs: 0, observationId: "obs", expectedControlEpoch: 1 },
    ];
    for (const request of requests) {
      const response = await registryRequest(registry.socketPath, request);
      assert.equal(response.ok, true);
    }
    assert.deepEqual(calls.map(([kind]) => kind), ["hover", "drag", "type", "press-key", "scroll", "navigate", "get-url", "wait-for"]);
    assert.equal(calls[2][1].replace, false);

    const tooLarge = await registryRequest(registry.socketPath, {
      id: "large",
      cmd: "agent.type",
      tab: 1,
      ref: "e1",
      text: "x".repeat(MAX_CONTROL_LINE_BYTES),
      observationId: "obs",
      expectedControlEpoch: 1,
    });
    assert.equal(tooLarge.id, null);
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error, "request too large");
  } finally {
    registry.dispose();
  }
});
