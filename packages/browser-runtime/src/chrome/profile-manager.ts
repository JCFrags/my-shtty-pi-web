import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { acquireOwnershipSocket } from "../os/ownership-socket.js";

const INSTANCE_MARKER = "browserd-runtime.json";
const PROFILE_MARKER = "browserd-owned.json";
const RECENT_STARTING_MS = 60_000;

interface ProcessIdentity { pid: number; processStartTicks: string }
interface RuntimeMarker extends ProcessIdentity { version: 2; marker: "browserd-runtime"; runtimeInstanceId: string; createdAt: string }
export interface ProfileManifest extends ProcessIdentity {
  version: 2;
  marker: "browserd-temporary-profile";
  runtimeInstanceId: string;
  launchId: string;
  state: "allocating" | "starting" | "running";
  createdAt: string;
  executable?: string;
}

export class ProfileLease {
  private deleted = false;
  constructor(readonly manager: ProfileManager, readonly directory: string, readonly launchId: string) {}
  async markStarting(executable?: string): Promise<void> { await this.manager.transition(this, "starting", { pid: 0, processStartTicks: "pending" }, executable); }
  async markRunning(pid: number, processStartTicks: string, executable?: string): Promise<void> { await this.manager.transition(this, "running", { pid, processStartTicks }, executable); }
  async remove(): Promise<void> { if (this.deleted) return; await this.manager.remove(this); this.deleted = true; }
}

export interface ProfileManagerOptions {
  lockGraceMs?: number;
  lockTimeoutMs?: number;
  ownershipPlatformForTest?: NodeJS.Platform;
  recentStartingMs?: number;
  lockHooksForTest?: { afterAcquire?: () => Promise<void> };
  processHooksForTest?: {
    readStartTicks?: (pid: number) => Promise<string>;
    readExecutable?: (pid: number) => Promise<string>;
    readCommandLine?: (pid: number) => Promise<string[]>;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
  };
}

export class ProfileManager {
  readonly runtimeInstanceId = `runtime_${randomBytes(18).toString("base64url")}`;
  readonly baseRoot: string;
  readonly instanceRoot: string;
  readonly cleanupDiagnostics: string[] = [];
  private readonly identityPromise = currentProcessIdentity();
  private initialization?: Promise<void>;
  private allocationTail: Promise<void> = Promise.resolve();
  private readonly activeLeases = new Map<string, ProfileLease>();
  private readonly lockTimeoutMs: number;
  private readonly ownershipPlatformForTest: NodeJS.Platform | undefined;
  private readonly recentStartingMs: number;
  private readonly lockHooksForTest: ProfileManagerOptions["lockHooksForTest"];
  private readonly processHooksForTest: ProfileManagerOptions["processHooksForTest"];
  private closed = false;

  constructor(root = join(tmpdir(), "pi-browserd-profiles"), options: ProfileManagerOptions = {}) {
    this.baseRoot = resolve(root);
    this.instanceRoot = join(this.baseRoot, this.runtimeInstanceId);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.ownershipPlatformForTest = options.ownershipPlatformForTest;
    this.recentStartingMs = options.recentStartingMs ?? RECENT_STARTING_MS;
    this.lockHooksForTest = options.lockHooksForTest;
    this.processHooksForTest = options.processHooksForTest;
  }

  initialize(): Promise<void> { return this.initialization ??= this.initializeOnce(); }

  async allocate(): Promise<ProfileLease> {
    if (this.closed) throw new BrowserProtocolError("OPERATION_CONFLICT", "Profile manager is closed.");
    await this.initialize();
    return await this.serialized(async () => {
      if (this.closed) throw new BrowserProtocolError("OPERATION_CONFLICT", "Profile manager is closed.");
      const directory = await mkdtemp(join(this.instanceRoot, "session-"));
      await chmod(directory, 0o700);
      const launchId = `launch_${randomBytes(18).toString("base64url")}`;
      const identity = await this.identityPromise;
      await writeManifestAtomic(directory, {
        version: 2, marker: "browserd-temporary-profile", runtimeInstanceId: this.runtimeInstanceId,
        launchId, state: "allocating", pid: identity.pid, processStartTicks: identity.processStartTicks,
        createdAt: new Date().toISOString(),
      });
      const lease = new ProfileLease(this, directory, launchId);
      this.activeLeases.set(launchId, lease);
      return lease;
    });
  }

  async transition(lease: ProfileLease, state: ProfileManifest["state"], identity: ProcessIdentity, executable?: string): Promise<void> {
    await this.assertLease(lease);
    const existing = await readProfileManifest(lease.directory);
    if (existing.runtimeInstanceId !== this.runtimeInstanceId || existing.launchId !== lease.launchId) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile ownership changed during launch.");
    await writeManifestAtomic(lease.directory, { ...existing, state, ...identity, ...(executable !== undefined ? { executable: resolve(executable) } : {}) });
  }

  async remove(lease: ProfileLease): Promise<void> {
    await this.assertLease(lease);
    const manifest = await readProfileManifest(lease.directory);
    if (manifest.runtimeInstanceId !== this.runtimeInstanceId || manifest.launchId !== lease.launchId) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile deletion identity did not match.");
    if (await profileHasSameUidUser(lease.directory)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Profile is still used by a live process.");
    await rm(lease.directory, { recursive: true, force: true, maxRetries: 3 });
    this.activeLeases.delete(lease.launchId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.initialization;
    await this.serialized(async () => {
      if (this.activeLeases.size > 0) throw new BrowserProtocolError("OPERATION_CONFLICT", "Profile manager still has active leases.");
      const marker = await readRuntimeMarker(this.instanceRoot).catch(() => undefined);
      if (marker === undefined) { this.closed = true; return; }
      if (marker.runtimeInstanceId !== this.runtimeInstanceId) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile runtime ownership changed.");
      const entries = await readdir(this.instanceRoot);
      if (entries.some((name) => name !== INSTANCE_MARKER)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Profile runtime root is not empty.");
      await rm(join(this.instanceRoot, INSTANCE_MARKER), { force: true });
      await rmdir(this.instanceRoot);
      this.closed = true;
    });
  }

  async cleanupOrphans(): Promise<void> {
    await mkdir(this.baseRoot, { recursive: true, mode: 0o700 });
    await chmod(this.baseRoot, 0o700);
    const lease = await acquireOwnershipSocket(this.baseRoot, "profile-cleanup", {
      waitTimeoutMs: this.lockTimeoutMs,
      ...(this.ownershipPlatformForTest ? { platform: this.ownershipPlatformForTest } : {}),
    });
    try {
      await this.lockHooksForTest?.afterAcquire?.();
      this.cleanupDiagnostics.length = 0;
      for (const entry of await readdir(this.baseRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("runtime_")) {
          const directory = join(this.baseRoot, entry.name);
          const info = await lstat(directory).catch(() => undefined);
          if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) continue;
          const marker = await readRuntimeMarker(directory).catch(() => undefined);
          if (marker === undefined) continue;
          const currentTicks = await this.readStartTicks(marker.pid).catch(() => undefined);
          if (currentTicks === marker.processStartTicks) continue;
          await this.settleDeadRuntimeRoot(directory, marker);
          continue;
        }
        if (entry.isDirectory() && entry.name.startsWith("session-")) await cleanupLegacyDirectory(this.baseRoot, join(this.baseRoot, entry.name));
      }
    } finally { await lease.release(); }
  }

  private async initializeOnce(): Promise<void> {
    await this.cleanupOrphans();
    await mkdir(this.instanceRoot, { mode: 0o700 });
    await chmod(this.instanceRoot, 0o700);
    const identity = await this.identityPromise;
    const marker: RuntimeMarker = { version: 2, marker: "browserd-runtime", runtimeInstanceId: this.runtimeInstanceId, ...identity, createdAt: new Date().toISOString() };
    await atomicJson(join(this.instanceRoot, INSTANCE_MARKER), marker);
  }

  private async settleDeadRuntimeRoot(directory: string, marker: RuntimeMarker): Promise<void> {
    const root = await realpath(this.baseRoot);
    const absolute = resolve(directory);
    if (absolute !== join(root, marker.runtimeInstanceId) || !marker.runtimeInstanceId.startsWith("runtime_")) return;
    let retained = false;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name === INSTANCE_MARKER) continue;
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) { retained = true; continue; }
      const profile = join(absolute, entry.name);
      const info = await lstat(profile).catch(() => undefined);
      if (info === undefined) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) { retained = true; continue; }
      const manifest = await readProfileManifest(profile).catch(() => undefined);
      if (manifest === undefined || manifest.runtimeInstanceId !== marker.runtimeInstanceId || !manifest.launchId.startsWith("launch_")) { retained = true; continue; }
      const settled = await this.settleDeadProfile(profile, manifest);
      if (!settled) retained = true;
    }
    if (retained) return;
    const remaining = await readdir(absolute);
    if (remaining.some((name) => name !== INSTANCE_MARKER)) return;
    const current = await readRuntimeMarker(absolute);
    if (current.runtimeInstanceId !== marker.runtimeInstanceId || current.pid !== marker.pid || current.processStartTicks !== marker.processStartTicks) return;
    await rm(join(absolute, INSTANCE_MARKER), { force: true });
    await rmdir(absolute);
  }

  private async settleDeadProfile(directory: string, manifest: ProfileManifest): Promise<boolean> {
    const ageMs = Date.now() - Date.parse(manifest.createdAt);
    if ((manifest.state === "allocating" || manifest.state === "starting") && Number.isFinite(ageMs) && ageMs < this.recentStartingMs) {
      this.diagnostic(manifest.launchId, "startup grace is active");
      return false;
    }
    const currentTicks = await this.readStartTicks(manifest.pid).catch(() => undefined);
    if (currentTicks !== manifest.processStartTicks) {
      try { await safeRemoveProfile(this.baseRoot, directory, manifest); return true; }
      catch { this.diagnostic(manifest.launchId, "profile removal refused while a process may still use it"); return false; }
    }
    if (manifest.state !== "running" || manifest.executable === undefined) {
      this.diagnostic(manifest.launchId, "live process identity is not fully described");
      return false;
    }
    let actualExecutable: string;
    let expectedExecutable: string;
    let commandLine: string[];
    try {
      [actualExecutable, expectedExecutable, commandLine] = await Promise.all([
        this.readExecutable(manifest.pid), realpath(manifest.executable), this.readCommandLine(manifest.pid),
      ]);
    } catch {
      this.diagnostic(manifest.launchId, "live process inspection failed");
      return false;
    }
    const expectedArgument = `--user-data-dir=${resolve(directory)}`;
    if (resolve(actualExecutable) !== resolve(expectedExecutable) || !commandLine.includes(expectedArgument)) {
      this.diagnostic(manifest.launchId, "live process executable or profile argument did not match");
      return false;
    }
    await this.terminateExactProcess(manifest);
    if (await this.isExactProcessAlive(manifest)) {
      this.diagnostic(manifest.launchId, "verified browser process did not settle");
      return false;
    }
    try { await safeRemoveProfile(this.baseRoot, directory, manifest); return true; }
    catch { this.diagnostic(manifest.launchId, "profile removal refused while a process may still use it"); return false; }
  }

  private async terminateExactProcess(manifest: ProfileManifest): Promise<void> {
    if (!await this.isExactProcessAlive(manifest)) return;
    this.signalProcess(manifest.pid, "SIGTERM");
    await this.waitForExactProcessExit(manifest, 2_000);
    if (!await this.isExactProcessAlive(manifest)) return;
    this.signalProcess(manifest.pid, "SIGKILL");
    await this.waitForExactProcessExit(manifest, 1_000);
  }

  private async waitForExactProcessExit(manifest: ProfileManifest, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (!await this.isExactProcessAlive(manifest)) return; await sleep(20); }
  }

  private async isExactProcessAlive(manifest: ProfileManifest): Promise<boolean> { return await this.readStartTicks(manifest.pid).then((ticks) => ticks === manifest.processStartTicks, () => false); }
  private async readStartTicks(pid: number): Promise<string> { return await (this.processHooksForTest?.readStartTicks?.(pid) ?? readProcessStartTicks(pid)); }
  private async readExecutable(pid: number): Promise<string> { return await (this.processHooksForTest?.readExecutable?.(pid) ?? realpath(`/proc/${pid}/exe`)); }
  private async readCommandLine(pid: number): Promise<string[]> { return await (this.processHooksForTest?.readCommandLine?.(pid) ?? readProcessCommandLine(pid)); }
  private signalProcess(pid: number, signal: NodeJS.Signals): void { if (this.processHooksForTest?.signal) this.processHooksForTest.signal(pid, signal); else process.kill(pid, signal); }
  private diagnostic(launchId: string, message: string): void { if (this.cleanupDiagnostics.length < 32) this.cleanupDiagnostics.push(`${launchId}: ${message}`); }

  private async assertLease(lease: ProfileLease): Promise<void> {
    const root = await realpath(this.instanceRoot);
    const absolute = resolve(lease.directory);
    if (!absolute.startsWith(`${root}${sep}`) || !basename(absolute).startsWith("session-")) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile path escaped its runtime root.");
    const info = await lstat(absolute).catch(() => undefined);
    if (info === undefined) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile path is not a real directory.");
  }

  private async serialized<T>(task: () => Promise<T>): Promise<T> {
    const prior = this.allocationTail;
    let release!: () => void;
    this.allocationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try { return await task(); } finally { release(); }
  }
}

export async function readProcessStartTicks(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process ID.");
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).split(" ");
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) throw new Error("Invalid process stat.");
  return startTicks;
}

export async function cleanupLegacyOrphanProfiles(profileRoot: string): Promise<void> {
  const manager = new ProfileManager(profileRoot);
  await manager.cleanupOrphans();
}

async function currentProcessIdentity(): Promise<ProcessIdentity> { return { pid: process.pid, processStartTicks: await readProcessStartTicks(process.pid) }; }
async function readProcessCommandLine(pid: number): Promise<string[]> { return (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean); }
async function readRuntimeMarker(directory: string): Promise<RuntimeMarker> {
  const value = await readPrivateJson(join(directory, INSTANCE_MARKER));
  if (!isRecord(value) || value.version !== 2 || value.marker !== "browserd-runtime" || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string") throw new Error("Invalid runtime marker.");
  return value as unknown as RuntimeMarker;
}
async function readProfileManifest(directory: string): Promise<ProfileManifest> {
  const value = await readPrivateJson(join(directory, PROFILE_MARKER));
  if (!isRecord(value) || value.version !== 2 || value.marker !== "browserd-temporary-profile" || typeof value.runtimeInstanceId !== "string" || typeof value.launchId !== "string" || !["allocating", "starting", "running"].includes(String(value.state)) || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string" || (value.executable !== undefined && typeof value.executable !== "string")) throw new Error("Invalid profile manifest.");
  return value as unknown as ProfileManifest;
}
async function cleanupLegacyDirectory(baseRoot: string, directory: string): Promise<void> {
  const root = await realpath(baseRoot);
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${root}${sep}`) || !basename(absolute).startsWith("session-")) return;
  const manifest = await readLegacyManifest(absolute).catch(() => undefined);
  if (manifest === undefined) return;
  if (manifest.processStartTicks === "pending" && Date.now() - Date.parse(manifest.createdAt) < RECENT_STARTING_MS) return;
  const ticks = await readProcessStartTicks(manifest.pid).catch(() => undefined);
  if (ticks === manifest.processStartTicks) return;
  const info = await lstat(absolute).catch(() => undefined);
  if (info?.isDirectory() && !info.isSymbolicLink()) await rm(absolute, { recursive: true, force: true });
}
async function readLegacyManifest(directory: string): Promise<{ pid: number; processStartTicks: string; createdAt: string }> {
  const value = await readPrivateJson(join(directory, PROFILE_MARKER));
  if (!isRecord(value) || value.version !== 1 || value.marker !== "browserd-temporary-profile" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string") throw new Error("Invalid legacy manifest.");
  return { pid: value.pid, processStartTicks: value.processStartTicks, createdAt: value.createdAt };
}
async function safeRemoveProfile(baseRoot: string, directory: string, expected: ProfileManifest): Promise<void> {
  const root = await realpath(baseRoot);
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${root}${sep}`) || !basename(absolute).startsWith("session-")) throw new Error("Profile deletion escaped its root.");
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Profile is not a real directory.");
  const current = await readProfileManifest(absolute);
  if (current.runtimeInstanceId !== expected.runtimeInstanceId || current.launchId !== expected.launchId) throw new Error("Profile marker identity changed.");
  if (await profileHasSameUidUser(absolute)) throw new Error("Profile is still used by a live process.");
  await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
}
async function profileHasSameUidUser(profileDirectory: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Current user identity is unavailable.");
  const argument = `--user-data-dir=${profileDirectory}`;
  let observed = 0;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    observed++;
    if (observed > 65_536) throw new Error("Process table is too large.");
    const pid = Number(entry.name);
    try {
      const owner = /^Uid:\s+([0-9]+)\s+/mu.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1];
      if (owner === undefined || Number(owner) !== uid) continue;
      const before = await readProcessStartTicks(pid);
      const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean);
      const after = await readProcessStartTicks(pid);
      if (before === after && commandLine.includes(argument)) return true;
    } catch (error) { if (!isMissingProcessError(error)) throw error; }
  }
  return false;
}
function isMissingProcessError(error: unknown): boolean { return isRecord(error) && (error.code === "ENOENT" || error.code === "ESRCH"); }
async function readPrivateJson(path: string): Promise<unknown> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Invalid private marker."); return JSON.parse(await readFile(path, "utf8")); }
async function writeManifestAtomic(directory: string, value: ProfileManifest): Promise<void> { await atomicJson(join(directory, PROFILE_MARKER), value); }
async function writeExclusiveJson(path: string, value: unknown): Promise<void> { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); } }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`; await writeExclusiveJson(temporary, value); try { await rename(temporary, path); } finally { await rm(temporary, { force: true }).catch(() => undefined); } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
