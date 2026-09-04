const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createSlowNaturalPersona,
  createSlowNaturalPersonaProvider,
  INTERACTION_STYLE,
  SLOW_NATURAL_SPEED_FACTOR,
} = require("../dist/agent/interaction-profile.js");

function movementOptions(persona, targetWidth = 30) {
  const traits = persona.traits();
  return {
    rng: persona.rng,
    targetWidth,
    speedFactor: traits.speedFactor,
    curviness: traits.curviness,
    jitterPx: traits.jitterPx,
    overshootProb: traits.overshootProb,
    overshootMag: traits.overshootMag,
    handedness: traits.handedness,
  };
}

function fakeDriver(events) {
  return {
    snapshot: async () => ({
      url: "https://example.test/",
      title: "",
      viewport: { width: 1200, height: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      elements: [
        { ref: "button", tag: "button", role: "button", name: "Button", rect: { x: 80, y: 70, width: 100, height: 40 }, editable: false, visible: true, inViewport: true },
        { ref: "input", tag: "input", role: "textbox", name: "Input", rect: { x: 220, y: 120, width: 180, height: 40 }, editable: true, visible: true, inViewport: true },
      ],
      text: "Button Input",
    }),
    cursorState: async () => ({ x: 0, y: 0 }),
    move: async (samples) => events.push({ kind: "move", samples }),
    click: async (args) => events.push({ kind: "click", args }),
    type: async (args) => events.push({ kind: "type", args }),
    scroll: async (args) => events.push({ kind: "scroll", args }),
    navigate: async () => {},
    getUrl: async () => "https://example.test/",
    waitFor: async () => true,
    screenshot: async () => "",
    hover: async () => {},
    ensureVisible: async () => null,
    drag: async (args) => events.push({ kind: "drag", args }),
    pressKey: async () => {},
    resolveLocator: async () => { throw new Error("not used"); },
  };
}

test("slow-natural provider reuses one stable persona without flattening its identity", async () => {
  const provider = createSlowNaturalPersonaProvider({ seed: 91, now: () => 0 });
  const first = await provider();
  const second = await provider();
  const other = await createSlowNaturalPersona({ seed: 92, now: () => 0 });
  assert.strictEqual(first, second);
  assert.equal(INTERACTION_STYLE, "slow-natural");
  assert.equal(first.base.speedFactor, SLOW_NATURAL_SPEED_FACTOR);
  assert.equal(first.base.speedFactor, 0.6);
  assert.notEqual(first.base.curviness, other.base.curviness);
  assert.equal(first.base.wpm, first.info().traits.wpm);
});

test("slow-natural paths are timed, curved, multi-sample, and distance-relative", async () => {
  const { generateMove } = await import("agentcursor");
  const shortPersona = await createSlowNaturalPersona({ seed: 1234, now: () => 0 });
  const short = generateMove({ x: 0, y: 0 }, { x: 40, y: 0 }, movementOptions(shortPersona));
  const longPersona = await createSlowNaturalPersona({ seed: 1234, now: () => 0 });
  const long = generateMove({ x: 0, y: 0 }, { x: 1000, y: 120 }, movementOptions(longPersona));
  assert.ok(short.length > 8);
  assert.ok(short.at(-1).t >= 300);
  assert.ok(long.length > short.length);
  assert.ok(long.at(-1).t >= 1_000 && long.at(-1).t <= 2_200);
  assert.ok(long.at(-1).t > short.at(-1).t * 2);
  assert.deepEqual(long[0], { x: 0, y: 0, t: 0 });
  assert.deepEqual({ x: long.at(-1).x, y: long.at(-1).y }, { x: 1000, y: 120 });
  assert.ok(long.slice(1, -1).some((point) => Math.abs(point.y - point.x * 0.12) > 5));
});

test("ActionService uses one slow-natural path for click, coordinate hover, type focus, and wait drift", async () => {
  const { ActionService, flattenSchedule } = await import("agentcursor");
  const events = [];
  const persona = await createSlowNaturalPersona({ seed: 700, now: () => 0 });
  persona.base.reactionMs = 0;
  persona.base.thinkScale = 0;
  const action = new ActionService(fakeDriver(events), persona);

  await action.click({ ref: "button" });
  await action.hover({ x: 700, y: 300 });
  await action.type({ ref: "input", text: "hello" });
  await action.drag({ x: 450, y: 220 }, { x: 850, y: 420 });
  const movesBeforeWait = events.filter((event) => event.kind === "move").length;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await action.waitFor({ text: "ready", timeoutMs: 0 });
  }

  const clicks = events.filter((event) => event.kind === "click");
  const hoverMove = events.find((event) => event.kind === "move");
  const typed = events.find((event) => event.kind === "type");
  const drag = events.find((event) => event.kind === "drag");
  assert.equal(clicks.length, 2);
  assert.ok(clicks.every((event) => event.args.samples.length > 8));
  assert.ok(clicks.every((event) => event.args.samples.at(-1).t >= 300));
  assert.deepEqual(clicks[0].args.samples[0], { x: 0, y: 0, t: 0 });
  assert.deepEqual(
    { x: hoverMove.samples.at(-1).x, y: hoverMove.samples.at(-1).y },
    { x: 700, y: 300 },
  );
  assert.deepEqual(
    { x: clicks[1].args.samples[0].x, y: clicks[1].args.samples[0].y },
    { x: 700, y: 300 },
  );
  assert.ok(typed.args.schedule.length >= 5);
  assert.equal(flattenSchedule(typed.args.schedule), "hello");
  assert.deepEqual(drag.args.samples[0], { x: 450, y: 220, t: 0 });
  assert.deepEqual(
    { x: drag.args.samples.at(-1).x, y: drag.args.samples.at(-1).y },
    { x: 850, y: 420 },
  );
  assert.ok(drag.args.samples.length > 8);
  assert.ok(drag.args.samples.at(-1).t >= 600);
  assert.ok(events.filter((event) => event.kind === "move").length > movesBeforeWait);
  const drift = events.filter((event) => event.kind === "move").at(-1).samples;
  assert.ok(drift.length > 8);
  assert.ok(drift.at(-1).t >= 100);
});
