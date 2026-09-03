import assert from "node:assert/strict";
import test from "node:test";

import { PiBrowserClient } from "../dist/client.js";

const context = { cwd: "/tmp/project", sessionId: "session-a" };

function fixtureObservation(epoch = 4) {
  return {
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
