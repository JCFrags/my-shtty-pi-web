import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, it } from "vitest";
import { ChromeHost, closedProfileRemovalSafe } from "../src/chrome/host.js";
import { acquireOwnershipSocket } from "../src/os/ownership-socket.js";
import { ProfileManager, readProcessStartTicks, type ProfileManifest } from "../src/chrome/profile-manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "profile-manager-test-")); roots.push(value); return value; }
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>((value) => { resolve = value; }); return { promise, resolve }; }
async function childRecord(child: ChildProcess): Promise<{ state: string; runtimeInstanceId: string; instanceRoot: string }> { if (child.stdout === null) throw new Error("child stdout unavailable"); return await new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error("child timeout")), 10_000); child.stdout?.on("data", (chunk: Buffer) => { buffer += chunk.toString("utf8"); const end = buffer.indexOf("\n"); if (end < 0) return; clearTimeout(timer); try { resolve(JSON.parse(buffer.slice(0, end)) as { state: string; runtimeInstanceId: string; instanceRoot: string }); } catch (error) { reject(error); } }); child.once("error", reject); }); }
async function childExit(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolve) => child.once("exit", () => resolve())); }

async function manifest(directory: string): Promise<ProfileManifest> {
  return JSON.parse(await readFile(join(directory, "browserd-owned.json"), "utf8")) as ProfileManifest;
}
async function deadRuntime(base: string, id: string, profileName = "session-orphan"): Promise<{ runtime: string; profile: string }> {
  const runtime = join(base, id);
  const profile = join(runtime, profileName);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, "browserd-runtime.json"), `${JSON.stringify({ version: 2, marker: "browserd-runtime", runtimeInstanceId: id, pid: 999_999_999, processStartTicks: "1", createdAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
  return { runtime, profile };
}
async function writeOrphanManifest(profile: string, value: Partial<ProfileManifest> & Pick<ProfileManifest, "runtimeInstanceId" | "launchId" | "state" | "pid" | "processStartTicks">): Promise<void> {
  await writeFile(join(profile, "browserd-owned.json"), `${JSON.stringify({ version: 2, marker: "browserd-temporary-profile", createdAt: new Date(0).toISOString(), ...value })}\n`, { mode: 0o600 });
}
function keeper(profile: string, includeProfileArgument: boolean): ChildProcess {
  const args = ["-e", "setInterval(() => undefined, 1000)", "--", ...(includeProfileArgument ? [`--user-data-dir=${profile}`] : [])];
  return spawn(process.execPath, args, { stdio: "ignore" });
}

describe("runtime-owned profile lifecycle", () => {
  it("retains profiles when normal-close tree or process identity is uncertain", () => {
    const settled = { processTreeObserved: true, finalIdentity: "gone" as const, descendantStates: ["gone" as const], profileUsers: [], sessionMembers: [] };
    assert.equal(closedProfileRemovalSafe(settled), true);
    assert.equal(closedProfileRemovalSafe({ ...settled, processTreeObserved: false }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, finalIdentity: "identity-changed" }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, descendantStates: ["identity-changed"] }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, descendantStates: undefined }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, profileUsers: undefined }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, profileUsers: [{ pid: 1, processStartTicks: "1" }] }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, sessionMembers: undefined }), false);
    assert.equal(closedProfileRemovalSafe({ ...settled, sessionMembers: [{ pid: 2, processStartTicks: "2" }] }), false);
  });

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

  it("terminates a verified surviving browser process before removing its dead runtime root", async () => {
    const base = await root();
    const orphan = await deadRuntime(base, "runtime_surviving_exact");
    const child = keeper(orphan.profile, true);
    if (child.pid === undefined) throw new Error("keeper has no pid");
    const ticks = await readProcessStartTicks(child.pid);
    await writeOrphanManifest(orphan.profile, { runtimeInstanceId: "runtime_surviving_exact", launchId: "launch_surviving_exact", state: "running", pid: child.pid, processStartTicks: ticks, executable: process.execPath });
    const manager = new ProfileManager(base);
    await manager.initialize();
    await childExit(child);
    await assert.rejects(() => lstat(orphan.runtime));
    assert.deepEqual(manager.cleanupDiagnostics, []);
    await manager.close();
  });

  it("preserves a profile when a live PID has the wrong command line", async () => {
    const base = await root();
    const orphan = await deadRuntime(base, "runtime_wrong_command");
    const child = keeper(orphan.profile, false);
    if (child.pid === undefined) throw new Error("keeper has no pid");
    try {
      await writeOrphanManifest(orphan.profile, { runtimeInstanceId: "runtime_wrong_command", launchId: "launch_wrong_command", state: "running", pid: child.pid, processStartTicks: await readProcessStartTicks(child.pid), executable: process.execPath });
      const manager = new ProfileManager(base);
      await manager.initialize();
      assert.equal((await lstat(orphan.profile)).isDirectory(), true);
      assert.equal(manager.cleanupDiagnostics.length, 1);
      await manager.close();
    } finally { child.kill("SIGKILL"); await childExit(child); }
  });

  it("retains a dead-root profile while another same-UID process names its user-data directory", async () => {
    const base = await root();
    const orphan = await deadRuntime(base, "runtime_profile_user_survives");
    const child = keeper(orphan.profile, true);
    if (child.pid === undefined) throw new Error("keeper has no pid");
    try {
      await writeOrphanManifest(orphan.profile, { runtimeInstanceId: "runtime_profile_user_survives", launchId: "launch_profile_user_survives", state: "running", pid: 999_999_999, processStartTicks: "1", executable: process.execPath });
      const manager = new ProfileManager(base);
      await manager.initialize();
      assert.equal((await lstat(orphan.profile)).isDirectory(), true);
      assert.deepEqual(manager.cleanupDiagnostics, ["launch_profile_user_survives: profile removal refused while a process may still use it"]);
      await manager.close();
    } finally { child.kill("SIGKILL"); await childExit(child); }
  });

  it("does not signal a reused PID with mismatching process-start ticks", async () => {
    const base = await root();
    const orphan = await deadRuntime(base, "runtime_reused_pid");
    await writeOrphanManifest(orphan.profile, { runtimeInstanceId: "runtime_reused_pid", launchId: "launch_reused_pid", state: "running", pid: process.pid, processStartTicks: "1", executable: process.execPath });
    let signalled = false;
    const manager = new ProfileManager(base, { processHooksForTest: { signal: () => { signalled = true; throw new Error("must not signal"); } } });
    await manager.initialize();
    assert.equal(signalled, false);
    await assert.rejects(() => lstat(orphan.runtime));
    await manager.close();
  });

  it("retains a starting profile inside grace and removes it after grace expires", async () => {
    const base = await root();
    const recent = await deadRuntime(base, "runtime_starting_recent");
    await writeOrphanManifest(recent.profile, { runtimeInstanceId: "runtime_starting_recent", launchId: "launch_starting_recent", state: "starting", pid: 0, processStartTicks: "pending", createdAt: new Date().toISOString() });
    const first = new ProfileManager(base, { recentStartingMs: 60_000 });
    await first.initialize();
    assert.equal((await lstat(recent.profile)).isDirectory(), true);
    await first.close();
    const expired = await deadRuntime(base, "runtime_starting_expired");
    await writeOrphanManifest(expired.profile, { runtimeInstanceId: "runtime_starting_expired", launchId: "launch_starting_expired", state: "starting", pid: 0, processStartTicks: "pending", createdAt: new Date(0).toISOString() });
    const second = new ProfileManager(base, { recentStartingMs: 1 });
    await second.initialize();
    await assert.rejects(() => lstat(expired.runtime));
    await second.close();
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

  it("settles an exact failed-launch process tree before removing its profile", async () => {
    const base = await root();
    const executable = join(base, "failed-browser");
    await writeFile(executable, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    const manager = new ProfileManager(base);
    await assert.rejects(() => ChromeHost.launch({ hostId: "host:startup-failure", executable, profileManager: manager, startupTimeoutMs: 100 }), (error) => error instanceof Error);
    assert.equal((await readdir(manager.instanceRoot)).filter((name) => name.startsWith("session-")).length, 0);
  });

  it("initializes two real child-process managers without sharing or leaking roots", async () => {
    const base = await root();
    const childFile = fileURLToPath(new URL("./profile-lock-child.ts", import.meta.url));
    const children = [spawn(process.execPath, ["--import", "tsx", childFile, base], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }), spawn(process.execPath, ["--import", "tsx", childFile, base], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })];
    try {
      const records = await Promise.all(children.map(async (child) => await childRecord(child)));
      assert.ok(records.every((record) => record.state === "ready"));
      assert.equal(new Set(records.map((record) => record.runtimeInstanceId)).size, 2);
      assert.ok((await readdir(base)).filter((name) => name.startsWith("runtime_")).length === 2);
    } finally {
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(children.map(async (child) => await childExit(child)));
    }
    assert.equal((await readdir(base)).filter((name) => name.startsWith("runtime_") || name === ".profile-manager.lock").length, 0);
  });

  it("keeps kernel ownership while another manager waits, then initializes both", async () => {
    const base = await root();
    const acquired = deferred();
    const gate = deferred();
    const first = new ProfileManager(base, { lockHooksForTest: { afterAcquire: async () => { acquired.resolve(); await gate.promise; } } });
    const second = new ProfileManager(base);
    const firstStart = first.initialize();
    await acquired.promise;
    const secondStart = second.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(() => lstat(second.instanceRoot));
    gate.resolve();
    await Promise.all([firstStart, secondStart]);
    assert.equal((await lstat(first.instanceRoot)).isDirectory(), true);
    assert.equal((await lstat(second.instanceRoot)).isDirectory(), true);
    await Promise.all([first.close(), second.close()]);
  });

  it("does not let a former owner release a successor kernel lease", async () => {
    const base = await root();
    const former = await acquireOwnershipSocket(base, "profile-cleanup");
    await former.release();
    const successor = await acquireOwnershipSocket(base, "profile-cleanup");
    await former.release();
    await assert.rejects(() => acquireOwnershipSocket(base, "profile-cleanup"), (error) => error instanceof Error);
    await successor.release();
    const next = await acquireOwnershipSocket(base, "profile-cleanup");
    await next.release();
  });

  it("fails closed on an unsupported ownership platform", async () => {
    const base = await root();
    const manager = new ProfileManager(base, { ownershipPlatformForTest: "darwin" });
    await assert.rejects(() => manager.initialize(), /require Linux/i);
    await assert.rejects(() => lstat(manager.instanceRoot));
  });

  it("rejects close with an active lease and removes only its empty runtime root after release", async () => {
    const base = await root();
    const manager = new ProfileManager(base);
    const lease = await manager.allocate();
    await assert.rejects(() => manager.close(), /active leases/i);
    assert.equal((await lstat(manager.instanceRoot)).isDirectory(), true);
    await lease.remove();
    await manager.close();
    await assert.rejects(() => lstat(manager.instanceRoot));
    assert.equal((await lstat(base)).isDirectory(), true);
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
