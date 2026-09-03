const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  AgentOverlayRenderCoalescer,
  agentOverlayEnabled,
  agentOverlayGeometry,
  mapAgentCssPoint,
} = require("../dist/ui/agent-overlay.js");

const layout = { x: 10, y: 20, width: 100, height: 80, scale: 2 };

test("agent overlay maps CSS points through the active surface scale", () => {
  assert.deepEqual(mapAgentCssPoint({ x: 5, y: 7 }, layout), { x: 20, y: 34 });
  assert.deepEqual(
    mapAgentCssPoint({ x: 1.25, y: 2.5 }, { x: 3, y: 4, width: 100, height: 80, scale: 1.5 }),
    { x: 5, y: 8 },
  );
  assert.deepEqual(
    agentOverlayGeometry({
      cursor: { x: 5, y: 7 },
      target: { x: 45, y: 30 },
      pulse: true,
    }, layout),
    {
      cursor: { x: 20, y: 34 },
      target: { x: 100, y: 80 },
    },
  );
});

test("agent overlay clips cursor and target centers to the page surface", () => {
  assert.deepEqual(
    agentOverlayGeometry({
      cursor: { x: -20, y: -5 },
      target: { x: 90, y: 60 },
      pulse: false,
    }, layout),
    {
      cursor: { x: 10, y: 20 },
      target: { x: 110, y: 100 },
    },
  );
});

test("agent overlay suppression is independent from control enforcement", () => {
  assert.equal(agentOverlayEnabled(false), true);
  assert.equal(agentOverlayEnabled(true), false);
});

test("agent overlay render requests coalesce until the scheduled frame", () => {
  const queued = [];
  let renders = 0;
  const coalescer = new AgentOverlayRenderCoalescer(
    (callback) => queued.push(callback),
    () => { renders += 1; },
  );
  coalescer.request();
  coalescer.request();
  coalescer.request();
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(renders, 1);
  coalescer.request();
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(renders, 2);
  coalescer.dispose();
  coalescer.request();
  assert.equal(queued.length, 0);
});
