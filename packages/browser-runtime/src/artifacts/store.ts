import { randomBytes } from "node:crypto";
import { sha256Hex } from "@webx/artifacts";
import { BrowserProtocolError, type ActorIdentity } from "@webx/browser-protocol";
import { actorKey } from "../actor/identity.js";

export type ArtifactPurpose = "agent-observation" | "workspace-frame";
export type BrowserMediaType = "image/png";

interface ArtifactRecord {
  readonly id: string;
  readonly owner: string;
  readonly browserSessionId: string;
  readonly tabId?: string;
  readonly purpose: ArtifactPurpose;
  readonly mediaType: BrowserMediaType;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  pinCount: number;
}

export interface ArtifactDescriptor {
  artifactId: string;
  browserSessionId: string;
  tabId?: string;
  purpose: ArtifactPurpose;
  mediaType: BrowserMediaType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface ArtifactPutOptions {
  browserSessionId: string;
  tabId?: string;
  purpose: ArtifactPurpose;
  mediaType: BrowserMediaType;
  latestFrameKey?: string;
}

export interface ArtifactRead { descriptor: ArtifactDescriptor; bytes: Uint8Array }

export interface BrowserArtifactStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxItemBytes?: number;
  maxEntriesPerOwner?: number;
  maxBytesPerOwner?: number;
  maxEntriesPerSession?: number;
  maxBytesPerSession?: number;
  retentionMs?: number;
  frameRingSize?: number;
  now?: () => number;
}

export class BrowserArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly framePins = new Map<string, string[]>();
  private total = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxItemBytes: number;
  private readonly maxEntriesPerOwner: number;
  private readonly maxBytesPerOwner: number;
  private readonly maxEntriesPerSession: number;
  private readonly maxBytesPerSession: number;
  private readonly retentionMs: number;
  private readonly frameRingSize: number;
  private readonly now: () => number;

  constructor(options: BrowserArtifactStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.maxTotalBytes = options.maxTotalBytes ?? 192 * 1024 * 1024;
    this.maxItemBytes = options.maxItemBytes ?? 16 * 1024 * 1024;
    this.maxEntriesPerOwner = options.maxEntriesPerOwner ?? Math.min(128, this.maxEntries);
    this.maxBytesPerOwner = options.maxBytesPerOwner ?? Math.min(96 * 1024 * 1024, this.maxTotalBytes);
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? Math.min(96, this.maxEntriesPerOwner);
    this.maxBytesPerSession = options.maxBytesPerSession ?? Math.min(64 * 1024 * 1024, this.maxBytesPerOwner);
    this.retentionMs = options.retentionMs ?? 5 * 60_000;
    this.frameRingSize = options.frameRingSize ?? 2;
    this.now = options.now ?? Date.now;
  }

  get entryCount(): number { return this.records.size; }
  get totalBytes(): number { return this.total; }

  stats(): Array<{ owner: string; browserSessionId: string; purpose: ArtifactPurpose; count: number; bytes: number }> {
    const values = new Map<string, { owner: string; browserSessionId: string; purpose: ArtifactPurpose; count: number; bytes: number }>();
    for (const record of this.records.values()) {
      const key = `${record.owner}\u0001${record.browserSessionId}\u0001${record.purpose}`;
      const value = values.get(key) ?? { owner: record.owner, browserSessionId: record.browserSessionId, purpose: record.purpose, count: 0, bytes: 0 };
      value.count++;
      value.bytes += record.bytes.byteLength;
      values.set(key, value);
    }
    return [...values.values()];
  }

  async put(actor: ActorIdentity, bytes: Uint8Array, options: ArtifactPutOptions): Promise<ArtifactDescriptor> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxItemBytes) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Artifact size is outside the configured limit.");
    this.prune();
    const owner = actorKey(actor);
    if (options.latestFrameKey !== undefined) this.releaseOldestFramePinForReplacement(options.latestFrameKey);
    this.makeRoom(owner, options.browserSessionId, bytes.byteLength);
    const now = this.now();
    const id = `artifact_${randomBytes(24).toString("base64url")}`;
    const copy = bytes.slice();
    const record: ArtifactRecord = {
      id, owner, browserSessionId: options.browserSessionId,
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
      purpose: options.purpose, mediaType: options.mediaType, bytes: copy,
      sha256: await sha256Hex(copy), createdAtMs: now, expiresAtMs: now + this.retentionMs, pinCount: 0,
    };
    this.records.set(id, record);
    this.total += copy.byteLength;
    if (options.latestFrameKey !== undefined) this.pinLatest(options.latestFrameKey, id);
    return descriptor(record);
  }

  async read(actor: ActorIdentity, id: string): Promise<ArtifactRead> {
    this.prune();
    const record = this.records.get(id);
    if (record === undefined || record.owner !== actorKey(actor)) throw new BrowserProtocolError("ARTIFACT_NOT_FOUND", "Artifact not found.");
    const copy = record.bytes.slice();
    if (await sha256Hex(copy) !== record.sha256) { this.delete(id); throw new BrowserProtocolError("INTERNAL_ERROR", "Artifact integrity verification failed."); }
    return { descriptor: descriptor(record), bytes: copy };
  }

  revoke(actor: ActorIdentity, id: string): void {
    const record = this.records.get(id);
    if (record === undefined || record.owner !== actorKey(actor)) throw new BrowserProtocolError("ARTIFACT_NOT_FOUND", "Artifact not found.");
    this.delete(id);
  }

  prune(): void {
    const now = this.now();
    for (const [id, record] of this.records) if (record.expiresAtMs <= now && record.pinCount === 0) this.delete(id);
  }

  clearTab(actor: ActorIdentity, browserSessionId: string, tabId: string): void {
    const owner = actorKey(actor);
    for (const [id, record] of this.records) if (record.owner === owner && record.browserSessionId === browserSessionId && record.tabId === tabId) this.delete(id);
  }

  clearSession(actor: ActorIdentity, browserSessionId: string): void {
    const owner = actorKey(actor);
    for (const [id, record] of this.records) if (record.owner === owner && record.browserSessionId === browserSessionId) this.delete(id);
  }

  clearActor(actor: ActorIdentity): void {
    const owner = actorKey(actor);
    for (const [id, record] of this.records) if (record.owner === owner) this.delete(id);
  }

  clear(): void { this.records.clear(); this.framePins.clear(); this.total = 0; }

  private makeRoom(owner: string, session: string, bytes: number): void {
    while (this.scopeCount((record) => record.owner === owner) >= this.maxEntriesPerOwner || this.scopeBytes((record) => record.owner === owner) + bytes > this.maxBytesPerOwner) {
      if (!this.removeOldest((record) => record.owner === owner)) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Artifact owner quota is full.", true);
    }
    while (this.scopeCount((record) => record.owner === owner && record.browserSessionId === session) >= this.maxEntriesPerSession || this.scopeBytes((record) => record.owner === owner && record.browserSessionId === session) + bytes > this.maxBytesPerSession) {
      if (!this.removeOldest((record) => record.owner === owner && record.browserSessionId === session)) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Artifact session quota is full.", true);
    }
    while (this.records.size >= this.maxEntries || this.total + bytes > this.maxTotalBytes) {
      if (!this.removeOldest((record) => record.owner === owner)) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Global artifact capacity is occupied by another owner.", true);
    }
  }

  private scopeCount(predicate: (record: ArtifactRecord) => boolean): number { let count = 0; for (const record of this.records.values()) if (predicate(record)) count++; return count; }
  private scopeBytes(predicate: (record: ArtifactRecord) => boolean): number { let bytes = 0; for (const record of this.records.values()) if (predicate(record)) bytes += record.bytes.byteLength; return bytes; }
  private removeOldest(predicate: (record: ArtifactRecord) => boolean): boolean { for (const [id, record] of this.records) { if (record.pinCount === 0 && predicate(record)) { this.delete(id); return true; } } return false; }

  private releaseOldestFramePinForReplacement(key: string): void {
    const ring = this.framePins.get(key);
    if (ring === undefined || ring.length < this.frameRingSize) return;
    const old = ring.shift();
    if (old !== undefined) {
      const prior = this.records.get(old);
      if (prior !== undefined) prior.pinCount = Math.max(0, prior.pinCount - 1);
    }
    if (ring.length === 0) this.framePins.delete(key);
  }

  private pinLatest(key: string, id: string): void {
    const ring = this.framePins.get(key) ?? [];
    const record = this.records.get(id);
    if (record === undefined) return;
    record.pinCount++;
    ring.push(id);
    while (ring.length > this.frameRingSize) {
      const old = ring.shift();
      if (old !== undefined) {
        const prior = this.records.get(old);
        if (prior !== undefined) prior.pinCount = Math.max(0, prior.pinCount - 1);
      }
    }
    this.framePins.set(key, ring);
  }

  private delete(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.total -= record.bytes.byteLength;
    this.records.delete(id);
    for (const [key, ids] of this.framePins) {
      const filtered = ids.filter((value) => value !== id);
      if (filtered.length === 0) this.framePins.delete(key); else if (filtered.length !== ids.length) this.framePins.set(key, filtered);
    }
  }
}

function descriptor(record: ArtifactRecord): ArtifactDescriptor {
  return {
    artifactId: record.id, browserSessionId: record.browserSessionId,
    ...(record.tabId !== undefined ? { tabId: record.tabId } : {}), purpose: record.purpose,
    mediaType: record.mediaType, sizeBytes: record.bytes.byteLength, sha256: record.sha256,
    createdAt: new Date(record.createdAtMs).toISOString(), expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}
