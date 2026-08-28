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

  it("evicts memory by entry and byte bounds and rejects oversized entries", async () => {
    const cache = new WebCache({ maxMemoryEntries: 3, maxMemoryBytes: 500, maxEntryBytes: 300 });
    expect(await cache.set("read", { key: 1 }, { text: "a".repeat(150) }, 60_000)).toBe(true);
    expect(await cache.set("read", { key: 2 }, { text: "b".repeat(150) }, 60_000)).toBe(true);
    expect(cache.stats().memoryBytes).toBeLessThanOrEqual(500);
    expect(cache.stats().memoryEntries).toBe(2);
    expect(await cache.set("read", { key: 3 }, { text: "c".repeat(400) }, 60_000)).toBe(false);
    expect(await cache.get("read", { key: 3 })).toBeUndefined();
  });

  it("stores a bounded disk entry even when it is larger than the memory byte budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-disk-only-"));
    const cache = new WebCache({ directory, maxMemoryBytes: 100, maxDiskBytes: 2_000, maxEntryBytes: 2_000 });
    expect(await cache.set("read", { key: "disk-only" }, { text: "x".repeat(500) }, 60_000)).toBe(true);
    expect(cache.stats()).toEqual({ memoryEntries: 0, memoryBytes: 0 });
    expect(await cache.get<{ text: string }>("read", { key: "disk-only" })).toEqual({ text: "x".repeat(500) });
    expect(cache.stats()).toEqual({ memoryEntries: 0, memoryBytes: 0 });
  });

  it("prunes old SSD entries to configured entry and byte targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-prune-"));
    const cache = new WebCache({ directory, maxDiskEntries: 3, maxDiskBytes: 1_000 });
    for (let index = 0; index < 100; index += 1) {
      await cache.set("search", { index }, { text: "x".repeat(200) }, 60_000);
    }
    const sizes = await Promise.all((await readdir(directory)).map(async (name) => (await stat(join(directory, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1_000);
    expect(sizes.length).toBeLessThanOrEqual(3);
  });

  it("bounds disk scans and refuses to grow an unbounded existing directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-scan-"));
    for (let index = 0; index < 4; index += 1) await writeFile(join(directory, `${index}.json`), "{}");
    const cache = new WebCache({ directory, maxDiskScanEntries: 3 });
    expect(await cache.set("search", { query: "bounded" }, { hits: [] }, 60_000)).toBe(false);
    expect((await readdir(directory)).length).toBeLessThanOrEqual(4);
  });

  it("does not load an oversized disk entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-cache-large-"));
    const writer = new WebCache({ directory, maxEntryBytes: 2_000 });
    await writer.set("read", { url: "https://large.test" }, { text: "x".repeat(500) }, 60_000);
    const [name] = await readdir(directory);
    expect(name).toBeDefined();
    if (name === undefined) throw new Error("cache entry was not written");
    await writeFile(join(directory, name), "x".repeat(501));
    const bounded = new WebCache({ directory, maxEntryBytes: 500 });
    expect(await bounded.get("read", { url: "https://large.test" })).toBeUndefined();
    await expect(stat(join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
