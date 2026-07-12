/**
 * Cross-process write race protection: kyju must hold an exclusive lock on
 * its DB path so two simultaneous owners can't stomp each other's flushes.
 * The user's reported "section data vanishes after restart" symptom turned
 * out to be exactly this — Process A had three plugin sections in memory,
 * Process B booted before A finished flushing, B's stale in-memory root
 * later won the disk write, and A's later sections were silently lost.
 *
 * The lock semantics we want:
 *   - First open writes `<dbPath>/.lock` containing pid + hostname + iso
 *     timestamp.
 *   - Second open while the first is alive throws with a message naming
 *     the holder so a developer can find/kill it. Fail-fast — we
 *     deliberately do NOT take over silently. Data loss-by-default
 *     is exactly what we're trying to stop.
 *   - `db.close()` releases the lock cleanly.
 *   - A stale lock from a crashed prior process (PID no longer alive on
 *     this hostname) is reclaimed on next open. Otherwise dev would have
 *     to delete `.lock` by hand after every Ctrl-C.
 *   - On a different hostname we can't tell if the holder is alive, so
 *     we fail-fast there too — mirrors how lockfiles handle network FS.
 */
import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { createDb } from "../src/v2/db/db";
import { createSchema, f } from "../src/v2/db/schema";

function tmpDbPath() {
  return path.join(os.tmpdir(), `kyju-lock-test-${nanoid()}`);
}

const schema = createSchema({ value: f.number().default(0) });

let cleanupPath: string | null = null;
afterEach(() => {
  if (cleanupPath) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
    cleanupPath = null;
  }
});

describe("db lock", () => {
  it("writes a .lock file on open with current pid + hostname", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const db = await createDb({ path: dbPath, schema, migrations: [], send: () => {} });

    const lockPath = path.join(dbPath, ".lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(lock.pid).toBe(process.pid);
    expect(lock.hostname).toBe(os.hostname());
    expect(typeof lock.startedAt).toBe("string");

    await db.close();
  });

  it("close() removes the .lock file", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const db = await createDb({ path: dbPath, schema, migrations: [], send: () => {} });
    const lockPath = path.join(dbPath, ".lock");
    expect(fs.existsSync(lockPath)).toBe(true);

    await db.close();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("a second open from the SAME process is allowed (transparent re-entry)", async () => {
    // Same-process double-open is how DbService.evaluate() looks under
    // hot-reload, and how this test suite simulates restart. The lock
    // only blocks cross-process races; in-process exclusion is already
    // enforced by the rootCache.
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const db1 = await createDb({ path: dbPath, schema, migrations: [], send: () => {} });
    const db2 = await createDb({ path: dbPath, schema, migrations: [], send: () => {} });

    await db1.close();
    await db2.close();
  });

  it("a lock held by a DIFFERENT (alive) PID on the same host fails fast", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    fs.mkdirSync(dbPath, { recursive: true });
    // PID 1 is init/launchd — guaranteed alive on any unix host. Picking
    // a PID we know is alive but isn't us is the cross-process scenario
    // we actually need to defend against.
    fs.writeFileSync(
      path.join(dbPath, ".lock"),
      JSON.stringify({
        pid: 1,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      createDb({ path: dbPath, schema, migrations: [], send: () => {} }),
    ).rejects.toThrow(/locked/i);
  });

  it("a stale lock (dead PID, same hostname) is reclaimed on the next open", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    fs.mkdirSync(dbPath, { recursive: true });
    // Pick a PID that's almost certainly not running on this host. PID 1
    // is init/launchd and would always be alive, so we want something
    // numerically high and unlikely to exist. Loop downward from a big
    // number until we find one `process.kill(pid, 0)` reports as missing.
    let dead = 99999;
    for (; dead > 1000; dead--) {
      try {
        process.kill(dead, 0);
      } catch {
        break;
      }
    }
    fs.writeFileSync(
      path.join(dbPath, ".lock"),
      JSON.stringify({
        pid: dead,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      }),
    );

    const db = await createDb({ path: dbPath, schema, migrations: [], send: () => {} });
    // Lock should now belong to us.
    const lock = JSON.parse(fs.readFileSync(path.join(dbPath, ".lock"), "utf8"));
    expect(lock.pid).toBe(process.pid);

    await db.close();
  });

  it("a lock held by a different hostname fails fast (can't tell if holder is alive)", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    fs.mkdirSync(dbPath, { recursive: true });
    fs.writeFileSync(
      path.join(dbPath, ".lock"),
      JSON.stringify({
        pid: process.pid,
        hostname: `not-${os.hostname()}`,
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      createDb({ path: dbPath, schema, migrations: [], send: () => {} }),
    ).rejects.toThrow(/locked/i);
  });
});
