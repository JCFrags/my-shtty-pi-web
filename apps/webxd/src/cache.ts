import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, opendir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { CACHE_POLICY } from "../../../packages/policy/storage.mjs";

export const DEFAULT_CACHE_MEMORY_ENTRIES = CACHE_POLICY.memoryEntries;
export const DEFAULT_CACHE_MEMORY_BYTES = CACHE_POLICY.memoryBytes;
export const DEFAULT_CACHE_DISK_ENTRIES = CACHE_POLICY.diskEntries;
export const DEFAULT_CACHE_DISK_BYTES = CACHE_POLICY.diskBytes;
export const DEFAULT_CACHE_MAX_ENTRY_BYTES = CACHE_POLICY.maxEntryBytes;

interface CacheEnvelope<T> { readonly expiresAt: number; readonly value: T }
interface MemoryEntry { readonly envelope: CacheEnvelope<unknown>; readonly bytes: number }
interface DiskEntry { readonly path: string; readonly size: number; readonly modified: number }

export interface WebCacheOptions {
  readonly directory?: string;
  readonly maxMemoryEntries?: number;
  readonly maxMemoryBytes?: number;
  readonly maxDiskEntries?: number;
  readonly maxDiskBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxDiskScanEntries?: number;
}

/** Short-lived public web cache. This is not a research archive or page library. */
export class WebCache {
  readonly #memory = new Map<string, MemoryEntry>();
  readonly #directory?: string;
  readonly #maxMemoryEntries: number;
  readonly #maxMemoryBytes: number;
  readonly #maxDiskEntries: number;
  readonly #maxDiskBytes: number;
  readonly #maxEntryBytes: number;
  readonly #maxDiskScanEntries: number;
  #memoryBytes = 0;
  #serial = Promise.resolve();

  constructor(options: WebCacheOptions = {}) {
    this.#directory = options.directory;
    this.#maxMemoryEntries = positive(options.maxMemoryEntries ?? DEFAULT_CACHE_MEMORY_ENTRIES, "maxMemoryEntries");
    this.#maxMemoryBytes = positive(options.maxMemoryBytes ?? DEFAULT_CACHE_MEMORY_BYTES, "maxMemoryBytes");
    this.#maxDiskEntries = positive(options.maxDiskEntries ?? DEFAULT_CACHE_DISK_ENTRIES, "maxDiskEntries");
    this.#maxDiskBytes = positive(options.maxDiskBytes ?? DEFAULT_CACHE_DISK_BYTES, "maxDiskBytes");
    this.#maxEntryBytes = positive(options.maxEntryBytes ?? DEFAULT_CACHE_MAX_ENTRY_BYTES, "maxEntryBytes");
    this.#maxDiskScanEntries = positive(options.maxDiskScanEntries ?? Math.max(4_096, this.#maxDiskEntries * 4), "maxDiskScanEntries");
  }

  async get<T>(namespace: string, input: unknown): Promise<T | undefined> {
    const key = cacheKey(namespace, input);
    const memory = this.#memory.get(key);
    if (memory !== undefined) {
      if (memory.envelope.expiresAt > Date.now()) {
        this.#memory.delete(key);
        this.#memory.set(key, memory);
        return memory.envelope.value as T;
      }
      this.#forget(key);
    }
    if (this.#directory === undefined) return undefined;
    const path = join(this.#directory, `${key}.json`);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > this.#maxEntryBytes) throw new Error("cache entry exceeds its bound");
      const handle = await open(path, "r");
      let text: string;
      try {
        const bytes = Buffer.alloc(info.size);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== info.size) throw new Error("cache entry changed while reading");
        text = bytes.toString("utf8");
      } finally { await handle.close(); }
      const envelope = JSON.parse(text) as CacheEnvelope<T>;
      if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= Date.now()) {
        await unlink(path).catch(() => undefined);
        return undefined;
      }
      this.#remember(key, envelope, info.size);
      return envelope.value;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") await unlink(path).catch(() => undefined);
      return undefined;
    }
  }

  async set<T>(namespace: string, input: unknown, value: T, ttlMilliseconds: number): Promise<boolean> {
    const key = cacheKey(namespace, input);
    const envelope: CacheEnvelope<T> = { expiresAt: Date.now() + ttlMilliseconds, value };
    const serialized = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(serialized);
    const fitsMemory = bytes <= this.#maxMemoryBytes;
    const fitsDisk = this.#directory !== undefined && bytes <= this.#maxDiskBytes;
    if (bytes > this.#maxEntryBytes || (!fitsMemory && !fitsDisk)) return false;
    if (fitsMemory) this.#remember(key, envelope, bytes);
    else this.#forget(key);
    if (!fitsDisk || this.#directory === undefined) return true;
    const directory = this.#directory;
    return this.#exclusive(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const target = join(directory, `${key}.json`);
      const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => undefined); }
      if (!await this.#pruneDisk()) {
        await unlink(target).catch(() => undefined);
        return false;
      }
      return true;
    });
  }

  stats(): { memoryEntries: number; memoryBytes: number } { return { memoryEntries: this.#memory.size, memoryBytes: this.#memoryBytes }; }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  #remember(key: string, envelope: CacheEnvelope<unknown>, bytes: number): void {
    this.#forget(key);
    this.#memory.set(key, { envelope, bytes });
    this.#memoryBytes += bytes;
    while (this.#memory.size > this.#maxMemoryEntries || this.#memoryBytes > this.#maxMemoryBytes) {
      const oldest = this.#memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
  }

  #forget(key: string): void {
    const prior = this.#memory.get(key);
    if (prior === undefined) return;
    this.#memory.delete(key);
    this.#memoryBytes -= prior.bytes;
  }

  async #pruneDisk(): Promise<boolean> {
    if (this.#directory === undefined) return true;
    const retained: DiskEntry[] = [];
    let total = 0;
    const directory = await opendir(this.#directory).catch(() => undefined);
    if (directory === undefined) return true;
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > this.#maxDiskScanEntries) return false;
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(this.#directory, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info === undefined) continue;
        if (info.size <= 0 || info.size > this.#maxEntryBytes) { await unlink(path).catch(() => undefined); continue; }
        retained.push({ path, size: info.size, modified: info.mtimeMs });
        total += info.size;
        retained.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
        while (retained.length > this.#maxDiskEntries || total > this.#maxDiskBytes) {
          const oldest = retained.pop();
          if (oldest === undefined) break;
          total -= oldest.size;
          await unlink(oldest.path).catch(() => undefined);
        }
      }
    } finally { await directory.close().catch(() => undefined); }
    return true;
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive finite integer`);
  return value;
}
function cacheKey(namespace: string, input: unknown): string { return createHash("sha256").update(`${namespace}\0${stable(input)}`).digest("hex"); }
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
