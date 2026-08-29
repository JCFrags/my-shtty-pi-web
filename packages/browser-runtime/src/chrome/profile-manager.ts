import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { BrowserProtocolError } from "@webx/browser-protocol";

const INSTANCE_MARKER = "browserd-runtime.json";
const PROFILE_MARKER = "browserd-owned.json";
const LOCK_DIRECTORY = ".profile-manager.lock";
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
}

export class ProfileLease {
  private deleted = false;
  constructor(readonly manager: ProfileManager, readonly directory: string, readonly launchId: string) {}
  async markStarting(): Promise<void> { await this.manager.transition(this, "starting", { pid: 0, processStartTicks: "pending" }); }
  async markRunning(pid: number, processStartTicks: string): Promise<void> { await this.manager.transition(this, "running", { pid, processStartTicks }); }
  async remove(): Promise<void> { if (this.deleted) return; await this.manager.remove(this); this.deleted = true; }
}

export class ProfileManager {
  readonly runtimeInstanceId = `runtime_${randomBytes(18).toString("base64url")}`;
  readonly baseRoot: string;
  readonly instanceRoot: string;
  private readonly identityPromise = currentProcessIdentity();
  private initialization?: Promise<void>;
  private allocationTail: Promise<void> = Promise.resolve();

  constructor(root = join(tmpdir(), "pi-browserd-profiles")) {
    this.baseRoot = resolve(root);
    this.instanceRoot = join(this.baseRoot, this.runtimeInstanceId);
  }

  initialize(): Promise<void> { return this.initialization ??= this.initializeOnce(); }

  async allocate(): Promise<ProfileLease> {
    await this.initialize();
    return await this.serialized(async () => {
      const directory = await mkdtemp(join(this.instanceRoot, "session-"));
      await chmod(directory, 0o700);
      const launchId = `launch_${randomBytes(18).toString("base64url")}`;
      const identity = await this.identityPromise;
      await writeManifestAtomic(directory, {
        version: 2, marker: "browserd-temporary-profile", runtimeInstanceId: this.runtimeInstanceId,
        launchId, state: "allocating", pid: identity.pid, processStartTicks: identity.processStartTicks,
        createdAt: new Date().toISOString(),
      });
      return new ProfileLease(this, directory, launchId);
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
  }

  async cleanupOrphans(): Promise<void> {
    await mkdir(this.baseRoot, { recursive: true, mode: 0o700 });
    await chmod(this.baseRoot, 0o700);
    const release = await this.acquireLock();
    try {
      for (const entry of await readdir(this.baseRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("runtime_")) continue;
        const directory = join(this.baseRoot, entry.name);
        const info = await lstat(directory).catch(() => undefined);
        if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) continue;
        const marker = await readRuntimeMarker(directory).catch(() => undefined);
        if (marker === undefined) continue;
        const currentTicks = await readProcessStartTicks(marker.pid).catch(() => undefined);
        if (currentTicks === marker.processStartTicks) continue;
        await safeRemoveRuntimeRoot(this.baseRoot, directory, marker.runtimeInstanceId);
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
    const lock = join(this.baseRoot, LOCK_DIRECTORY);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        const identity = await this.identityPromise;
        await atomicJson(join(lock, INSTANCE_MARKER), { version: 2, marker: "browserd-runtime", runtimeInstanceId: this.runtimeInstanceId, ...identity, createdAt: new Date().toISOString() } satisfies RuntimeMarker);
        return async () => { await rm(lock, { recursive: true, force: true }); };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const owner = await readRuntimeMarker(lock).catch(() => undefined);
        const ticks = owner === undefined ? undefined : await readProcessStartTicks(owner.pid).catch(() => undefined);
        if (owner === undefined || ticks !== owner.processStartTicks) {
          const info = await lstat(lock).catch(() => undefined);
          if (info?.isDirectory() && !info.isSymbolicLink()) await rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Profile lifecycle lock is busy.", true);
        await sleep(20);
      }
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
  const root = await realpath(profileRoot);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const directory = join(root, entry.name);
    const manifest = await readLegacyManifest(directory).catch(() => undefined);
    if (manifest === undefined) continue;
    if (manifest.processStartTicks === "pending" && Date.now() - Date.parse(manifest.createdAt) < RECENT_STARTING_MS) continue;
    const ticks = await readProcessStartTicks(manifest.pid).catch(() => undefined);
    if (ticks === manifest.processStartTicks) continue;
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    await rm(directory, { recursive: true, force: true });
  }
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
async function readLegacyManifest(directory: string): Promise<{ pid: number; processStartTicks: string; createdAt: string }> {
  const value = await readPrivateJson(join(directory, PROFILE_MARKER));
  if (!isRecord(value) || value.version !== 1 || value.marker !== "browserd-temporary-profile" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.createdAt !== "string") throw new Error("Invalid legacy manifest.");
  return { pid: value.pid, processStartTicks: value.processStartTicks, createdAt: value.createdAt };
}
async function readPrivateJson(path: string): Promise<unknown> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Invalid private marker."); return JSON.parse(await readFile(path, "utf8")); }
async function writeManifestAtomic(directory: string, value: ProfileManifest): Promise<void> { await atomicJson(join(directory, PROFILE_MARKER), value); }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`; const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); } await rename(temporary, path); }
async function safeRemoveRuntimeRoot(baseRoot: string, directory: string, runtimeInstanceId: string): Promise<void> { const root = await realpath(baseRoot); const absolute = resolve(directory); if (absolute !== join(root, runtimeInstanceId) || !runtimeInstanceId.startsWith("runtime_")) throw new Error("Runtime profile deletion escaped its root."); const info = await lstat(absolute); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Runtime profile root is not a real directory."); const marker = await readRuntimeMarker(absolute); if (marker.runtimeInstanceId !== runtimeInstanceId) throw new Error("Runtime profile marker mismatch."); await rm(absolute, { recursive: true, force: true, maxRetries: 3 }); }
function isAlreadyExists(error: unknown): boolean { return isRecord(error) && error.code === "EEXIST"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
