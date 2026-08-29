import { randomBytes } from "node:crypto";
import { sha256Hex } from "@webx/artifacts";
import type { ActorIdentity } from "@webx/browser-protocol";
import { actorKey } from "../actor/identity.js";

interface ArtifactRecord {
  readonly id: string;
  readonly owner: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface ArtifactDescriptor {
  artifactId: string;
  mediaType: "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
}

export interface BrowserArtifactStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxItemBytes?: number;
  retentionMs?: number;
  now?: () => number;
}

export class BrowserArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private total = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxItemBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: BrowserArtifactStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 128;
    this.maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
    this.maxItemBytes = options.maxItemBytes ?? 16 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get entryCount(): number { return this.records.size; }
  get totalBytes(): number { return this.total; }

  async put(actor: ActorIdentity, bytes: Uint8Array, mediaType: "image/png" | "image/jpeg"): Promise<ArtifactDescriptor> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxItemBytes) throw new Error("Artifact size is outside the configured limit.");
    this.prune();
    while (this.records.size >= this.maxEntries || this.total + bytes.byteLength > this.maxTotalBytes) {
      if (!this.removeOldest()) throw new Error("Artifact storage is full.");
    }
    const now = this.now();
    const id = `artifact_${randomBytes(24).toString("base64url")}`;
    const copy = bytes.slice();
    const record: ArtifactRecord = {
      id, owner: actorKey(actor), mediaType, bytes: copy,
      sha256: await sha256Hex(copy), createdAtMs: now, expiresAtMs: now + this.retentionMs,
    };
    this.records.set(id, record);
    this.total += copy.byteLength;
    return descriptor(record);
  }

  async read(actor: ActorIdentity, id: string): Promise<Uint8Array> {
    this.prune();
    const record = this.records.get(id);
    if (record === undefined || record.owner !== actorKey(actor)) throw new Error("Artifact not found.");
    const copy = record.bytes.slice();
    if (await sha256Hex(copy) !== record.sha256) { this.delete(id); throw new Error("Artifact integrity check failed."); }
    return copy;
  }

  prune(): void {
    const now = this.now();
    for (const [id, record] of this.records) if (record.expiresAtMs <= now) this.delete(id);
  }

  clearActor(actor: ActorIdentity): void {
    const owner = actorKey(actor);
    for (const [id, record] of this.records) if (record.owner === owner) this.delete(id);
  }

  clear(): void { this.records.clear(); this.total = 0; }

  private removeOldest(): boolean {
    const id = this.records.keys().next().value;
    if (typeof id !== "string") return false;
    this.delete(id);
    return true;
  }

  private delete(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.total -= record.bytes.byteLength;
    this.records.delete(id);
  }
}

function descriptor(record: ArtifactRecord): ArtifactDescriptor {
  return { artifactId: record.id, mediaType: record.mediaType, sizeBytes: record.bytes.byteLength, sha256: record.sha256, expiresAt: new Date(record.expiresAtMs).toISOString() };
}
