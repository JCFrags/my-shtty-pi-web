import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserProtocolError, PROTOCOL_VERSION } from "@webx/browser-protocol";

const STARTUP_LOCK = ".browserd-startup.lock";
const LOCK_RECOVERY_GRACE_MS = 2_000;

export interface BrowserdDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  runtimeInstanceId: string;
  pid: number;
  processStartTicks: string;
  socketPath: string;
  bindingSecret: string;
  startedAt: string;
}

export interface StartupOwner {
  version: 1;
  runtimeInstanceId: string;
  pid: number;
  processStartTicks: string;
  nonce: string;
  createdAt: string;
}

export interface DescriptorPaths { runtimeDirectory: string; socketPath: string; descriptorPath: string; lockPath: string }

export interface StartupLease {
  readonly owner: StartupOwner;
  readonly lockPath: string;
  release(): Promise<void>;
}

export async function prepareDescriptor(runtimeDirectory?: string, options: { allowTemporaryFallback?: boolean } = {}): Promise<{ descriptor: BrowserdDescriptor; paths: DescriptorPaths; lease: StartupLease }> {
  const directory = resolve(runtimeDirectory ?? defaultRuntimeDirectory(options.allowTemporaryFallback ?? false));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const mode = (await stat(directory)).mode & 0o777;
  if (mode !== 0o700) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd runtime directory must have mode 0700.");

  const runtimeInstanceId = `runtime_${randomBytes(18).toString("base64url")}`;
  const owner: StartupOwner = {
    version: 1,
    runtimeInstanceId,
    pid: process.pid,
    processStartTicks: await readProcessStartTicks(process.pid),
    nonce: randomBytes(24).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  const lockPath = join(directory, STARTUP_LOCK);
  const lease = await acquireStartupLock(lockPath, owner);
  const paths: DescriptorPaths = {
    runtimeDirectory: directory,
    socketPath: join(directory, `browserd-${runtimeInstanceId}.sock`),
    descriptorPath: join(directory, "browserd.json"),
    lockPath,
  };
  try {
    const existing = await readDescriptor(paths.descriptorPath).catch(() => undefined);
    if (existing !== undefined) {
      const ticks = await readProcessStartTicks(existing.pid).catch(() => undefined);
      if (ticks === existing.processStartTicks) throw new BrowserProtocolError("OPERATION_CONFLICT", "A live browserd process already owns this runtime directory.");
      await removeDescriptorIfOwned(paths.descriptorPath, existing.runtimeInstanceId);
    } else {
      const descriptorInfo = await lstat(paths.descriptorPath).catch(() => undefined);
      if (descriptorInfo !== undefined) await rm(paths.descriptorPath, { force: true });
    }
    const descriptor: BrowserdDescriptor = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeInstanceId,
      pid: owner.pid,
      processStartTicks: owner.processStartTicks,
      socketPath: paths.socketPath,
      bindingSecret: randomBytes(32).toString("base64url"),
      startedAt: new Date().toISOString(),
    };
    return { descriptor, paths, lease };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export async function publishDescriptor(paths: DescriptorPaths, descriptor: BrowserdDescriptor): Promise<void> {
  const temporary = `${paths.descriptorPath}.tmp-${descriptor.runtimeInstanceId}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(descriptor)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, paths.descriptorPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readDescriptor(path: string): Promise<BrowserdDescriptor> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd descriptor must be a private regular file.");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.socketPath !== "string" || typeof value.bindingSecret !== "string" || typeof value.startedAt !== "string") throw new BrowserProtocolError("INTERNAL_ERROR", "Invalid browserd descriptor.");
  return { protocolVersion: PROTOCOL_VERSION, runtimeInstanceId: value.runtimeInstanceId, pid: value.pid, processStartTicks: value.processStartTicks, socketPath: value.socketPath, bindingSecret: value.bindingSecret, startedAt: value.startedAt };
}

export async function cleanupDescriptor(paths: DescriptorPaths, descriptor: BrowserdDescriptor, lease: StartupLease): Promise<void> {
  await removeRealSocket(paths.socketPath);
  await removeDescriptorIfOwned(paths.descriptorPath, descriptor.runtimeInstanceId);
  await lease.release();
}

export function defaultRuntimeDirectory(allowTemporaryFallback = false): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "pi-browserd");
  if (allowTemporaryFallback) return join(tmpdir(), `pi-browserd-${process.getuid?.() ?? "user"}`);
  throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "XDG_RUNTIME_DIR is required for browserd.");
}

async function acquireStartupLock(lockPath: string, owner: StartupOwner): Promise<StartupLease> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${lockPath}.${owner.runtimeInstanceId}.${owner.nonce}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await link(temporary, lockPath);
      await rm(temporary, { force: true });
      return {
        owner,
        lockPath,
        release: async (): Promise<void> => {
          const current = await readStartupOwner(lockPath).catch(() => undefined);
          if (current !== undefined && sameOwner(current, owner)) await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      await rm(temporary, { force: true });
      if (!isAlreadyExists(error)) throw error;
    }

    const raw = await readFile(lockPath, "utf8").catch(() => undefined);
    const current = raw === undefined ? undefined : parseStartupOwner(raw);
    if (current === undefined) {
      const info = await lstat(lockPath).catch(() => undefined);
      if (info === undefined) continue;
      if (Date.now() - info.mtimeMs < LOCK_RECOVERY_GRACE_MS) throw new BrowserProtocolError("OPERATION_CONFLICT", "browserd startup ownership is initializing.", true);
      if (await unchangedFile(lockPath, raw)) await rm(lockPath, { force: true });
      continue;
    }
    const ticks = await readProcessStartTicks(current.pid).catch(() => undefined);
    if (ticks === current.processStartTicks) throw new BrowserProtocolError("OPERATION_CONFLICT", "A live browserd process already owns this runtime directory.");
    if (await unchangedFile(lockPath, raw)) await rm(lockPath, { force: true });
  }
  throw new BrowserProtocolError("OPERATION_CONFLICT", "browserd startup ownership could not be acquired.", true);
}

async function unchangedFile(path: string, expected: string | undefined): Promise<boolean> {
  if (expected === undefined) return (await readFile(path, "utf8").catch(() => undefined)) === undefined;
  return (await readFile(path, "utf8").catch(() => undefined)) === expected;
}
async function readStartupOwner(path: string): Promise<StartupOwner> { const value = parseStartupOwner(await readFile(path, "utf8")); if (value === undefined) throw new Error("Invalid browserd startup lock."); return value; }
function parseStartupOwner(raw: string): StartupOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.nonce !== "string" || typeof value.createdAt !== "string") return undefined;
    return { version: 1, runtimeInstanceId: value.runtimeInstanceId, pid: value.pid, processStartTicks: value.processStartTicks, nonce: value.nonce, createdAt: value.createdAt };
  } catch { return undefined; }
}
function sameOwner(left: StartupOwner, right: StartupOwner): boolean { return left.runtimeInstanceId === right.runtimeInstanceId && left.pid === right.pid && left.processStartTicks === right.processStartTicks && left.nonce === right.nonce; }
async function removeDescriptorIfOwned(path: string, runtimeInstanceId: string): Promise<void> { const current = await readDescriptor(path).catch(() => undefined); if (current?.runtimeInstanceId === runtimeInstanceId) await rm(path, { force: true }); }
async function removeRealSocket(path: string): Promise<void> { const info = await lstat(path).catch(() => undefined); if (info === undefined) return; if (!info.isSocket()) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd socket path is not a socket."); await rm(path, { force: true }); }
export async function readProcessStartTicks(pid: number): Promise<string> { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const end = text.lastIndexOf(")"); const ticks = text.slice(end + 2).split(" ")[19]; if (ticks === undefined || !/^\d+$/.test(ticks)) throw new Error("Invalid process identity."); return ticks; }
function isAlreadyExists(error: unknown): boolean { return isRecord(error) && error.code === "EEXIST"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
