import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, opendir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

export const DEFAULT_CONTENT_STORE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CONTENT_STORE_MAX_ENTRIES = 256;
export const DEFAULT_CONTENT_STORE_MAX_ITEM_BYTES = 4_000_000;
export const DEFAULT_CONTENT_STORE_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_CONTENT_STORE_STARTUP_SCAN_LIMIT = 1_024;

const RECORD_JSON_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_ESCAPE_EXPANSION = 6;

const CONTENT_ID = /^cnt_[A-Za-z0-9_-]{32}$/u;

export interface NormalizedContentRecord {
  readonly contentId: string;
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sizeBytes: number;
}

export interface NormalizedContentInput {
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly url: string;
  /** Normalized extracted text only. Do not pass source response bytes or document base64. */
  readonly content: string;
}

export interface NormalizedContentStoreOptions {
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxItemBytes?: number;
  readonly retentionMs?: number;
  readonly startupScanLimit?: number;
  readonly now?: () => number;
  readonly nextId?: () => string;
}

export class ContentEntryTooLargeError extends Error {
  readonly code = "content-too-large";
  constructor(readonly sizeBytes: number, readonly maxItemBytes: number) {
    super(`normalized content is ${sizeBytes} bytes; maximum item size is ${maxItemBytes} bytes`);
    this.name = "ContentEntryTooLargeError";
  }
}

/** A bounded store for normalized extracted text. It never accepts binary source artifacts. */
export class NormalizedContentStore {
  readonly #records = new Map<string, NormalizedContentRecord>();
  readonly #directory?: string;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #maxItemBytes: number;
  readonly #retentionMs: number;
  readonly #startupScanLimit: number;
  readonly #maxFileBytes: number;
  readonly #now: () => number;
  readonly #nextId: () => string;
  readonly #ready: Promise<void>;
  #totalBytes = 0;
  #serial = Promise.resolve();

  constructor(options: NormalizedContentStoreOptions = {}) {
    this.#directory = options.directory;
    this.#maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_CONTENT_STORE_MAX_BYTES, "maxBytes");
    this.#maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_CONTENT_STORE_MAX_ENTRIES, "maxEntries");
    this.#maxItemBytes = positiveInteger(options.maxItemBytes ?? DEFAULT_CONTENT_STORE_MAX_ITEM_BYTES, "maxItemBytes");
    this.#retentionMs = positiveInteger(options.retentionMs ?? DEFAULT_CONTENT_STORE_RETENTION_MS, "retentionMs");
    this.#startupScanLimit = positiveInteger(options.startupScanLimit ?? DEFAULT_CONTENT_STORE_STARTUP_SCAN_LIMIT, "startupScanLimit");
    this.#maxFileBytes = this.#maxItemBytes * MAX_JSON_ESCAPE_EXPANSION + RECORD_JSON_OVERHEAD_BYTES;
    this.#now = options.now ?? Date.now;
    this.#nextId = options.nextId ?? (() => `cnt_${randomBytes(24).toString("base64url")}`);
    this.#ready = this.#load();
  }

  async put(input: NormalizedContentInput): Promise<NormalizedContentRecord> {
    return this.#exclusive(async () => {
      await this.#ready;
      const sizeBytes = new TextEncoder().encode(input.content).byteLength;
      if (sizeBytes > this.#maxItemBytes || sizeBytes > this.#maxBytes) {
        throw new ContentEntryTooLargeError(sizeBytes, Math.min(this.#maxItemBytes, this.#maxBytes));
      }
      await this.#pruneExpired(this.#now());
      let contentId = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = this.#nextId();
        if (!CONTENT_ID.test(candidate)) throw new TypeError("content ID source returned an invalid opaque ID");
        if (!this.#records.has(candidate)) { contentId = candidate; break; }
      }
      if (contentId.length === 0) throw new Error("content ID source did not return a unique ID");
      const createdAt = this.#now();
      const record: NormalizedContentRecord = {
        contentId,
        ownerPrincipalId: input.ownerPrincipalId,
        title: input.title,
        url: input.url,
        content: input.content,
        createdAt,
        expiresAt: createdAt + this.#retentionMs,
        sizeBytes,
      };
      await this.#write(record);
      this.#records.set(contentId, record);
      this.#totalBytes += sizeBytes;
      await this.#pruneBounds();
      return record;
    });
  }

  async get(contentId: string, ownerPrincipalId: string): Promise<NormalizedContentRecord | undefined> {
    if (!CONTENT_ID.test(contentId)) return undefined;
    return this.#exclusive(async () => {
      await this.#ready;
      await this.#pruneExpired(this.#now());
      const record = this.#records.get(contentId);
      return record?.ownerPrincipalId === ownerPrincipalId ? record : undefined;
    });
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    return this.#exclusive(async () => {
      await this.#ready;
      await this.#pruneExpired(this.#now());
      return { entries: this.#records.size, bytes: this.#totalBytes };
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(): Promise<void> {
    if (this.#directory === undefined) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const names: string[] = [];
    const directory = await opendir(this.#directory).catch(() => undefined);
    if (directory !== undefined) {
      try {
        for await (const entry of directory) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          names.push(entry.name);
          if (names.length >= this.#startupScanLimit) break;
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
    names.sort((left, right) => left.localeCompare(right));
    const loaded: NormalizedContentRecord[] = [];
    for (const name of names) {
      const path = join(this.#directory, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size <= 0 || info.size > this.#maxFileBytes) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        const handle = await open(path, "r");
        let text: string;
        try {
          const bytes = Buffer.alloc(info.size);
          const result = await handle.read(bytes, 0, bytes.length, 0);
          if (result.bytesRead !== info.size) throw new TypeError("content record changed during startup");
          text = bytes.toString("utf8");
        } finally {
          await handle.close();
        }
        const record = parseRecord(JSON.parse(text) as unknown);
        if (`${record.contentId}.json` !== name || record.expiresAt <= this.#now() || record.sizeBytes > this.#maxItemBytes || record.sizeBytes > this.#maxBytes) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        loaded.push(record);
      } catch {
        await unlink(path).catch(() => undefined);
      }
    }
    loaded.sort((left, right) => right.createdAt - left.createdAt || left.contentId.localeCompare(right.contentId));
    const retained: NormalizedContentRecord[] = [];
    let retainedBytes = 0;
    for (const record of loaded) {
      if (retained.length >= this.#maxEntries || retainedBytes + record.sizeBytes > this.#maxBytes) {
        await unlink(join(this.#directory, `${record.contentId}.json`)).catch(() => undefined);
        continue;
      }
      retained.push(record);
      retainedBytes += record.sizeBytes;
    }
    retained.reverse();
    for (const record of retained) {
      this.#records.set(record.contentId, record);
      this.#totalBytes += record.sizeBytes;
    }
  }

  async #pruneExpired(now: number): Promise<void> {
    for (const [contentId, record] of this.#records) {
      if (record.expiresAt > now) continue;
      await this.#remove(contentId, record);
    }
  }

  async #pruneBounds(): Promise<void> {
    while (this.#records.size > this.#maxEntries || this.#totalBytes > this.#maxBytes) {
      const oldest = this.#records.entries().next().value as [string, NormalizedContentRecord] | undefined;
      if (oldest === undefined) break;
      await this.#remove(oldest[0], oldest[1]);
    }
  }

  async #remove(contentId: string, record: NormalizedContentRecord): Promise<void> {
    if (!this.#records.delete(contentId)) return;
    this.#totalBytes -= record.sizeBytes;
    if (this.#directory !== undefined) await unlink(join(this.#directory, `${contentId}.json`)).catch(() => undefined);
  }

  async #write(record: NormalizedContentRecord): Promise<void> {
    if (this.#directory === undefined) return;
    const target = join(this.#directory, `${record.contentId}.json`);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive finite integer`);
  return value;
}

function parseRecord(value: unknown): NormalizedContentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("content record must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.contentId !== "string" || !CONTENT_ID.test(record.contentId)) throw new TypeError("invalid content ID");
  if (typeof record.ownerPrincipalId !== "string" || typeof record.title !== "string" || typeof record.url !== "string" || typeof record.content !== "string") throw new TypeError("invalid content record text");
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(record.sizeBytes)) throw new TypeError("invalid content record bounds");
  const sizeBytes = new TextEncoder().encode(record.content).byteLength;
  if (sizeBytes !== record.sizeBytes || (record.expiresAt as number) <= (record.createdAt as number)) throw new TypeError("invalid content record size or retention");
  return record as unknown as NormalizedContentRecord;
}
