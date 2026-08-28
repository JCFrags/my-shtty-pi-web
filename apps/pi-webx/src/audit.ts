import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, opendir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FacadeResult } from "../../../packages/sdk/src/facade.js";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_PRUNE_FILES = 8_192;
const MAX_INPUT_STRING = 2_048;
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)/iu;
const SECRET_QUERY_KEY = /^(?:access_token|api[-_]?key|auth|authorization|code|credential|key|password|secret|signature|sig|token)$/iu;
const CONTENT_KEY = /^(?:agentVisibleOutput|body|content|originalBytes|passage|payloadBase64|rawBytes|snippet|structuredResult|untrustedContent)$/iu;

export interface AuditPresentation { readonly content: unknown; readonly details: unknown }
export interface AuditRecordInput {
  readonly operation: "web.search" | "web.read" | "web.readBatch";
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

/** New records contain bounded metadata only. Existing record files are not migrated. */
export class WebAuditLog {
  readonly directory: string;
  #lastAutomaticPrune = 0;
  constructor(directory = defaultAuditDirectory()) { this.directory = directory; }

  async record(input: AuditRecordInput): Promise<void> {
    const timestamp = input.startedAt.toISOString();
    const id = `${timestamp.replace(/[-:.TZ]/gu, "")}-${randomUUID()}`;
    const events = join(this.directory, "events");
    const metadataEvents = join(events, "metadata-v2");
    const directory = join(metadataEvents, timestamp.slice(0, 10));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(this.directory, 0o700), chmod(events, 0o700), chmod(metadataEvents, 0o700), chmod(directory, 0o700)]);
    const error = input.error === undefined ? undefined : errorValue(input.error);
    const record = {
      version: 2,
      id,
      timestamp,
      finishedAt: new Date(input.startedAt.getTime() + Math.max(0, input.durationMs)).toISOString(),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      operation: input.operation,
      actorScope: createHash("sha256").update(input.ownerId).digest("hex").slice(0, 16),
      call: createHash("sha256").update(input.toolCallId).digest("hex").slice(0, 16),
      outcome: error === undefined ? "succeeded" : error.name === "AbortError" ? "cancelled" : "failed",
      status: resultStatus(input.result, error),
      errorClass: error?.name,
      input: sanitizeInput(input.input),
      result: resultMetadata(input.result),
      ...(error === undefined ? {} : { error: { name: error.name, messageDigest: digest(error.message) } }),
    };
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) throw new Error("audit metadata record exceeds its bound");
    const target = join(directory, `${id}.json`);
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
    const now = Date.now();
    if (now - this.#lastAutomaticPrune >= 60 * 60 * 1_000) {
      this.#lastAutomaticPrune = now;
      await this.prune(now);
    }
  }

  async prune(now = Date.now()): Promise<void> {
    const { files, overflow } = await collectJsonFiles(join(this.directory, "events", "metadata-v2"), MAX_PRUNE_FILES);
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.mtimeMs >= now - MAX_AGE_MS && total <= MAX_BYTES) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
    if (overflow) throw new Error("audit pruning stopped at its bounded file scan; existing files were preserved");
  }
}

export function defaultAuditDirectory(): string {
  const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state");
  return process.env.PI_WEB_AUDIT_DIR ?? join(state, "pi-web", "audit");
}
function errorValue(error: unknown): { name: string; message: string } { return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function resultStatus(result: FacadeResult | undefined, error: { name: string } | undefined): string {
  if (error !== undefined) return error.name === "AbortError" ? "cancelled" : "error";
  const data = asObject(result?.data);
  return typeof data?.status === "string" ? data.status.slice(0, 64) : "ok";
}
function resultMetadata(result: FacadeResult | undefined): unknown {
  if (result === undefined) return undefined;
  const data = asObject(result.data);
  const metadata = asObject(data?.metadata);
  const delivery = asObject(metadata?.delivery);
  const reader = asObject(metadata?.reader);
  const output: Record<string, unknown> = {
    trust: result.trust,
    cache: delivery?.cache,
    coalesced: delivery?.coalesced,
    contentId: stringValue(metadata?.contentId),
    sha256: stringValue(data?.sha256),
    bytes: numberValue(data?.bytes ?? reader?.storedBytes),
    characters: numberValue(data?.characters ?? reader?.returnedCharacters),
    count: countMetadata(data, { ...metadata, ...reader }),
  };
  if (Array.isArray(data?.results)) {
    output.sources = data.results.slice(0, 5).map((item) => {
      const envelope = asObject(item);
      const source = asObject(envelope?.result);
      const sourceMetadata = asObject(source?.metadata);
      const sourceDelivery = asObject(sourceMetadata?.delivery);
      return {
        index: numberValue(envelope?.index), ok: envelope?.ok === true,
        status: envelope?.ok === true ? "ok" : stringValue(asObject(envelope?.error)?.code),
        contentId: stringValue(sourceMetadata?.contentId), cache: sourceDelivery?.cache, coalesced: sourceDelivery?.coalesced,
        characters: numberValue(asObject(sourceMetadata?.reader)?.returnedCharacters), bytes: numberValue(asObject(sourceMetadata?.reader)?.storedBytes),
      };
    });
  }
  return removeUndefined(output);
}
function countMetadata(data: Record<string, unknown> | undefined, metadata: Record<string, unknown> | undefined): unknown {
  const keys = ["requested", "succeeded", "failed", "searches", "pagesRead", "readAttempts", "returnedCharacters", "totalCharacters", "bytes", "characters"];
  const output: Record<string, number> = {};
  for (const key of keys) { const value = numberValue(metadata?.[key] ?? data?.[key]); if (value !== undefined) output[key] = value; }
  if (Array.isArray(data?.hits)) output.hits = data.hits.length;
  return Object.keys(output).length === 0 ? undefined : output;
}
function sanitizeInput(value: unknown, key = "", depth = 0): unknown {
  if (CONTENT_KEY.test(key)) return "[omitted content]";
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (depth >= 5) return "[depth limit]";
  if (typeof value === "string") return redactString(value).slice(0, MAX_INPUT_STRING);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeInput(item, key, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [itemKey, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) if (item !== undefined) output[itemKey.slice(0, 128)] = sanitizeInput(item, itemKey, depth + 1);
    return output;
  }
  return `[${typeof value}]`;
}
function redactString(value: string): string {
  const urls = value.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => redactUrl(match));
  return urls.replace(/\b(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
}
function redactUrl(value: string): string {
  try { const url = new URL(value); for (const name of [...url.searchParams.keys()]) if (SECRET_QUERY_KEY.test(name)) url.searchParams.set(name, "[redacted]"); url.username = ""; url.password = ""; return url.toString(); }
  catch { return value; }
}
async function collectJsonFiles(root: string, limit: number): Promise<{ files: AuditFile[]; overflow: boolean }> {
  const files: AuditFile[] = [];
  const directories = [root];
  let overflow = false;
  let visited = 0;
  while (directories.length > 0 && !overflow) {
    const current = directories.pop();
    if (current === undefined) break;
    const directory = await opendir(current).catch(() => undefined);
    if (directory === undefined) continue;
    try {
      for await (const entry of directory) {
        visited += 1;
        if (visited > limit || files.length + directories.length >= limit) { overflow = true; break; }
        const path = join(current, entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile() && entry.name.endsWith(".json")) { const info = await stat(path).catch(() => undefined); if (info !== undefined) files.push({ path, mtimeMs: info.mtimeMs, size: info.size }); }
      }
    } finally { await directory.close().catch(() => undefined); }
  }
  return { files, overflow };
}
function asObject(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value.slice(0, 128) : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function removeUndefined(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
export async function readAuditRecord(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
