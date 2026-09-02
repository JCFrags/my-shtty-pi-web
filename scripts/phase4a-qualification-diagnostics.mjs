// @ts-check

import { lstat, open } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_RING = 4_096;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024;
const DEFAULT_KINDS = new Set([
  "acceptanceStarted", "frontendReady", "milestone", "connection", "snapshot", "selectionRequested", "selection", "selectionCleared",
  "windowAction", "launcherError", "frameReceived", "frameSettled",
]);

/** @typedef {{readonly sequence: number, readonly record: Record<string, unknown>}} DiagnosticEntry */

export class QualificationDiagnosticsError extends Error {
  /** @type {string} */
  code = "";
  constructor(/** @type {string} */ code) {
    /** @type {Record<string, string>} */
    const messages = {
      unsafe: "qualification diagnostics are unsafe",
      replaced: "qualification diagnostics were replaced",
      truncated: "qualification diagnostics were truncated",
      invalid: "qualification diagnostics are invalid",
      "cursor-expired": "qualification diagnostics cursor expired",
    };
    super(messages[code]);
    this.name = "QualificationDiagnosticsError";
    this.code = code;
  }
}

/**
 * Incrementally reads the owner-private Workspace JSONL journal.
 * The reader never rereads already consumed bytes and rejects identity,
 * truncation, permission, encoding, and record-bound violations.
 */
export class QualificationDiagnosticsReader {
  /** @type {string} */
  path = "";
  /** @type {number} */
  maxBytes = 0;
  /** @type {number} */
  maxRecords = 0;
  /** @type {number} */
  maxRing = 0;
  /** @type {number} */
  maxLineBytes = 0;
  /** @type {ReadonlySet<string>} */
  kinds = DEFAULT_KINDS;
  /** @type {number} */
  offset = 0;
  /** @type {string} */
  partial = "";
  /** @type {TextDecoder} */
  decoder = new TextDecoder("utf-8", { fatal: true });
  /** @type {number} */
  sequence = 0;
  /** @type {DiagnosticEntry[]} */
  entries = [];
  /** @type {{dev: number, ino: number} | undefined} */
  identity = undefined;
  /** @type {Promise<void> | undefined} */
  refreshPromise = undefined;
  /**
   * @param {string} path
   * @param {{maxBytes?: number, maxRecords?: number, maxRing?: number, maxLineBytes?: number, kinds?: ReadonlySet<string>}} [options]
   */
  constructor(path, options = {}) {
    if (typeof path !== "string" || path.length === 0 || !path.startsWith("/") || /[\0\r\n]/u.test(path)
      || typeof options !== "object" || options === null || Array.isArray(options)) throw new QualificationDiagnosticsError("unsafe");
    this.path = path;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRing = options.maxRing ?? DEFAULT_MAX_RING;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const kinds = options.kinds ?? DEFAULT_KINDS;
    if (typeof kinds !== "object" || kinds === null || typeof kinds.has !== "function" || typeof kinds[Symbol.iterator] !== "function") throw new QualificationDiagnosticsError("unsafe");
    try {
      this.kinds = new Set(kinds);
    } catch {
      throw new QualificationDiagnosticsError("unsafe");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1
      || !Number.isSafeInteger(this.maxRing) || this.maxRing < 1 || !Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1
      || this.maxLineBytes > this.maxBytes || this.kinds.size === 0 || [...this.kinds].some((kind) => typeof kind !== "string" || kind.length === 0 || kind.length > 64)) throw new QualificationDiagnosticsError("unsafe");
  }

  /** @returns {Promise<Record<string, unknown>[]>} */
  async records() {
    if (this.refreshPromise !== undefined) {
      await this.refreshPromise;
      return this.entries.map((entry) => entry.record);
    }
    this.refreshPromise = this.refresh();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
    return this.entries.map((entry) => entry.record);
  }

  /** @returns {Promise<number>} */
  async index() {
    await this.records();
    return this.sequence;
  }

  /**
   * @param {(record: Record<string, unknown>) => boolean} predicate
   * @param {number} from
   * @returns {Promise<Record<string, unknown> | undefined>}
   */
  async find(predicate, from) {
    if (!Number.isSafeInteger(from) || from < 0) throw new QualificationDiagnosticsError("unsafe");
    await this.records();
    const match = this.entries.find((entry) => entry.sequence >= from && predicate(entry.record));
    if (match !== undefined) return match.record;
    const oldest = this.entries[0]?.sequence;
    if (oldest !== undefined && from < oldest) throw new QualificationDiagnosticsError("cursor-expired");
    return undefined;
  }

  /** @returns {Promise<void>} */
  async refresh() {
    let information;
    try {
      information = await lstat(this.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        if (this.identity !== undefined) throw new QualificationDiagnosticsError("replaced");
        return;
      }
      throw error;
    }
    this.assertSafeStat(information, false);
    const identity = { dev: information.dev, ino: information.ino };
    if (this.identity === undefined) this.identity = identity;
    else if (!sameIdentity(this.identity, identity)) throw new QualificationDiagnosticsError("replaced");
    if (information.size < this.offset) throw new QualificationDiagnosticsError("truncated");
    if (information.size === this.offset) return;

    const handle = await open(this.path, "r");
    try {
      const opened = await handle.stat();
      this.assertSafeStat(opened, true);
      if (!sameIdentity(identity, { dev: opened.dev, ino: opened.ino }) || opened.size < this.offset) throw new QualificationDiagnosticsError("replaced");
      const target = information.size;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, this.maxLineBytes)));
      while (this.offset < target) {
        const wanted = Math.min(chunk.byteLength, target - this.offset);
        const result = await handle.read(chunk, 0, wanted, this.offset);
        if (result.bytesRead <= 0) break;
        let decoded;
        try {
          decoded = this.decoder.decode(chunk.subarray(0, result.bytesRead), { stream: true });
        } catch {
          throw new QualificationDiagnosticsError("invalid");
        }
        this.partial += decoded;
        if (Buffer.byteLength(this.partial, "utf8") > this.maxLineBytes) throw new QualificationDiagnosticsError("unsafe");
        this.consumeCompleteLines();
        this.offset += result.bytesRead;
      }
      const after = await handle.stat();
      this.assertSafeStat(after, true);
      if (!sameIdentity(identity, { dev: after.dev, ino: after.ino }) || after.size < this.offset) throw new QualificationDiagnosticsError("replaced");
    } finally {
      await handle.close();
    }
  }

  /** @param {import("node:fs").Stats} information @param {boolean} opened */
  assertSafeStat(information, opened) {
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1 || information.uid !== process.getuid?.() || information.gid !== process.getgid?.()
      || (information.mode & 0o777) !== 0o600 || information.size > this.maxBytes) throw new QualificationDiagnosticsError(opened ? "replaced" : "unsafe");
  }

  consumeCompleteLines() {
    for (;;) {
      const newline = this.partial.indexOf("\n");
      if (newline < 0) return;
      const line = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      if (line.length === 0 || Buffer.byteLength(line, "utf8") > this.maxLineBytes) throw new QualificationDiagnosticsError("invalid");
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new QualificationDiagnosticsError("invalid");
      }
      if (!isRecord(value) || typeof value.kind !== "string" || !this.kinds.has(value.kind) || typeof value.recordedAt !== "string"
        || value.recordedAt.length === 0 || value.recordedAt.length > 64 || /[\0\r\n]/u.test(value.recordedAt)) throw new QualificationDiagnosticsError("invalid");
      this.entries.push({ sequence: this.sequence, record: value });
      this.sequence += 1;
      if (this.entries.length > this.maxRing) this.entries.shift();
      if (this.sequence > this.maxRecords) throw new QualificationDiagnosticsError("unsafe");
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {{dev: number, ino: number}} left @param {{dev: number, ino: number}} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
