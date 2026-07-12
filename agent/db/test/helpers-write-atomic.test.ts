import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Effect } from "effect";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as FileSystem from "@effect/platform/FileSystem";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import {
  cleanupStaleTmpFiles,
  readJsonFile,
  writeJsonFile,
  type DbConfig,
} from "../src/v2/db/helpers";

/**
 * Tests for the atomic JSON write helper used to persist `root.json`
 * (and other DB metadata). Pre-atomic: a process kill mid-write left
 * the file truncated to zero bytes, then every subsequent boot crashed
 * with `SyntaxError: Unexpected end of JSON input` from `JSON.parse`.
 *
 * The atomic implementation stages writes in `config.tmpDir`
 * (`<dbPath>/.tmp/`) and renames to the destination — `rename(2)` is
 * atomic within a filesystem, so readers see either the old contents or
 * the new, never partial.
 *
 * The dedicated `.tmp/` directory (vs sibling `.tmp-<id>` files scattered
 * beside every destination) keeps startup recovery O(pending-writes): one
 * readdir of `.tmp/`, delete everything there.
 */

const runFs = <A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)) as any) as Promise<A>;

let dir: string;
let cfg: DbConfig;
beforeEach(() => {
  dir = path.join(os.tmpdir(), `kyju-helpers-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = path.join(dir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  // Only fields writeJsonFile actually reads — dbPath + tmpDir.
  cfg = {
    dbPath: dir,
    tmpDir,
    rootName: "root",
    collectionsDirName: "collections",
    collectionIndexName: "index",
    pagesDirName: "pages",
    pageIndexName: "index",
    pageDataName: "data",
    blobsDirName: "blobs",
    blobIndexName: "index",
    blobDataName: "data",
    maxPageSize: 1024 * 1024,
    checkReferences: false,
  };
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("writeJsonFile", () => {
  it("writes JSON that round-trips through readJsonFile", async () => {
    const target = path.join(dir, "root.json");
    const data = { a: 1, b: [2, 3], c: { d: "x" } };
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({ fs, config: cfg, path: target, data });
      }),
    );

    const round = await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* readJsonFile({ fs, path: target });
      }),
    );
    expect(round).toEqual(data);
  });

  it("does not leave a tmp file behind on success", async () => {
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({
          fs,
          config: cfg,
          path: target,
          data: { ok: true },
        });
      }),
    );
    // After successful write, tmpDir should be empty — the staged file was
    // renamed over the destination.
    expect(fs.readdirSync(cfg.tmpDir)).toEqual([]);
    // And no stray files appear beside the destination either.
    expect(fs.readdirSync(dir).filter((n) => n !== ".tmp").sort()).toEqual([
      "root.json",
    ]);
  });

  it("never leaves the destination empty (rename is atomic)", async () => {
    // Simulate the failure mode that motivated atomicity: a process is
    // killed *between* truncation and write completion. With a non-atomic
    // `writeFileString` the destination is empty until the write
    // finishes; with the rename-over-tmp pattern the destination either
    // doesn't exist yet or contains the previous full contents.
    const target = path.join(dir, "root.json");

    // Seed a previous good payload.
    fs.writeFileSync(target, JSON.stringify({ version: 1, data: "old" }));
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      version: 1,
      data: "old",
    });

    const writePromise = runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({
          fs,
          config: cfg,
          path: target,
          data: { version: 2, data: "new".repeat(10000) },
        });
      }),
    );

    // Race a few reads against the write — every observation must be
    // valid JSON, never empty.
    const observations: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        observations.push(fs.readFileSync(target, "utf-8"));
      } catch {}
      await new Promise((r) => setImmediate(r));
    }
    await writePromise;
    observations.push(fs.readFileSync(target, "utf-8"));

    for (const content of observations) {
      expect(content.length).toBeGreaterThan(0);
      JSON.parse(content);
    }

    const final = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(final.version).toBe(2);
  });

  it("overwrites existing files cleanly", async () => {
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({ fs, config: cfg, path: target, data: { v: 1 } });
        yield* writeJsonFile({ fs, config: cfg, path: target, data: { v: 2 } });
        yield* writeJsonFile({ fs, config: cfg, path: target, data: { v: 3 } });
      }),
    );
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ v: 3 });
    expect(fs.readdirSync(cfg.tmpDir)).toEqual([]);
  });

  it("cleanupStaleTmpFiles reclaims everything in tmpDir", async () => {
    // Simulate orphans left behind by a hard-killed previous process.
    // Anything in tmpDir is by definition orphaned at startup — a successful
    // write would have renamed its file away.
    fs.writeFileSync(path.join(cfg.tmpDir, "root.json-abc12345"), "partial1");
    fs.writeFileSync(path.join(cfg.tmpDir, "index.json-def67890"), "partial2");
    fs.writeFileSync(path.join(cfg.tmpDir, "anything-at-all"), "partial3");

    // Files outside tmpDir must NOT be touched.
    fs.writeFileSync(path.join(dir, "root.json"), "{}");
    fs.writeFileSync(path.join(dir, "real-data.json"), "{}");
    const sub = path.join(dir, "collections", "messages");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "index.json"), "{}");

    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cleanupStaleTmpFiles(fs, cfg.tmpDir);
      }),
    );

    // tmpDir drained.
    expect(fs.readdirSync(cfg.tmpDir)).toEqual([]);
    // Non-tmp files preserved.
    expect(fs.readdirSync(dir).sort()).toEqual([
      ".tmp",
      "collections",
      "real-data.json",
      "root.json",
    ]);
    expect(fs.readdirSync(sub)).toEqual(["index.json"]);
  });

  it("cleanupStaleTmpFiles is a no-op when tmpDir doesn't exist", async () => {
    const missing = path.join(dir, "missing-tmp");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cleanupStaleTmpFiles(fs, missing);
      }),
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("uses unique tmp paths so concurrent writes don't clobber each other", async () => {
    // If two writes raced through a fixed filename one could rename a
    // partial of the other. nanoid suffixes prevent that.
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.all(
          [
            writeJsonFile({ fs, config: cfg, path: target, data: { who: "a" } }),
            writeJsonFile({ fs, config: cfg, path: target, data: { who: "b" } }),
            writeJsonFile({ fs, config: cfg, path: target, data: { who: "c" } }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    const final = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(["a", "b", "c"]).toContain(final.who);
    expect(fs.readdirSync(cfg.tmpDir)).toEqual([]);
  });
});
