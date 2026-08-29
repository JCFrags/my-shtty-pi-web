import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserArtifactStore } from "../src/artifacts/store.js";
import { validateExtraFlags } from "../src/chrome/host.js";
import { OperationRegistry } from "../src/operations/registry.js";
import { createPersona, generateMove } from "../src/vendor/agentcursor/index.js";

const actor = { principalId: "owner:test", agentSessionId: "agent:test" } as const;
const other = { principalId: "owner:other", agentSessionId: "agent:other" } as const;
function deadline(ms = 5_000): string { return new Date(Date.now() + ms).toISOString(); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe("AgentCursor selective port", () => {
  it("generates deterministic seeded, sampled, non-teleporting paths", () => {
    const a = createPersona(1234, { now: () => 0 });
    const b = createPersona(1234, { now: () => 0 });
    const optionsA = { rng: a.rng, ...a.traits() };
    const optionsB = { rng: b.rng, ...b.traits() };
    const first = generateMove({ x: 10, y: 20 }, { x: 700, y: 500 }, optionsA);
    const second = generateMove({ x: 10, y: 20 }, { x: 700, y: 500 }, optionsB);
    assert.deepEqual(first, second);
    assert.ok(first.length >= 9);
    assert.deepEqual(first[0], { x: 10, y: 20, t: 0 });
    assert.equal(first.at(-1)?.x, 700);
    for (let index = 1; index < first.length; index++) {
      assert.ok(first[index]!.t > first[index - 1]!.t);
      assert.ok(Math.hypot(first[index]!.x - first[index - 1]!.x, first[index]!.y - first[index - 1]!.y) < 200);
    }
  });
});

describe("bounded actor-scoped operations", () => {
  it("does not strand a request submitted as the prior result settles", async () => {
    const registry = new OperationRegistry();
    registry.submit(actor, { operationId: "operation:first", laneKey: "race", deadline: deadline() }, async () => "first");
    await registry.wait(actor, "operation:first");
    registry.submit(actor, { operationId: "operation:second", laneKey: "race", deadline: deadline() }, async () => "second");
    assert.equal((await registry.wait(actor, "operation:second")).state, "committed");
  });

  it("cancels queued work without dispatch and hides it from another actor", async () => {
    const registry = new OperationRegistry();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    registry.submit(actor, { operationId: "operation:held", laneKey: "lane", deadline: deadline() }, async () => await held);
    registry.submit(actor, { operationId: "operation:queued", laneKey: "lane", deadline: deadline() }, async (context) => { context.markDispatched(); });
    assert.equal(registry.cancel(actor, "operation:queued").state, "cancelled");
    assert.equal(registry.status(actor, "operation:queued").dispatchState, "not-dispatched");
    assert.throws(() => registry.status(other, "operation:queued"), /not found/i);
    release();
    assert.equal((await registry.wait(actor, "operation:held")).state, "committed");
  });

  it("preserves dispatched truth after cancellation and ignores a late result", async () => {
    const registry = new OperationRegistry();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    registry.submit(actor, { operationId: "operation:click", laneKey: "click", deadline: deadline() }, async (context) => { context.markDispatched(); await held; return "late"; });
    while (registry.status(actor, "operation:click").dispatchState !== "dispatched") await sleep(1);
    registry.cancel(actor, "operation:click");
    release();
    await sleep(5);
    const status = registry.status(actor, "operation:click");
    assert.equal(status.state, "cancelled");
    assert.equal(status.dispatchState, "dispatched");
  });

  it("cancels prior epochs and prevents an agent-user-agent ABA revival", async () => {
    const registry = new OperationRegistry();
    registry.submit(actor, { operationId: "operation:aba", laneKey: "aba", deadline: deadline(), browserSessionId: "session:aba", controlEpoch: 1 }, async (context) => { while (true) { context.checkpoint(); await sleep(2); } });
    assert.equal(registry.incrementEpoch(actor, "session:aba"), 2);
    assert.equal(registry.incrementEpoch(actor, "session:aba"), 3);
    assert.equal((await registry.wait(actor, "operation:aba")).state, "cancelled");
    assert.throws(() => registry.submit(actor, { operationId: "operation:old", laneKey: "aba", deadline: deadline(), browserSessionId: "session:aba", controlEpoch: 1 }, async () => undefined), /stale/i);
  });

  it("expires work while it waits in a lane", async () => {
    const registry = new OperationRegistry();
    registry.submit(actor, { operationId: "operation:block", laneKey: "deadline", deadline: deadline(1_000) }, async () => { await sleep(80); });
    registry.submit(actor, { operationId: "operation:expires", laneKey: "deadline", deadline: deadline(30) }, async (context) => { context.markDispatched(); });
    assert.equal((await registry.wait(actor, "operation:expires")).state, "expired");
    assert.equal(registry.status(actor, "operation:expires").dispatchState, "not-dispatched");
  });
});

describe("artifacts and Chrome configuration", () => {
  it("keeps artifacts bounded and owner-scoped", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 2, maxTotalBytes: 8, maxItemBytes: 4 });
    const one = await store.put(actor, Uint8Array.of(1, 2, 3, 4), "image/png");
    await store.put(actor, Uint8Array.of(5, 6, 7, 8), "image/png");
    await assert.rejects(() => store.read(other, one.artifactId), /not found/i);
    await assert.rejects(() => store.put(actor, Uint8Array.of(1, 2, 3, 4, 5), "image/png"), /size/i);
    assert.equal(store.entryCount, 2);
    assert.equal(store.totalBytes, 8);
  });

  it("permits only reviewed Chrome flags", () => {
    assert.deepEqual(validateExtraFlags(["--ozone-platform=wayland"]), ["--ozone-platform=wayland"]);
    assert.throws(() => validateExtraFlags(["--no-sandbox"]), /not allowed/i);
    assert.throws(() => validateExtraFlags(["--ignore-certificate-errors"]), /not allowed/i);
  });
});
