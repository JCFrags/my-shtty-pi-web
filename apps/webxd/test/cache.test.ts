import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebCache } from "../src/cache.js";

describe("WebCache", () => {
  it("reuses values, expires entries, and ignores corrupt SSD data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-"));
    const cache = new WebCache({ directory, maxMemoryEntries: 2 });
    await cache.set("search", { query: "same" }, { hits: [1] }, 60_000);
    expect(await cache.get("search", { query: "same" })).toEqual({ hits: [1] });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const [entry] = await readdir(directory);
    if (entry === undefined) throw new Error("cache file was not created");
    expect((await stat(join(directory, entry))).mode & 0o777).toBe(0o600);

    const expiring = new WebCache({ directory });
    await expiring.set("read", { url: "https://example.test" }, { text: "old" }, -1);
    expect(await expiring.get("read", { url: "https://example.test" })).toBeUndefined();

    await chmod(directory, 0o755);
    await writeFile(join(directory, entry), "not json");
    const reload = new WebCache({ directory });
    expect(await reload.get("search", { query: "same" })).toBeUndefined();
    await expect(readFile(join(directory, entry), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes old SSD entries to the configured byte target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-prune-"));
    const cache = new WebCache({ directory, maxDiskBytes: 1_000 });
    for (let index = 0; index < 100; index += 1) {
      await cache.set("search", { index }, { text: "x".repeat(200) }, 60_000);
    }
    const sizes = await Promise.all((await readdir(directory)).map(async (name) => (await stat(join(directory, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1_000);
  });
});
