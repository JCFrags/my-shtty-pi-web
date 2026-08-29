import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@webx/browser-protocol";

export interface BrowserdDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  pid: number;
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
  if (mode !== 0o700) throw new Error("browserd runtime directory must have mode 0700.");
  const paths = { runtimeDirectory: directory, socketPath: join(directory, "browserd.sock"), descriptorPath: join(directory, "browserd.json") };
  const existing = await readDescriptor(paths.descriptorPath).catch(() => undefined);
  if (existing !== undefined) {
    try { process.kill(existing.pid, 0); throw new Error("A browserd process already owns this runtime directory."); }
    catch (error) { if (error instanceof Error && error.message.includes("already owns")) throw error; }
  }
  await Promise.all([rm(paths.socketPath, { force: true }), rm(paths.descriptorPath, { force: true })]);
  const descriptor: BrowserdDescriptor = { protocolVersion: PROTOCOL_VERSION, pid: process.pid, socketPath: paths.socketPath, bindingSecret: randomBytes(32).toString("base64url"), startedAt: new Date().toISOString() };
  const temporary = `${paths.descriptorPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, paths.descriptorPath);
  return { descriptor, paths };
}

export async function readDescriptor(path: string): Promise<BrowserdDescriptor> {
  const info = await stat(path);
  if ((info.mode & 0o777) !== 0o600) throw new Error("browserd descriptor must have mode 0600.");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.pid !== "number" || typeof value.socketPath !== "string" || typeof value.bindingSecret !== "string" || typeof value.startedAt !== "string") throw new Error("Invalid browserd descriptor.");
  return { protocolVersion: PROTOCOL_VERSION, pid: value.pid, socketPath: value.socketPath, bindingSecret: value.bindingSecret, startedAt: value.startedAt };
}

export async function cleanupDescriptor(paths: DescriptorPaths): Promise<void> {
  await Promise.allSettled([rm(paths.socketPath, { force: true }), rm(paths.descriptorPath, { force: true })]);
}

export function defaultRuntimeDirectory(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? join(xdg, "pi-browserd") : join(tmpdir(), `pi-browserd-${process.getuid?.() ?? "user"}`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
