import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserProtocolError, PROTOCOL_VERSION } from "@webx/browser-protocol";

export interface BrowserdDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  runtimeInstanceId: string;
  pid: number;
  processStartTicks: string;
  socketPath: string;
  bindingSecret: string;
  startedAt: string;
}

export interface DescriptorPaths { runtimeDirectory: string; socketPath: string; descriptorPath: string }

export async function prepareDescriptor(runtimeDirectory = defaultRuntimeDirectory()): Promise<{ descriptor: BrowserdDescriptor; paths: DescriptorPaths }> {
  const directory = resolve(runtimeDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const mode = (await stat(directory)).mode & 0o777;
  if (mode !== 0o700) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd runtime directory must have mode 0700.");
  const paths = { runtimeDirectory: directory, socketPath: join(directory, "browserd.sock"), descriptorPath: join(directory, "browserd.json") };
  const existing = await readDescriptor(paths.descriptorPath).catch(() => undefined);
  if (existing !== undefined) {
    const ticks = await readProcessStartTicks(existing.pid).catch(() => undefined);
    if (ticks === existing.processStartTicks) throw new BrowserProtocolError("OPERATION_CONFLICT", "A live browserd process already owns this runtime directory.");
  }
  await Promise.all([removeRealSocket(paths.socketPath), rm(paths.descriptorPath, { force: true })]);
  const descriptor: BrowserdDescriptor = {
    protocolVersion: PROTOCOL_VERSION,
    runtimeInstanceId: `runtime_${randomBytes(18).toString("base64url")}`,
    pid: process.pid,
    processStartTicks: await readProcessStartTicks(process.pid),
    socketPath: paths.socketPath,
    bindingSecret: randomBytes(32).toString("base64url"),
    startedAt: new Date().toISOString(),
  };
  return { descriptor, paths };
}

export async function publishDescriptor(paths: DescriptorPaths, descriptor: BrowserdDescriptor): Promise<void> {
  const temporary = `${paths.descriptorPath}.tmp-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(descriptor)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(temporary, 0o600);
  await rename(temporary, paths.descriptorPath);
}

export async function readDescriptor(path: string): Promise<BrowserdDescriptor> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd descriptor must be a private regular file.");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.runtimeInstanceId !== "string" || typeof value.pid !== "number" || typeof value.processStartTicks !== "string" || typeof value.socketPath !== "string" || typeof value.bindingSecret !== "string" || typeof value.startedAt !== "string") throw new BrowserProtocolError("INTERNAL_ERROR", "Invalid browserd descriptor.");
  return { protocolVersion: PROTOCOL_VERSION, runtimeInstanceId: value.runtimeInstanceId, pid: value.pid, processStartTicks: value.processStartTicks, socketPath: value.socketPath, bindingSecret: value.bindingSecret, startedAt: value.startedAt };
}

export async function cleanupDescriptor(paths: DescriptorPaths): Promise<void> {
  await Promise.allSettled([removeRealSocket(paths.socketPath), rm(paths.descriptorPath, { force: true })]);
}

export function defaultRuntimeDirectory(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? join(xdg, "pi-browserd") : join(tmpdir(), `pi-browserd-${process.getuid?.() ?? "user"}`);
}

async function removeRealSocket(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isSocket()) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd socket path is not a socket.");
  await rm(path, { force: true });
}
async function readProcessStartTicks(pid: number): Promise<string> { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const end = text.lastIndexOf(")"); const ticks = text.slice(end + 2).split(" ")[19]; if (ticks === undefined || !/^\d+$/.test(ticks)) throw new Error("Invalid process identity."); return ticks; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
