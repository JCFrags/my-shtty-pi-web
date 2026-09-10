const assert = require("node:assert/strict");
const { test } = require("node:test");

const { BrowserControl } = require("../dist/agent/control.js");
const { PageObserver } = require("../dist/agent/page-observer.js");
const { BrowserAgentRuntime } = require("../dist/agent/runtime.js");
const { TerminalBrowserDriver } = require("../dist/agent/terminal-browser-driver.js");

function waitDriverFixture(options = {}) {
  let clock = 0;
  let probeAt = 0;
  const sleeps = options.sleeps || [];
  const probes = options.probes || [
    { exists: false, visible: false, refText: "", documentText: "" },
  ];
  const calls = [];
  const releases = [];
  const observer = {
    observe: async () => ({ documentId: "doc-1", snapshot: {} }),
    currentDocumentId: async () => "doc-1",
    ensureVisible: async () => null,
    refState: async () => ({ exists: true, connected: true, editable: true }),
    probe: async (ref, text) => {
      calls.push({ ref, text });
      return probes[Math.min(probeAt++, probes.length - 1)];
    },
  };
  const target = {
    runJs: async () => null,
    agentPointer: () => {},
    releaseAgentPointer: () => {},
    releaseAgentInput: () => releases.push("release"),
    agentKeyDown: async () => {},
    agentKeyChar: () => {},
    agentKeyUp: () => {},
    agentSelectAll: async () => {},
    agentInsertText: async () => {},
    agentWheel: async () => {},
    agentNavigate: async (url) => url,
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => "about:blank",
  };
  const driver = new TerminalBrowserDriver(target, observer, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps.push(ms);
    },
    beforeInput: options.beforeInput,
  });
  return { driver, calls, releases, sleeps, setClock: (value) => { clock = value; } };
}

test("waitFor polls a normalized document text condition without page mutation", async () => {
  const fixture = waitDriverFixture({
    probes: [{ exists: true, visible: true, refText: "", documentText: "Loading   ready" }],
  });
  assert.equal(await fixture.driver.waitFor({ text: "Loading ready", condition: "text", timeoutMs: 1000 }), true);
  assert.deepEqual(fixture.calls, [{ ref: undefined, text: "Loading ready" }]);
  assert.deepEqual(fixture.sleeps, []);
});

test("waitFor handles ref visibility and existence separately", async () => {
  const visible = waitDriverFixture({ probes: [{ exists: true, visible: true, refText: "", documentText: "" }] });
  assert.equal(await visible.driver.waitFor({ ref: "e1", condition: "visible", timeoutMs: 0 }), true);
  const exists = waitDriverFixture({ probes: [{ exists: true, visible: false, refText: "", documentText: "" }] });
  assert.equal(await exists.driver.waitFor({ ref: "e1", condition: "exists", timeoutMs: 0 }), true);
});

test("waitFor uses injected polling time and returns false at the timeout", async () => {
  const fixture = waitDriverFixture({
    probes: [{ exists: false, visible: false, refText: "", documentText: "" }],
  });
  assert.equal(await fixture.driver.waitFor({ text: "ready", condition: "text", timeoutMs: 250 }), false);
  assert.deepEqual(fixture.sleeps, [100, 100, 50]);
  assert.equal(fixture.calls.length, 4);
});

test("waitFor releases agent input and stops polling when its guard refuses", async () => {
  let checks = 0;
  const fixture = waitDriverFixture({
    beforeInput: () => {
      checks += 1;
      if (checks === 2) throw new Error("stale control epoch");
    },
    probes: [{ exists: false, visible: false, refText: "", documentText: "" }],
  });
  await assert.rejects(
    fixture.driver.waitFor({ text: "ready", condition: "text", timeoutMs: 1000 }),
    /stale control epoch/,
  );
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.releases, ["release"]);
});

test("PageObserver escapes wait refs and validates probe results", async () => {
  const ref = 'e1"); throw new Error("injected"); //';
  const sources = [];
  let runCount = 0;
  const observer = new PageObserver({
    runJs: async (source) => {
      sources.push(source);
      if (runCount++ === 0) return { exists: true, visible: false, refText: "value", documentText: "shadow text" };
      return { exists: true, connected: true, editable: true };
    },
  });
  assert.deepEqual(await observer.probe(ref), {
    exists: true,
    visible: false,
    refText: "value",
    documentText: "shadow text",
  });
  assert.equal(sources.length, 1);
  assert.ok(sources[0].includes(JSON.stringify(ref)));
  assert.deepEqual(await observer.refState("e1"), { exists: true, connected: true, editable: true });
});

function runtimeFixture(options = {}) {
  let url = "about:blank";
  let documentId = "doc-1";
  let sequence = 0;
  const calls = [];
  const control = options.control || new BrowserControl();
  const target = {
    runJs: async () => null,
    agentPointer: () => {},
    releaseAgentPointer: () => {},
    releaseAgentInput: () => calls.push(["release"]),
    agentKeyDown: async () => {},
    agentKeyChar: () => {},
    agentKeyUp: () => {},
    agentSelectAll: async () => {},
    agentInsertText: async () => {},
    agentWheel: async () => {},
    agentNavigate: async (value) => { url = value; return value; },
    viewportSize: () => ({ width: 100, height: 80 }),
    currentUrl: () => url,
  };
  const observer = {
    observe: async () => ({ documentId, snapshot: { url, title: "", viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, elements: [], text: "" } }),
    currentDocumentId: async () => documentId,
    ensureVisible: async () => null,
    refState: async () => ({ exists: true, connected: true, editable: true }),
    probe: async () => ({ exists: true, visible: true, refText: "ready", documentText: "ready" }),
  };
  const runtime = new BrowserAgentRuntime(target, {
    control,
    observer,
    observationId: () => `obs-${++sequence}`,
    actionServiceFactory: async (driver) => options.actionServiceFactory(driver, target, calls),
  });
  return { runtime, control, calls, target, setDocumentId: (value) => { documentId = value; } };
}

test("runtime navigation uses ActionService, clears observations, and returns the current URL", async () => {
  const fixture = runtimeFixture({
    actionServiceFactory: async (_driver, target, calls) => ({
      navigate: async (value) => {
        calls.push(["navigate", value]);
        await target.agentNavigate(value);
      },
      getUrl: async () => target.currentUrl(),
    }),
  });
  const result = await fixture.runtime.navigate({ url: "about:blank", expectedControlEpoch: 1 });
  assert.deepEqual(result, { requestedUrl: "about:blank", url: "about:blank", controlEpoch: 1 });
  assert.deepEqual(fixture.calls, [["navigate", "about:blank"]]);
  assert.deepEqual(await fixture.runtime.getUrl({ expectedControlEpoch: 1 }), { url: "about:blank", controlEpoch: 1 });
});

test("runtime waitFor delegates the condition and omits the waited text from its result", async () => {
  const fixture = runtimeFixture({
    actionServiceFactory: async (_driver, _target, calls) => ({
      waitFor: async (value) => {
        calls.push(["wait", value]);
        return true;
      },
    }),
  });
  const observation = await fixture.runtime.observe();
  const result = await fixture.runtime.waitFor({
    ref: "e1",
    text: "ready",
    condition: "text",
    timeoutMs: 500,
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  assert.deepEqual(result, {
    matched: true,
    condition: "text",
    ref: "e1",
    documentId: "doc-1",
    controlEpoch: 1,
    url: "about:blank",
  });
  assert.equal(JSON.stringify(result).includes("ready"), false);
  assert.deepEqual(fixture.calls, [["wait", { ref: "e1", text: "ready", condition: "text", timeoutMs: 500 }]]);
});

test("runtime cancels a waiting operation after document invalidation", async () => {
  let started = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = runtimeFixture({
    actionServiceFactory: async () => ({
      waitFor: async () => {
        started = true;
        await gate;
        return false;
      },
    }),
  });
  const observation = await fixture.runtime.observe();
  const pending = fixture.runtime.waitFor({
    text: "ready",
    condition: "text",
    timeoutMs: 1000,
    observationId: observation.observationId,
    expectedControlEpoch: 1,
  });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  fixture.runtime.invalidateDocument();
  release();
  await assert.rejects(pending, /page changed since observation|stale or unknown observation/);
  assert.deepEqual(fixture.calls.at(-1), ["release"]);
});
