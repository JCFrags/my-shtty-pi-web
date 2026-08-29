import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { BrowserProtocolError } from "@webx/browser-protocol";

const INSTANCE_MARKER = "browserd-runtime.json";
const PROFILE_MARKER = "browserd-owned.json";
const LOCK_FILE = ".profile-manager.lock";
const LOCK_GRACE_MS = 2_000;
const RECENT_STARTING_MS = 60_000;

interface ProcessIdentity { pid: number; processStartTicks: string }
interface RuntimeMarker extends ProcessIdentity { version: 2; marker: "browserd-runtime"; runtimeInstanceId: string; createdAt: string }
interface LockOwner extends ProcessIdentity { version: 1; runtimeInstanceId: string; nonce: string; createdAt: string }
export interface ProfileManifest extends ProcessIdentity {
  version: 2;
  marker: "browserd-temporary-profile";
  runtimeInstanceId: string;
  launchId: string;
  state: "allocating" | "starting" | "running";
  createdAt: string;
}

export class ProfileLease {
  private deleted = false;
  constructor(readonly manager: ProfileManager, readonly directory: string, readonly launchId: string) {}
  async markStarting(): Promise<void> { await this.manager.transition(this, "starting", { pid: 0, processStartTicks: "pending" }); }
  async markRunning(pid: number, processStartTicks: string): Promise<void> { await this.manager.transition(this, "running", { pid, processStartTicks }); }
  async remove(): Promise<void> { if (this.deleted) return; await this.manager.remove(this); this.deleted = true; }
}

export interface ProfileManagerOptions { lockGraceMs?: number; lockTimeoutMs?: number; lockHooksForTest?: { afterAcquire?: () => Promise<void> } }

export class ProfileManager {
  readonly runtimeInstanceId = `runtime_${randomBytes(18).toString("base64url")}`;
  readonly baseRoot: string;
  readonly instanceRoot: string;
  private readonly identityPromise = currentProcessIdentity();
  private initialization?: Promise<void>;
  private allocationTail: Promise<void> = Promise.resolve();
  private readonly activeLeases = new Map<string, ProfileLease>();
  private readonly lockGraceMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockHooksForTest: ProfileManagerOptions["lockHooksForTest"];
  private closed = false;

  constructor(root = join(tmpdir(), "pi-browserd-profiles"), options: ProfileManagerOptions = {}) {
    this.baseRoot = resolve(root);
    this.instanceRoot = join(this.baseRoot, this.runtimeInstanceId);
    this.lockGraceMs = options.lockGraceMs ?? LOCK_GRACE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockHooksForTest = options.lockHooksForTest;
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

  async transition(lease: ProfileLease, state: ProfileManifest["state"], identity: ProcessIdentity): Promise<void> {
    await this.assertLease(lease);
    const existing = await readProfileManifest(lease.directory);
    if (existing.runtimeInstanceId !== this.runtimeInstanceId || existing.launchId !== lease.launchId) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile ownership changed during launch.");
    await writeManifestAtomic(lease.directory, { ...existing, state, ...identity });
  }

  async remove(lease: ProfileLease): Promise<void> {
    await this.assertLease(lease);
    const manifest = await readProfileManifest(lease.directory);
    if (manifest.runtimeInstanceId !== this.runtimeInstanceId || manifest.launchId !== lease.launchId) throw new BrowserProtocolError("INTERNAL_ERROR", "Profile deletion identity did not match.");
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
    const release = await this.acquireLock();
    try {
      for (const entry of await readdir(this.baseRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("runtime_")) {
          const directory = join(this.baseRoot, entry.name);
          const info = await lstat(directory).catch(() => undefined);
          if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) continue;
          const marker = await readRuntimeMarker(directory).catch(() => undefined);
          if (marker === undefined) continue;
          const currentTicks = await readProcessStartTicks(marker.pid).catch(() => undefined);
          if (currentTicks === marker.processStartTicks) continue;
          await safeRemoveRuntimeRoot(this.baseRoot, directory, marker.runtimeInstanceId);
          continue;
        }
        if (entry.isDirectory() && entry.name.startsWith("session-")) await cleanupLegacyDirectory(this.baseRoot, join(this.baseRoot, entry.name));
      }
    } finally { await release(); }
  }

  private async initializeOnce(): Promise<void> {
    await this.cleanupOrphans();
    await mkdir(this.instanceRoot, { mode: 0o700 });
    await chmod(this.instanceRoot, 0o700);
    const identity = await this.identityPromise;
    const marker: RuntimeMarker = { version: 2, marker: "browserd-runtime", runtimeInstanceId: this.runtimeInstanceId, ...identity, createdAt: new Date().toISOString() };
    await atomicJson(join(this.instanceRoot, INSTANCE_MARKER), marker);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lock = join(this.baseRoot, LOCK_FILE);
    const identity = await this.identityPromise;
    const owner: LockOwner = { version: 1, runtimeInstanceId: this.runtimeInstanceId, ...identity, nonce: randomBytes(24).toString("base64url"), createdAt: new Date().toISOString() };
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      const temporary = `${lock}.${owner.runtimeInstanceId}.${owner.nonce}.tmp`;
      await writeExclusiveJson(temporary, owner);
      try {
        await link(temporary, lock);
        await rm(temporary, { force: true });
        await this.lockHooksForTest?.afterAcquire?.();
        return async () => {
          const current = await readLockOwner(lock).catch(() => undefined);
          if (current !== undefined && sameLockOwner(current, owner)) await rm(lock, { force: true });
        };
      } catch (error) {
        await rm(temporary, { force: true });
        if (!isAlreadyExists(error)) throw error;
      }
      const raw = await readFile(lock, "utf8").catch(() => undefined);
      const current = raw === undefined ? undefined : parseLockOwner(raw);
      if (current === undefined) {
        const info = await lstat(lock).catch(() => undefined);
        if (info === undefined) continue;
        if (Date.now() - info.mtimeMs < this.lockGraceMs) {
          if (Date.now() >= deadline) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Profile lifecycle lock is initializing.", true);
          await sleep(20);
          continue;
        }
        if ((await readFile(lock, "utf8").catch(() => undefined)) === raw) await rm(lock, { force: true });
        continue;
      }
      const ticks = await readProcessStartTicks(current.pid).catch(() => undefined);
      if (ticks !== current.processStartTicks) {
        if ((await readFile(lock, "utf8").catch(() => undefined)) === raw) await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Profile lifecycle lock is busy.", true);
      await sleep(20);
    }
  }

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
async function readRuntimeMarker(directory: string): Promise<RuntimeMarker> {
  const value = await readPrivateJson(join(directory, INSTANCE_MARKER));
  if (!isRecord(value) || value.version !== 2 || value.marker !== "browserd-runtime" || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string") throw new Error("Invalid runtime marker.");
  return value as unknown as RuntimeMarker;
}
async function readProfileManifest(directory: string): Promise<ProfileManifest> {
  const value = await readPrivateJson(join(directory, PROFILE_MARKER));
  if (!isRecord(value) || value.version !== 2 || value.marker !== "browserd-temporary-profile" || typeof value.runtimeInstanceId !== "string" || typeof value.launchId !== "string" || !["allocating", "starting", "running"].includes(String(value.state)) || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string") throw new Error("Invalid profile manifest.");
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
async function readPrivateJson(path: string): Promise<unknown> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Invalid private marker."); return JSON.parse(await readFile(path, "utf8")); }
async function writeManifestAtomic(directory: string, value: ProfileManifest): Promise<void> { await atomicJson(join(directory, PROFILE_MARKER), value); }
async function writeExclusiveJson(path: string, value: unknown): Promise<void> { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); } }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`; await writeExclusiveJson(temporary, value); try { await rename(temporary, path); } finally { await rm(temporary, { force: true }).catch(() => undefined); } }
async function readLockOwner(path: string): Promise<LockOwner> { const value = parseLockOwner(await readFile(path, "utf8")); if (value === undefined) throw new Error("Invalid profile lock owner."); return value; }
function parseLockOwner(raw: string): LockOwner | undefined { try { const value: unknown = JSON.parse(raw); if (!isRecord(value) || value.version !== 1 || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.nonce !== "string" || typeof value.createdAt !== "string") return undefined; return value as unknown as LockOwner; } catch { return undefined; } }
function sameLockOwner(left: LockOwner, right: LockOwner): boolean { return left.runtimeInstanceId === right.runtimeInstanceId && left.pid === right.pid && left.processStartTicks === right.processStartTicks && left.nonce === right.nonce; }
async function safeRemoveRuntimeRoot(baseRoot: string, directory: string, runtimeInstanceId: string): Promise<void> { const root = await realpath(baseRoot); const absolute = resolve(directory); if (absolute !== join(root, runtimeInstanceId) || !runtimeInstanceId.startsWith("runtime_")) throw new Error("Runtime profile deletion escaped its root."); const info = await lstat(absolute); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Runtime profile root is not a real directory."); const marker = await readRuntimeMarker(absolute); if (marker.runtimeInstanceId !== runtimeInstanceId) throw new Error("Runtime profile marker mismatch."); await rm(absolute, { recursive: true, force: true, maxRetries: 3 }); }
function isAlreadyExists(error: unknown): boolean { return isRecord(error) && error.code === "EEXIST"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
