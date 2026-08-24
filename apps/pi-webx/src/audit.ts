import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FacadeResult } from "../../../packages/sdk/src/facade.js";

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)/iu;
const SECRET_QUERY_KEY = /^(?:access_token|api[-_]?key|auth|authorization|code|credential|key|password|secret|signature|sig|token)$/iu;

export interface AuditPresentation {
  readonly content: unknown;
  readonly details: unknown;
}

export interface AuditRecordInput {
  readonly operation: "web.search" | "web.read";
  readonly ownerId: string;
  readonly toolCallId: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly input: unknown;
  readonly result?: FacadeResult;
  readonly presentation?: AuditPresentation;
  readonly error?: unknown;
}

interface AuditFile { readonly path: string; readonly mtimeMs: number; readonly size: number }

export class WebAuditLog {
  readonly directory: string;
  #lastAutomaticPrune = 0;

  constructor(directory = defaultAuditDirectory()) {
    this.directory = directory;
  }

  async record(input: AuditRecordInput): Promise<void> {
    const timestamp = input.startedAt.toISOString();
    const id = `${timestamp.replace(/[-:.TZ]/gu, "")}-${randomUUID()}`;
    const day = timestamp.slice(0, 10);
    const events = join(this.directory, "events");
    const directory = join(events, day);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(this.directory, 0o700), chmod(events, 0o700), chmod(directory, 0o700)]);
    const record = sanitize({
      version: 1,
      id,
      timestamp,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      operation: input.operation,
      session: createHash("sha256").update(input.ownerId).digest("hex").slice(0, 16),
      call: createHash("sha256").update(input.toolCallId).digest("hex").slice(0, 16),
      status: input.error === undefined ? "succeeded" : "failed",
      input: input.input,
      structuredResult: input.result,
      agentVisibleOutput: input.presentation,
      error: input.error === undefined ? undefined : errorValue(input.error),
    });
    const target = join(directory, `${id}.json`);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    const now = Date.now();
    if (now - this.#lastAutomaticPrune >= 60 * 60 * 1_000) {
      this.#lastAutomaticPrune = now;
      await this.prune(now);
    }
  }

  async prune(now = Date.now()): Promise<void> {
    const files = (await collectJsonFiles(join(this.directory, "events"))).sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.mtimeMs >= now - MAX_AGE_MS && total <= MAX_BYTES) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }
}

export function defaultAuditDirectory(): string {
  const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state");
  return process.env.PI_WEB_AUDIT_DIR ?? join(state, "pi-web", "audit");
}

function errorValue(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [itemKey, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      output[itemKey] = sanitize(item, itemKey);
    }
    return output;
  }
  return String(value);
}

function redactString(value: string): string {
  const urls = value.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => redactUrl(match));
  return urls.replace(/\b(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) if (SECRET_QUERY_KEY.test(name)) url.searchParams.set(name, "[redacted]");
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

async function collectJsonFiles(root: string): Promise<AuditFile[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const files: AuditFile[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      const info = await stat(path);
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return files;
}

export async function readAuditRecord(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
