import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ContentEntryTooLargeError, NormalizedContentStore } from "../src/content-store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function ids() {
  let sequence = 0;
  return () => `cnt_${(++sequence).toString(36).padStart(32, "a")}`;
}

const input = (content: string) => ({
  ownerPrincipalId: "owner", title: "Title", url: "https://example.test/page",
  requestedUrl: "https://example.test/page", finalUrl: "https://example.test/page",
  representation: "canonical-normalized" as const, sourceOffset: 0, sourceComplete: true, nextSourceOffset: null,
  extractor: "test", mediaType: "text/markdown", content,
});

describe("NormalizedContentStore", () => {
  it("enforces entry and UTF-8 byte bounds with oldest insertion eviction", async () => {
    const store = new NormalizedContentStore({ maxEntries: 2, maxBytes: 8, maxItemBytes: 6, retentionMs: 1_000, nextId: ids() });
    const first = await store.put(input("1234"));
    const second = await store.put(input("56"));
    const third = await store.put(input("789"));
    expect(await store.get(first.contentId, "owner")).toBeUndefined();
    expect(await store.get(second.contentId, "owner")).toBeDefined();
    expect(await store.get(third.contentId, "owner")).toBeDefined();
    expect(await store.stats()).toEqual({ entries: 2, bytes: 5 });
    await expect(store.put(input("🙂🙂"))).rejects.toBeInstanceOf(ContentEntryTooLargeError);
  });

  it("expires records and prunes expired and over-bound files at startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-content-"));
    directories.push(directory);
    let now = 100;
    const first = new NormalizedContentStore({ directory, maxEntries: 3, maxBytes: 100, maxItemBytes: 100, retentionMs: 10, now: () => now, nextId: ids() });
    const expired = await first.put(input("expired"));
    now = 111;
    expect(await first.get(expired.contentId, "owner")).toBeUndefined();

    now = 200;
    const persisted = await first.put(input("persisted"));
    const restarted = new NormalizedContentStore({ directory, maxEntries: 1, maxBytes: 100, maxItemBytes: 100, retentionMs: 10, now: () => now, nextId: ids() });
    expect(await restarted.get(persisted.contentId, "other-owner")).toBeUndefined();
    expect(await restarted.get(persisted.contentId, "owner")).toMatchObject({ content: "persisted" });
  });

  it("accepts the one-million-code-point source bound at worst-case UTF-8 size", async () => {
    const store = new NormalizedContentStore({ nextId: ids() });
    const record = await store.put(input("🙂".repeat(1_000_000)));
    expect(record.sizeBytes).toBe(4_000_000);
    expect(await store.stats()).toEqual({ entries: 1, bytes: 4_000_000 });
  });

  it("bounds startup candidates, checks file sizes, and prunes invalid and excess files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-content-startup-"));
    directories.push(directory);
    const oldId = `cnt_${"a".repeat(32)}`;
    const newId = `cnt_${"b".repeat(32)}`;
    const record = (contentId: string, content: string, createdAt: number) => ({
      recordVersion: 2, contentId, ownerPrincipalId: "owner", title: "Title", url: "https://example.test/page",
      requestedUrl: "https://example.test/page", finalUrl: "https://example.test/page", representation: "canonical-normalized",
      sourceOffset: 0, sourceComplete: true, nextSourceOffset: null, extractor: "test", mediaType: "text/markdown",
      contentSha256: createHash("sha256").update(content).digest("hex"), content, createdAt, expiresAt: 1_000, sizeBytes: Buffer.byteLength(content),
    });
    await writeFile(join(directory, `${oldId}.json`), JSON.stringify(record(oldId, "old", 10)));
    await writeFile(join(directory, `${newId}.json`), JSON.stringify(record(newId, "new", 20)));
    await writeFile(join(directory, `cnt_${"c".repeat(32)}.json`), "{");
    await writeFile(join(directory, `cnt_${"d".repeat(32)}.json`), "x".repeat(70_000));

    const store = new NormalizedContentStore({ directory, maxEntries: 1, maxBytes: 10, maxItemBytes: 10, now: () => 100, startupScanLimit: 4, nextId: ids() });
    expect(await store.stats()).toEqual({ entries: 1, bytes: 3 });
    expect(await store.get(newId, "owner")).toMatchObject({ content: "new" });
    expect(await readdir(directory)).toEqual([`${newId}.json`]);
  });

  it("invalidates legacy records that do not contain canonical provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webx-content-legacy-"));
    directories.push(directory);
    const contentId = `cnt_${"l".repeat(32)}`;
    await writeFile(join(directory, `${contentId}.json`), JSON.stringify({
      contentId, ownerPrincipalId: "owner", title: "Legacy", url: "https://example.test/legacy",
      content: "legacy projection", createdAt: 10, expiresAt: 1_000, sizeBytes: 17,
    }));
    const store = new NormalizedContentStore({ directory, now: () => 100, nextId: ids() });
    expect(await store.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects non-positive and non-finite limits", () => {
    expect(() => new NormalizedContentStore({ maxBytes: 0 })).toThrow(/positive finite integer/u);
    expect(() => new NormalizedContentStore({ maxEntries: Number.POSITIVE_INFINITY })).toThrow(/positive finite integer/u);
    expect(() => new NormalizedContentStore({ maxItemBytes: -1 })).toThrow(/positive finite integer/u);
    expect(() => new NormalizedContentStore({ retentionMs: Number.NaN })).toThrow(/positive finite integer/u);
    expect(() => new NormalizedContentStore({ startupScanLimit: 0 })).toThrow(/positive finite integer/u);
  });
});
