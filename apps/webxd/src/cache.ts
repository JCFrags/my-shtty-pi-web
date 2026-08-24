import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

interface CacheEnvelope<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export interface WebCacheOptions {
  readonly directory?: string;
  readonly maxMemoryEntries?: number;
  readonly maxDiskBytes?: number;
}

/** Short-lived public web cache. This is not a research archive or page library. */
export class WebCache {
  readonly #memory = new Map<string, CacheEnvelope<unknown>>();
  readonly #directory?: string;
  readonly #maxMemoryEntries: number;
  readonly #maxDiskBytes: number;
  #writes = 0;

  constructor(options: WebCacheOptions = {}) {
    this.#directory = options.directory;
    this.#maxMemoryEntries = options.maxMemoryEntries ?? 512;
    this.#maxDiskBytes = options.maxDiskBytes ?? 2 * 1024 * 1024 * 1024;
  }

  async get<T>(namespace: string, input: unknown): Promise<T | undefined> {
    const key = cacheKey(namespace, input);
    const memory = this.#memory.get(key);
    if (memory !== undefined) {
      if (memory.expiresAt > Date.now()) {
        this.#memory.delete(key);
        this.#memory.set(key, memory);
        return memory.value as T;
      }
      this.#memory.delete(key);
    }
    if (this.#directory === undefined) return undefined;
    try {
      const envelope = JSON.parse(await readFile(join(this.#directory, `${key}.json`), "utf8")) as CacheEnvelope<T>;
      if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= Date.now()) {
        await unlink(join(this.#directory, `${key}.json`)).catch(() => undefined);
        return undefined;
      }
      this.#remember(key, envelope);
      return envelope.value;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  async set<T>(namespace: string, input: unknown, value: T, ttlMilliseconds: number): Promise<void> {
    const key = cacheKey(namespace, input);
    const envelope: CacheEnvelope<T> = { expiresAt: Date.now() + ttlMilliseconds, value };
    this.#remember(key, envelope);
    if (this.#directory === undefined) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const target = join(this.#directory, `${key}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporary, target);
    this.#writes += 1;
    if (this.#writes % 100 === 0) await this.#pruneDisk();
  }

  #remember(key: string, envelope: CacheEnvelope<unknown>): void {
    this.#memory.delete(key);
    this.#memory.set(key, envelope);
    while (this.#memory.size > this.#maxMemoryEntries) {
      const oldest = this.#memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#memory.delete(oldest);
    }
  }

  async #pruneDisk(): Promise<void> {
    if (this.#directory === undefined) return;
    const entries = await readdir(this.#directory).catch(() => [] as string[]);
    const files = await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join(this.#directory!, name);
      const info = await stat(path).catch(() => undefined);
      return info === undefined ? undefined : { path, size: info.size, modified: info.mtimeMs };
    }));
    const present = files.filter((item): item is NonNullable<typeof item> => item !== undefined).sort((a, b) => a.modified - b.modified);
    let total = present.reduce((sum, item) => sum + item.size, 0);
    for (const item of present) {
      if (total <= this.#maxDiskBytes) break;
      await unlink(item.path).catch(() => undefined);
      total -= item.size;
    }
  }
}

function cacheKey(namespace: string, input: unknown): string {
  return createHash("sha256").update(`${namespace}\0${stable(input)}`).digest("hex");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
