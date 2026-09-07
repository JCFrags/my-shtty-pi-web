import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { PiBrowserClient } from "../dist/client.js";

const context = { cwd: "/tmp/project", sessionId: "session-a" };

function fixtureObservation(epoch = 4) {
  return {
    contextId: 7,
    observationId: "obs-a",
    controlEpoch: epoch,
    snapshot: {
      url: "file:///tmp/fixture.html",
      title: "Fixture",
      viewport: { width: 800, height: 600 },
      elements: [{ ref: "e1", role: "button", name: "Go" }],
      text: "ready",
    },
  };
}

test("open and tab results are bounded and hide browser implementation identifiers", async () => {
  const tabs = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    url: `https://example.test/${index}`,
    title: `Tab ${index}`,
    active: index === 0,
    targetId: `target-${index}`,
  }));
  const client = new PiBrowserClient(async () => ({ action: "reused", key: "secret-key", pane: "w1:p9", tabs }));
  const value = await client.open(context, {});
  assert.equal(value.action, "reused");
  assert.equal(value.tabs.length, 32);
  assert.equal(JSON.stringify(value).includes("secret-key"), false);
  assert.equal(JSON.stringify(value).includes("target-"), false);
  assert.equal(JSON.stringify(value).includes("w1:p9"), false);
});

test("visual observations use a private image file and return native image data separately", async () => {
  const calls = [];
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[0] === "companion") return { tabs: [{ id: 7, active: true, url: "about:blank", title: "" }] };
    const outputAt = args.indexOf("--image-output");
    assert.notEqual(outputAt, -1);
    await writeFile(args[outputAt + 1], Buffer.from("png-bytes"));
    return {
      ...fixtureObservation(),
      visual: { mimeType: "image/png", width: 10, height: 8, bytes: 9, scope: "viewport", rect: { x: 100, y: 50, width: 200, height: 80 } },
    };
  });
  const value = await client.observe(context, { view: "both" });
  assert.equal(value.image.mimeType, "image/png");
  assert.equal(value.image.data, Buffer.from("png-bytes").toString("base64"));
  assert.equal(JSON.stringify({ ...value, image: undefined }).includes(value.image.data), false);
  assert.equal(calls[0].includes(value.image.data), false);
});

test("visual image coordinates are mapped to current CSS geometry for drag", async () => {
  const calls = [];
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[0] === "companion") return { tabs: [{ id: 7, active: true }] };
    if (args[1] === "status") return { state: "agent", controlEpoch: 4, reason: null, busy: false };
    if (args[1] === "observe") {
      const outputAt = args.indexOf("--image-output");
      await writeFile(args[outputAt + 1], Buffer.from("png"));
      return {
        ...fixtureObservation(),
        visual: { mimeType: "image/png", width: 100, height: 50, bytes: 3, scope: "element", rect: { x: 20, y: 30, width: 200, height: 100 } },
      };
    }
    return { operation: "drag" };
  });
  await client.observe(context, { view: "visual", scope: "element", ref: "e1" });
  await client.act(context, {
    action: "drag", from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, button: "left",
  });
  const drag = calls.find((args) => args[1] === "drag");
  assert.deepEqual(drag.slice(2, 10), ["--from-x", "20", "--from-y", "30", "--to-x", "220", "--to-y", "130"]);
});

test("observation and epoch are supplied automatically and invalidated after mutation", async () => {
  const calls = [];
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[0] === "companion") return { tabs: [{ id: 7, active: true, url: "about:blank", title: "" }] };
    if (args[1] === "observe") return fixtureObservation();
    if (args[1] === "status") return { state: "agent", controlEpoch: 4, reason: null, busy: false };
    if (args[1] === "click") return { operation: "click" };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  await client.observe(context);
  await client.act(context, { action: "click", ref: "e1" });
  const click = calls.find((args) => args[1] === "click");
  assert.equal(click[click.indexOf("--tab") + 1], "7");
  assert.equal(click.includes("--observation"), true);
  assert.equal(click.includes("obs-a"), true);
  assert.equal(click.includes("--control-epoch"), true);
  assert.equal(click.includes("4"), true);
  await assert.rejects(() => client.act(context, { action: "click", ref: "e1" }), /browser_observe/);
});

test("typed text is sent through stdin instead of process arguments", async () => {
  const calls = [];
  const client = new PiBrowserClient(async (request) => {
    calls.push(request);
    if (request.args[0] === "companion") return { tabs: [{ id: 1, active: true }] };
    if (request.args[1] === "observe") return fixtureObservation(1);
    if (request.args[1] === "status") return { state: "agent", controlEpoch: 1, reason: null, busy: false };
    return { operation: "type" };
  });
  await client.observe(context);
  await client.act(context, { action: "type", ref: "e1", text: "private words", replace: true });
  const typed = calls.find((request) => request.args[1] === "type");
  assert.equal(typed.stdin, "private words");
  assert.equal(typed.args.includes("private words"), false);
});

test("human takeover blocks actions with an actionable control error", async () => {
  const client = new PiBrowserClient(async () => ({ state: "human", controlEpoch: 9, reason: "pointer", busy: false }));
  await assert.rejects(() => client.act(context, { action: "get_url" }), /control is with the user/);
});

test("resume uses the current epoch and refreshes observation before the next mutation", async () => {
  const calls = [];
  let statusCount = 0;
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[1] === "status") {
      statusCount += 1;
      return { state: statusCount === 1 ? "paused" : "agent", controlEpoch: statusCount === 1 ? 2 : 3, reason: null, busy: false };
    }
    if (args[1] === "resume") return { state: "agent", controlEpoch: 3, reason: "manual-resume", busy: false };
    if (args[1] === "observe") return fixtureObservation(3);
    if (args[0] === "companion") return { tabs: [{ id: 1, active: true }] };
    if (args[1] === "press-key") return { operation: "press-key" };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const resumed = await client.control(context, "resume");
  assert.equal(resumed.observationReady, true);
  await client.act(context, { action: "press_key", key: "Enter" });
  assert.equal(calls.some((args) => args[1] === "resume" && args.includes("2")), true);
  assert.equal(calls.some((args) => args[1] === "press-key" && args.includes("obs-a")), true);
});

test("dialog observations do not require a screenshot file or page evaluation", async () => {
  const dialog = { id: "dialog-1", contextId: 9, controlEpoch: 4, type: "prompt", message: "Name?", defaultValue: "" };
  const client = new PiBrowserClient(async () => ({ contextId: 9, dialog, completed: false }));
  const result = await client.observe(context, { view: "visual", contextId: 9 });
  const { controlEpoch, ...visibleDialog } = dialog;
  assert.deepEqual(result, { contextId: 9, dialog: visibleDialog, completed: false });
});

test("dialog response sends exact context and epoch, with prompt text only through stdin", async () => {
  const calls = [];
  const client = new PiBrowserClient(async request => {
    calls.push(request);
    if (request.args[1] === "observe") return { dialog: { id: "dialog-7", contextId: 7, controlEpoch: 8, type: "prompt" } };
    return request.args[1] === "status" ? { state: "agent", controlEpoch: 8 } : { completed: true, controlEpoch: 8 };
  });
  await client.observe(context);
  await assert.rejects(client.act(context, { action: "dialog", contextId: 9, dialogId: "dialog-7", accept: true }), /unknown dialog/);
  await assert.rejects(client.act(context, { action: "dialog", dialogId: "unknown", accept: true }), /unknown dialog/);
  const result = await client.act(context, { action: "dialog", dialogId: "dialog-7", accept: true, text: "private prompt text" });
  assert.deepEqual(result, { contextId: 7, completed: true });
  const request = calls.at(-1);
  assert.equal(request.stdin, "private prompt text");
  assert.equal(request.args.includes("private prompt text"), false);
  assert.deepEqual(request.args.slice(0, 8), ["agent", "dialog", "--tab", "7", "--dialog-id", "dialog-7", "--control-epoch", "8"]);
  await assert.rejects(client.act(context, { action: "dialog", dialogId: "dialog-7", accept: true }), /unknown dialog/);
  assert.equal(calls.filter(request => request.args[1] === "dialog").length, 1);
});

test("context activation clears observation and routes subsequent observation explicitly", async () => {
  const calls = [];
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[0] === "companion") return { tabs: [{ id: 9, contextId: 9, openerId: 7, kind: "popup", active: true }] };
    if (args[1] === "status") return { state: "agent", controlEpoch: 4 };
    return { ...fixtureObservation(), contextId: 9 };
  });
  await client.tabs(context, { action: "activate", contextId: 9 });
  await assert.rejects(client.act(context, { action: "click", ref: "e1" }), /browser_observe/);
  await client.observe(context);
  assert.equal(calls.at(-1)[calls.at(-1).indexOf("--tab") + 1], "9");
});

for (const source of ["tabs", "resume", "action"]) {
  test(`${source} caches dialog identity without exposing epochs`, async () => {
    const calls = [];
    const dialog = { id: "pending", contextId: 9, controlEpoch: 4, type: "confirm", message: "Continue?" };
    const client = new PiBrowserClient(async ({ args }) => {
      calls.push(args);
      if (args[1] === "status") return { state: "agent", controlEpoch: 4 };
      if (args[1] === "dialog") return { completed: true };
      return { contextId: 7, dialog, tabs: [{ id: 7, active: true }] };
    });
    const value = source === "tabs" ? await client.tabs(context, { action: "list" })
      : source === "resume" ? await client.control(context, "resume")
      : await client.act(context, { action: "navigate", url: "about:blank" });
    assert.equal(JSON.stringify(value).includes("controlEpoch"), false);
    assert.equal(value.dialog.id, "pending");
    await client.act(context, { action: "dialog", dialogId: "pending", accept: false });
    assert.deepEqual(calls.at(-1), ["agent", "dialog", "--tab", "9", "--dialog-id", "pending", "--control-epoch", "4", "--dismiss"]);
  });
}

for (const change of ["epoch", "human", "pause", "open", "activate", "observe", "navigate"]) {
  test(`${change} invalidates cached dialog responses`, async () => {
    let epoch = 4;
    let state = "agent";
    let pending = true;
    const calls = [];
    const client = new PiBrowserClient(async ({ args }) => {
      calls.push(args);
      if (args[1] === "status" || args[1] === "pause") return { state, controlEpoch: epoch };
      if (args[1] === "observe") return pending
        ? { dialog: { id: "pending", contextId: 7, controlEpoch: epoch } } : fixtureObservation(epoch);
      return { tabs: [{ id: 9, active: true }] };
    });
    await client.observe(context);
    if (change === "epoch") epoch++;
    if (change === "human") {
      state = "human";
      assert.equal(JSON.stringify(await client.control(context, "status")).includes("controlEpoch"), false);
      state = "agent";
    }
    if (change === "pause") assert.equal(JSON.stringify(await client.control(context, "pause")).includes("controlEpoch"), false);
    if (change === "open") await client.open(context, {});
    if (change === "activate") await client.tabs(context, { action: "activate", contextId: 9 });
    if (change === "observe") { pending = false; await client.observe(context); }
    if (change === "navigate") await client.act(context, { action: "navigate", url: "about:blank" });
    await assert.rejects(client.act(context, { action: "dialog", dialogId: "pending", accept: true }), /unknown dialog/);
    assert.equal(calls.some(args => args[1] === "dialog"), false);
  });
}

test("takeover recovery refreshes the same pending identity with the new internal epoch", async () => {
  let epoch = 4;
  let state = "agent";
  const calls = [];
  const client = new PiBrowserClient(async ({ args }) => {
    calls.push(args);
    if (args[1] === "resume") { state = "agent"; epoch++; }
    if (["status", "resume"].includes(args[1])) return { state, controlEpoch: epoch };
    if (args[1] === "observe") return { dialog: { id: "pending", contextId: 9, controlEpoch: epoch } };
    return { completed: true };
  });
  await client.observe(context);
  state = "human";
  epoch++;
  await assert.rejects(client.act(context, { action: "dialog", dialogId: "pending", accept: true }), /control is with the user/);
  const resumed = await client.control(context, "resume");
  assert.equal(resumed.observationReady, false);
  assert.equal(JSON.stringify(resumed).includes("controlEpoch"), false);
  await client.act(context, { action: "dialog", dialogId: resumed.dialog.id, accept: true });
  assert.equal(calls.at(-1)[calls.at(-1).indexOf("--control-epoch") + 1], "6");
});

test("uncached and replaced dialog IDs never reach the CLI", async () => {
  let id = "first";
  let responses = 0;
  const client = new PiBrowserClient(async ({ args }) => {
    if (args[1] === "status") return { state: "agent", controlEpoch: 4 };
    if (args[1] === "dialog") { responses++; return { completed: true }; }
    return { dialog: { id, contextId: 7, controlEpoch: 4 } };
  });
  await assert.rejects(client.act(context, { action: "dialog", dialogId: id, accept: true }), /unknown dialog/);
  await client.observe(context);
  id = "second";
  await client.observe(context);
  await assert.rejects(client.act(context, { action: "dialog", dialogId: "first", accept: true }), /unknown dialog/);
  assert.equal(responses, 0);
  await client.act(context, { action: "dialog", dialogId: id, accept: false });
  assert.equal(responses, 1);
});
