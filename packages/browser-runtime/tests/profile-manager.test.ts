import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ChromeHost } from "../src/chrome/host.js";
import { ProfileManager, readProcessStartTicks, type ProfileManifest } from "../src/chrome/profile-manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "profile-manager-test-")); roots.push(value); return value; }

async function manifest(directory: string): Promise<ProfileManifest> {
  return JSON.parse(await readFile(join(directory, "browserd-owned.json"), "utf8")) as ProfileManifest;
}

describe("runtime-owned profile lifecycle", () => {
  it("allocates many unique profiles safely and does not serialize their startup transitions", async () => {
    const base = await root();
    const manager = new ProfileManager(base);
    const leases = await Promise.all(Array.from({ length: 50 }, async () => await manager.allocate()));
    assert.equal(new Set(leases.map((lease) => lease.directory)).size, 50);
    assert.equal(new Set(leases.map((lease) => lease.launchId)).size, 50);
    await Promise.all(leases.map(async (lease) => await lease.markStarting()));
    for (const lease of leases) {
      const value = await manifest(lease.directory);
      assert.equal(value.runtimeInstanceId, manager.runtimeInstanceId);
      assert.equal(value.launchId, lease.launchId);
      assert.equal(value.state, "starting");
    }
    await Promise.all(leases.map(async (lease) => await lease.remove()));
    assert.equal((await readdir(manager.instanceRoot)).filter((name) => name.startsWith("session-")).length, 0);
  });

  it("removes only its own failed launch and preserves another live lease", async () => {
    const manager = new ProfileManager(await root());
    const [failed, live] = await Promise.all([manager.allocate(), manager.allocate()]);
    await Promise.all([failed.markStarting(), live.markRunning(process.pid, await readProcessStartTicks(process.pid))]);
    await failed.remove();
    await assert.rejects(() => lstat(failed.directory));
    assert.equal((await lstat(live.directory)).isDirectory(), true);
    assert.equal((await manifest(live.directory)).state, "running");
    await live.remove();
  });

  it("uses separate runtime roots so one manager cannot delete another manager profile", async () => {
    const base = await root();
    const first = new ProfileManager(base);
    const second = new ProfileManager(base);
    const [a, b] = await Promise.all([first.allocate(), second.allocate()]);
    assert.notEqual(first.instanceRoot, second.instanceRoot);
    await first.cleanupOrphans();
    assert.equal((await lstat(a.directory)).isDirectory(), true);
    assert.equal((await lstat(b.directory)).isDirectory(), true);
    await Promise.all([a.remove(), b.remove()]);
  });

  it("removes a verified dead runtime root but preserves foreign and symlink entries", async () => {
    const base = await root();
    const deadId = "runtime_dead_test";
    const dead = join(base, deadId);
    const foreign = join(base, "runtime_foreign_test");
    const outside = await root();
    await Promise.all([mkdir(dead), mkdir(foreign)]);
    await writeFile(join(dead, "browserd-runtime.json"), `${JSON.stringify({ version: 2, marker: "browserd-runtime", runtimeInstanceId: deadId, pid: 999_999_999, processStartTicks: "1", createdAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
    await writeFile(join(foreign, "browserd-runtime.json"), "{}\n", { mode: 0o600 });
    await symlink(outside, join(base, "runtime_link_test"));
    const manager = new ProfileManager(base);
    await manager.initialize();
    await assert.rejects(() => lstat(dead));
    assert.equal((await lstat(foreign)).isDirectory(), true);
    assert.equal((await lstat(join(base, "runtime_link_test"))).isSymbolicLink(), true);
    assert.equal((await lstat(outside)).isDirectory(), true);
  });

  it("cleans an allocated profile when cancellation arrives before spawn", async () => {
    const base = await root();
    const manager = new ProfileManager(base);
    const controller = new AbortController();
    const allocate = manager.allocate.bind(manager);
    manager.allocate = async () => { const lease = await allocate(); controller.abort(new Error("cancelled-before-spawn")); return lease; };
    await assert.rejects(() => ChromeHost.launch({ hostId: "host:cancel-before-spawn", executable: "/bin/true", profileManager: manager }, controller.signal), /cancelled-before-spawn/);
    assert.equal((await readdir(manager.instanceRoot)).filter((name) => name.startsWith("session-")).length, 0);
  });

  it("cleans its profile when cancellation races process spawn", async () => {
    const manager = new ProfileManager(await root());
    const controller = new AbortController();
    let dispatched = false;
    await assert.rejects(() => ChromeHost.launch({ hostId: "host:cancel-after-dispatch", executable: "/bin/true", profileManager: manager }, controller.signal, () => { dispatched = true; controller.abort(new Error("cancelled-after-dispatch")); }), /cancelled-after-dispatch/);
    assert.equal(dispatched, true);
    assert.equal((await readdir(manager.instanceRoot)).filter((name) => name.startsWith("session-")).length, 0);
  });

  it("cleans its profile after a browser startup failure", async () => {
    const manager = new ProfileManager(await root());
    await assert.rejects(() => ChromeHost.launch({ hostId: "host:startup-failure", executable: "/bin/true", profileManager: manager, startupTimeoutMs: 100 }), (error) => error instanceof Error);
    assert.equal((await readdir(manager.instanceRoot)).filter((name) => name.startsWith("session-")).length, 0);
  });

  it("rejects lease deletion after manifest launch identity changes", async () => {
    const manager = new ProfileManager(await root());
    const lease = await manager.allocate();
    const value = await manifest(lease.directory);
    await writeFile(join(lease.directory, "browserd-owned.json"), `${JSON.stringify({ ...value, launchId: "launch_attacker" })}\n`, { mode: 0o600 });
    await assert.rejects(() => lease.remove(), /identity/i);
    assert.equal((await lstat(lease.directory)).isDirectory(), true);
  });
});
