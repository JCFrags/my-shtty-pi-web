import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserProtocolError, PROTOCOL_VERSION } from "@webx/browser-protocol";
import { acquireOwnershipSocket, type OwnershipSocketLease } from "@webx/browser-runtime";

export interface BrowserdDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  runtimeInstanceId: string;
  pid: number;
  processStartTicks: string;
  socketPath: string;
  bindingSecret: string;
  brokerSigningSecret: string;
  workspaceBrokerSecret: string;
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

export interface DescriptorPaths { runtimeDirectory: string; socketPath: string; descriptorPath: string; ownershipKeyPath: string }

export interface StartupLease {
  readonly owner: StartupOwner;
  readonly abstractName: string;
  readonly keyPath: string;
  release(): Promise<void>;
}

export interface PrepareDescriptorOptions {
  allowTemporaryFallback?: boolean;
  ownershipPlatformForTest?: NodeJS.Platform;
}

export async function prepareDescriptor(runtimeDirectory?: string, options: PrepareDescriptorOptions = {}): Promise<{ descriptor: BrowserdDescriptor; paths: DescriptorPaths; lease: StartupLease }> {
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
  const kernelLease = await acquireOwnershipSocket(directory, "browserd-service", {
    ...(options.ownershipPlatformForTest ? { platform: options.ownershipPlatformForTest } : {}),
  });
  const lease = startupLease(owner, kernelLease);
  const paths: DescriptorPaths = {
    runtimeDirectory: directory,
    socketPath: join(directory, `browserd-${runtimeInstanceId}.sock`),
    descriptorPath: join(directory, "browserd.json"),
    ownershipKeyPath: kernelLease.keyPath,
  };
  try {
    await cleanupStaleServiceFiles(directory);
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
      brokerSigningSecret: randomBytes(32).toString("base64url"),
      workspaceBrokerSecret: randomBytes(32).toString("base64url"),
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
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.socketPath !== "string" || typeof value.bindingSecret !== "string" || typeof value.brokerSigningSecret !== "string" || typeof value.workspaceBrokerSecret !== "string" || typeof value.startedAt !== "string") throw new BrowserProtocolError("INTERNAL_ERROR", "Invalid browserd descriptor.");
  return { protocolVersion: PROTOCOL_VERSION, runtimeInstanceId: value.runtimeInstanceId, pid: value.pid, processStartTicks: value.processStartTicks, socketPath: value.socketPath, bindingSecret: value.bindingSecret, brokerSigningSecret: value.brokerSigningSecret, workspaceBrokerSecret: value.workspaceBrokerSecret, startedAt: value.startedAt };
}

export async function cleanupDescriptor(paths: DescriptorPaths, descriptor: BrowserdDescriptor, lease: StartupLease): Promise<void> {
  const failures: unknown[] = [];
  try { await removeRealSocket(paths.socketPath); } catch (error) { failures.push(error); }
  try { await removeDescriptorIfOwned(paths.descriptorPath, descriptor.runtimeInstanceId); } catch (error) { failures.push(error); }
  try { await lease.release(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, "browserd descriptor cleanup failed.");
}

export function defaultRuntimeDirectory(allowTemporaryFallback = false): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "pi-browserd");
  if (allowTemporaryFallback) return join(tmpdir(), `pi-browserd-${process.getuid?.() ?? "user"}`);
  throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "XDG_RUNTIME_DIR is required for browserd.");
}

async function cleanupStaleServiceFiles(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!/^browserd-runtime_[A-Za-z0-9_-]+\.sock$/.test(name) && !/^browserd\.json\.tmp-runtime_[A-Za-z0-9_-]+-[a-f0-9]+$/.test(name)) continue;
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (name.endsWith(".sock") && !info.isSocket()) continue;
    if (!name.endsWith(".sock") && (!info.isFile() || info.isSymbolicLink())) continue;
    await rm(path, { force: true });
  }
}

function startupLease(owner: StartupOwner, lease: OwnershipSocketLease): StartupLease {
  return { owner, abstractName: lease.abstractName, keyPath: lease.keyPath, release: async () => await lease.release() };
}

async function removeDescriptorIfOwned(path: string, runtimeInstanceId: string): Promise<void> {
  const current = await readDescriptor(path).catch(() => undefined);
  if (current?.runtimeInstanceId === runtimeInstanceId) await rm(path, { force: true });
}
async function removeRealSocket(path: string): Promise<void> { const info = await lstat(path).catch(() => undefined); if (info === undefined) return; if (!info.isSocket()) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd socket path is not a socket."); await rm(path, { force: true }); }
export async function readProcessStartTicks(pid: number): Promise<string> { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const end = text.lastIndexOf(")"); const ticks = text.slice(end + 2).split(" ")[19]; if (ticks === undefined || !/^\d+$/.test(ticks)) throw new Error("Invalid process identity."); return ticks; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
