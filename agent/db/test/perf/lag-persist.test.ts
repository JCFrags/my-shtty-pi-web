import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setup } from "../helpers";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const BURST_SIZE = 35;

const burstWrites = async (replica: Awaited<ReturnType<typeof setup>>["replica"]) => {
  const promises: Promise<unknown>[] = [];
  for (let i = 0; i < BURST_SIZE; i++) {
    promises.push(
      replica.postMessage({
        kind: "write",
        op: { type: "root.set", path: ["meta", `key${i}`], value: i },
      }),
    );
  }
  await Promise.all(promises);
};

describe("kyju lag-persist perf", () => {
  it("burst of 35 root.set writes completes within budget", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const start = performance.now();
    await burstWrites(ctx.replica);
    const elapsed = performance.now() - start;

    console.log(`[perf] ${BURST_SIZE} writes in ${elapsed.toFixed(1)}ms (avg ${(elapsed / BURST_SIZE).toFixed(2)}ms/write)`);

    expect(elapsed).toBeLessThan(150);
  });

  it("flush() makes pending writes durable", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await burstWrites(ctx.replica);
    await ctx.db.flush();

    const rootJson = JSON.parse(
      fs.readFileSync(path.join(ctx.dbPath, "root.json"), "utf-8"),
    );
    for (let i = 0; i < BURST_SIZE; i++) {
      expect(rootJson.meta[`key${i}`]).toBe(i);
    }
  });

  it("ordering preserved: same path written N times, last value wins on disk", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    for (let i = 0; i < 5; i++) {
      await ctx.replica.postMessage({
        kind: "write",
        op: { type: "root.set", path: ["title"], value: `v${i}` },
      });
    }
    await ctx.db.flush();

    const rootJson = JSON.parse(
      fs.readFileSync(path.join(ctx.dbPath, "root.json"), "utf-8"),
    );
    expect(rootJson.title).toBe("v4");
  });

  it("in-memory reads see writes immediately (no flush needed)", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await ctx.client.title.set("hello");
    expect(ctx.client.title.read()).toBe("hello");
  });

  it("burst writes coalesce into far fewer disk writes", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const rootPath = path.join(ctx.dbPath, "root.json");
    let writeCount = 0;
    const watcher = fs.watch(rootPath, () => {
      writeCount++;
    });

    try {
      await burstWrites(ctx.replica);
      await ctx.db.flush();
      await new Promise((r) => setTimeout(r, 50));

      console.log(`[perf] ${BURST_SIZE} writes \u2192 ${writeCount} disk events`);
      expect(writeCount).toBeLessThan(BURST_SIZE);
    } finally {
      watcher.close();
    }
  });
});
