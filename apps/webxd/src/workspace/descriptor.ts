import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WORKSPACE_PROTOCOL_VERSION } from "../../../../packages/workspace-protocol/src/index.js";
import { acquireOwnershipSocket, type OwnershipSocketLease } from "../../../../packages/browser-runtime/src/os/ownership-socket.js";

export interface WorkspaceDescriptor {
  readonly protocolVersion: typeof WORKSPACE_PROTOCOL_VERSION;
  readonly webxdRuntimeInstanceId: string;
  readonly pid: number;
  readonly processStartTicks: string;
  readonly socketPath: string;
  readonly bindingSecret: string;
  readonly startedAt: string;
}

export interface WorkspaceDescriptorPaths {
  readonly runtimeDirectory: string;
  readonly socketPath: string;
  readonly descriptorPath: string;
}

export interface PreparedWorkspaceDescriptor {
  readonly descriptor: WorkspaceDescriptor;
  readonly paths: WorkspaceDescriptorPaths;
  readonly lease: OwnershipSocketLease;
}

type SocketIdentity = { readonly dev: number; readonly ino: number };

export async function prepareWorkspaceDescriptor(runtimeDirectory: string): Promise<PreparedWorkspaceDescriptor> {
  const directory = resolve(runtimeDirectory);
  if (directory !== runtimeDirectory) throw new Error("workspace runtime directory must be an absolute canonical path");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw new Error("workspace runtime directory must be a private canonical directory");
  const lease = await acquireOwnershipSocket(directory, "workspace-gateway");
  try {
  const descriptorPath = join(directory, "workspace.json");
  const prior = await readWorkspaceDescriptorCandidate(descriptorPath, directory).catch(() => undefined);
  if (prior !== undefined) {
    const ticks = await readProcessStartTicks(prior.pid).catch(() => undefined);
    if (ticks === prior.processStartTicks) throw new Error("a live webxd workspace gateway already owns the runtime directory");
    await removeDescriptorIfOwned(descriptorPath, prior.webxdRuntimeInstanceId);
    await removeSocketIfSafe(prior.socketPath, directory);
  } else {
    const stale = await lstat(descriptorPath).catch(() => undefined);
    if (stale !== undefined) {
      if (!stale.isFile() || stale.isSymbolicLink()) throw new Error("workspace descriptor path is not a regular file");
      await rm(descriptorPath, { force: true });
    }
  }
  const webxdRuntimeInstanceId = randomBytes(18).toString("base64url");
  return {
    lease,
    paths: { runtimeDirectory: directory, descriptorPath, socketPath: join(directory, `workspace-${webxdRuntimeInstanceId}.sock`) },
    descriptor: {
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      webxdRuntimeInstanceId,
      pid: process.pid,
      processStartTicks: await readProcessStartTicks(process.pid),
      socketPath: join(directory, `workspace-${webxdRuntimeInstanceId}.sock`),
      bindingSecret: randomBytes(32).toString("base64url"),
      startedAt: new Date().toISOString(),
    },
  };
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function publishWorkspaceDescriptor(paths: WorkspaceDescriptorPaths, descriptor: WorkspaceDescriptor): Promise<SocketIdentity> {
  const socket = await lstat(paths.socketPath);
  if (!socket.isSocket() || (socket.mode & 0o777) !== 0o600) throw new Error("workspace socket must be private before descriptor publication");
  const temporary = `${paths.descriptorPath}.tmp-${descriptor.webxdRuntimeInstanceId}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(descriptor)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await chmod(temporary, 0o600); await rename(temporary, paths.descriptorPath); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
  return { dev: socket.dev, ino: socket.ino };
}

export async function readWorkspaceDescriptor(path: string, runtimeDirectory: string): Promise<WorkspaceDescriptor> {
  const directory = resolve(runtimeDirectory);
  if (resolve(dirname(path)) !== directory || await realpath(directory) !== directory) throw new Error("workspace descriptor location is invalid");
  const directoryInfo = await stat(directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) throw new Error("workspace runtime directory is not private");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error("workspace descriptor is not a private regular file");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.protocolVersion !== WORKSPACE_PROTOCOL_VERSION || !isOpaqueId(value.webxdRuntimeInstanceId) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.processStartTicks !== "string" || !/^\d+$/.test(value.processStartTicks) || typeof value.socketPath !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(String(value.bindingSecret)) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("workspace descriptor is invalid");
  const socketPath = resolve(value.socketPath);
  if (dirname(socketPath) !== directory) throw new Error("workspace socket location is invalid");
  const socket = await lstat(socketPath);
  if (!socket.isSocket() || (socket.mode & 0o777) !== 0o600) throw new Error("workspace socket is not private");
  const ticks = await readProcessStartTicks(value.pid as number).catch(() => undefined);
  if (ticks !== value.processStartTicks) throw new Error("workspace process identity is stale");
  return { protocolVersion: WORKSPACE_PROTOCOL_VERSION, webxdRuntimeInstanceId: value.webxdRuntimeInstanceId, pid: value.pid as number, processStartTicks: value.processStartTicks, socketPath, bindingSecret: String(value.bindingSecret), startedAt: value.startedAt };
}

export async function cleanupWorkspaceDescriptor(paths: WorkspaceDescriptorPaths, descriptor: WorkspaceDescriptor, socketIdentity?: SocketIdentity, lease?: OwnershipSocketLease): Promise<void> {
  const failures: unknown[] = [];
  try {
    const current = await lstat(paths.socketPath).catch(() => undefined);
    if (current !== undefined && current.isSocket() && (socketIdentity === undefined || (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino))) await rm(paths.socketPath, { force: true });
  } catch (error) { failures.push(error); }
  try { await removeDescriptorIfOwned(paths.descriptorPath, descriptor.webxdRuntimeInstanceId); } catch (error) { failures.push(error); }
  try { await lease?.release(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, "workspace descriptor cleanup failed");
}

async function readWorkspaceDescriptorCandidate(path: string, runtimeDirectory: string): Promise<WorkspaceDescriptor> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error("invalid stale workspace descriptor");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.protocolVersion !== WORKSPACE_PROTOCOL_VERSION || !isOpaqueId(value.webxdRuntimeInstanceId) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.processStartTicks !== "string" || !/^\d+$/.test(value.processStartTicks) || typeof value.socketPath !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(String(value.bindingSecret)) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("invalid stale workspace descriptor");
  const socketPath = resolve(value.socketPath);
  if (dirname(socketPath) !== runtimeDirectory) throw new Error("invalid stale workspace socket path");
  return { protocolVersion: WORKSPACE_PROTOCOL_VERSION, webxdRuntimeInstanceId: value.webxdRuntimeInstanceId, pid: value.pid as number, processStartTicks: value.processStartTicks, socketPath, bindingSecret: String(value.bindingSecret), startedAt: value.startedAt };
}

async function removeDescriptorIfOwned(path: string, instanceId: string): Promise<void> {
  const value = await readFile(path, "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined);
  if (isRecord(value) && value.webxdRuntimeInstanceId === instanceId) await rm(path, { force: true });
}

async function removeSocketIfSafe(path: string, directory: string): Promise<void> {
  const candidate = resolve(path);
  if (dirname(candidate) !== directory || !/^workspace-[A-Za-z0-9_-]{16,128}\.sock$/.test(candidate.slice(directory.length + 1))) return;
  const info = await lstat(candidate).catch(() => undefined);
  if (info?.isSocket()) await rm(candidate, { force: true });
}

export async function readProcessStartTicks(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const ticks = text.slice(end + 2).split(" ")[19];
  if (ticks === undefined || !/^\d+$/.test(ticks)) throw new Error("invalid process identity");
  return ticks;
}

function isOpaqueId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
