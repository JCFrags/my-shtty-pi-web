const assert = require("node:assert/strict");
const { test } = require("node:test");

const { BrowserControl } = require("../dist/agent/control.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("BrowserControl starts in agent state at epoch one", () => {
  const control = new BrowserControl();
  assert.deepEqual(control.snapshot, {
    state: "agent",
    controlEpoch: 1,
    reason: null,
    busy: false,
    interactionStyle: "slow-natural",
  });
});

test("BrowserControl changes epoch only for real transitions", () => {
  const order = [];
  const control = new BrowserControl({
    beforeResume: () => order.push("release"),
    onTransition: () => order.push("transition"),
  });
  assert.deepEqual(control.takeHuman("pointer"), {
    state: "human",
    controlEpoch: 2,
    reason: "pointer",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.deepEqual(control.takeHuman("keyboard"), {
    state: "human",
    controlEpoch: 2,
    reason: "pointer",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.deepEqual(control.pause(2), {
    state: "paused",
    controlEpoch: 3,
    reason: "manual-pause",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.deepEqual(control.pause(3), {
    state: "paused",
    controlEpoch: 3,
    reason: "manual-pause",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.deepEqual(control.resume(3), {
    state: "agent",
    controlEpoch: 4,
    reason: "manual-resume",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.deepEqual(order, ["transition", "transition", "release", "transition"]);
  assert.deepEqual(control.resume(4), {
    state: "agent",
    controlEpoch: 4,
    reason: "manual-resume",
    busy: false,
    interactionStyle: "slow-natural",
  });
  assert.throws(() => control.pause(3), /stale control epoch/);
});

test("BrowserControl serializes mutations and clears busy after takeover", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const control = new BrowserControl();
  const first = control.runMutation(1, async () => {
    events.push("first-start");
    await firstGate;
    control.assertAgent(1);
    events.push("first-end");
    return "first";
  });
  await tick();
  assert.equal(control.snapshot.busy, true);
  const second = control.runMutation(1, async () => {
    events.push("second");
    return "second";
  });
  await tick();
  assert.deepEqual(events, ["first-start"]);

  control.takeHuman("pointer");
  releaseFirst();
  await assert.rejects(first, /stale control epoch|agent control is human/);
  await assert.rejects(second, /stale control epoch/);
  assert.equal(control.snapshot.busy, false);
  assert.deepEqual(events, ["first-start"]);
});

test("BrowserControl does not mark queued mutations busy before their turn", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const control = new BrowserControl();
  const first = control.runMutation(1, () => firstGate);
  const second = control.runMutation(1, async () => "second");
  await tick();
  assert.equal(control.snapshot.busy, true);
  releaseFirst();
  assert.equal(await first, undefined);
  assert.equal(await second, "second");
  assert.equal(control.snapshot.busy, false);
});
