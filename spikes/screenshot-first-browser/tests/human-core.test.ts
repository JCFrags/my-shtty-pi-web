import assert from "node:assert/strict";
import test from "node:test";
import { generateMove } from "../src/agentcursor/path-engine/index.js";
import { createRng } from "../src/agentcursor/path-engine/rng.js";
import { createPersona } from "../src/agentcursor/persona/index.js";
import { flattenSchedule } from "../src/agentcursor/persona/typing.js";

test("ported AgentCursor path is deterministic, sampled, curved, and monotonic", () => {
  const first = generateMove({ x: 10, y: 20 }, { x: 600, y: 400 }, { rng: createRng(42), overshootProb: 1 });
  const second = generateMove({ x: 10, y: 20 }, { x: 600, y: 400 }, { rng: createRng(42), overshootProb: 1 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 20);
  assert.deepEqual(first[0], { x: 10, y: 20, t: 0 });
  assert.equal(first.at(-1)?.x, 600);
  assert.equal(first.at(-1)?.y, 400);
  assert.ok(first.every((sample, index) => {
    const previous = first[index - 1];
    return index === 0 || (previous !== undefined && sample.t > previous.t);
  }));
  assert.ok(first.some((sample) => Math.abs((sample.y - 20) / 380 - (sample.x - 10) / 590) > 0.01));
});

test("persona seed persists stable traits and exact net typing", () => {
  const first = createPersona(1234, { now: () => 0 });
  const second = createPersona(1234, { now: () => 0 });
  assert.deepEqual(first.base, second.base);
  assert.equal(first.seed, 1234);
  assert.equal(flattenSchedule(first.keySchedule("isolated text")), "isolated text");
  first.tick();
  assert.equal(first.info().actionCount, 1);
});
