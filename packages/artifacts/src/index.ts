const sha256Pattern = /^[0-9a-f]{64}$/;

export class ArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertSha256(value: string): void {
  if (!sha256Pattern.test(value)) {
    throw new ArtifactError("WEBX_REQUEST_INVALID", "The SHA-256 digest must be 64 lowercase hexadecimal characters.");
  }
}

export function safeArtifactPath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    /^[a-zA-Z]:/.test(relativePath) ||
    Array.from(relativePath).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new ArtifactError("WEBX_POLICY_FILE_PATH_DENIED", "The artifact path is not a safe relative path.");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ArtifactError("WEBX_POLICY_FILE_PATH_DENIED", "The artifact path contains a forbidden segment.");
  }
  return parts.join("/");
}

export interface ArtifactByteBackend {
  read(key: string): Promise<Uint8Array>;
  writeIfAbsent(key: string, bytes: Uint8Array): Promise<void>;
  move(sourceKey: string, destinationKey: string): Promise<void>;
}

export class MemoryArtifactBackend implements ArtifactByteBackend {
  readonly objects = new Map<string, Uint8Array>();

  async read(key: string): Promise<Uint8Array> {
    const value = this.objects.get(safeArtifactPath(key));
    if (value === undefined) throw new ArtifactError("WEBX_ARTIFACT_NOT_FOUND", "The artifact bytes do not exist.");
    return value.slice();
  }

  async writeIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
    const safeKey = safeArtifactPath(key);
    if (!this.objects.has(safeKey)) this.objects.set(safeKey, bytes.slice());
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    const source = safeArtifactPath(sourceKey);
    const destination = safeArtifactPath(destinationKey);
    const value = this.objects.get(source);
    if (value === undefined) throw new ArtifactError("WEBX_ARTIFACT_NOT_FOUND", "The artifact bytes do not exist.");
    this.objects.set(destination, value);
    this.objects.delete(source);
  }
}

export interface CommittedBlob {
  sha256: string;
  sizeBytes: number;
  key: string;
}

export class ContentAddressedStore {
  private quarantineSequence = 0;

  constructor(private readonly backend: ArtifactByteBackend) {}

  keyForDigest(digest: string): string {
    assertSha256(digest);
    return `blobs/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  }

  async commit(bytes: Uint8Array, expectedSha256?: string): Promise<CommittedBlob> {
    const digest = await sha256Hex(bytes);
    if (expectedSha256 !== undefined) {
      assertSha256(expectedSha256);
      if (digest !== expectedSha256) {
        throw new ArtifactError("WEBX_HASH_MISMATCH", "The uploaded content does not match its declared digest.");
      }
    }
    const key = this.keyForDigest(digest);
    await this.backend.writeIfAbsent(key, bytes);
    await this.readVerified(digest);
    return { sha256: digest, sizeBytes: bytes.byteLength, key };
  }

  async readVerified(digest: string): Promise<Uint8Array> {
    const key = this.keyForDigest(digest);
    const bytes = await this.backend.read(key);
    const actual = await sha256Hex(bytes);
    if (actual !== digest) {
      this.quarantineSequence += 1;
      const quarantineKey = `quarantine/corrupt/${digest}-${this.quarantineSequence}`;
      await this.backend.move(key, quarantineKey);
      throw new ArtifactError("WEBX_ARTIFACT_CORRUPT", `Artifact integrity failed; bytes moved to ${quarantineKey}.`);
    }
    return bytes;
  }
}

export interface ExcerptOptions {
  startLine?: number;
  maxLines?: number;
  maxChars?: number;
}

export interface ArtifactExcerpt {
  untrustedContent: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  truncated: boolean;
}

export function boundedExcerpt(source: string, options: ExcerptOptions = {}): ArtifactExcerpt {
  const startLine = options.startLine ?? 1;
  const maxLines = options.maxLines ?? 40;
  const maxChars = options.maxChars ?? 4000;
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new ArtifactError("WEBX_REQUEST_INVALID", "startLine must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1000) {
    throw new ArtifactError("WEBX_BUDGET_INVALID", "maxLines must be between 1 and 1000.");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 100_000) {
    throw new ArtifactError("WEBX_BUDGET_INVALID", "maxChars must be between 1 and 100000.");
  }

  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const effectiveStartLine = Math.min(startLine, lineStarts.length);
  const startIndex = lineStarts[effectiveStartLine - 1] ?? source.length;
  const lineLimitIndex = effectiveStartLine - 1 + maxLines;
  const regionEnd = lineStarts[lineLimitIndex] ?? source.length;
  const region = source.slice(startIndex, regionEnd);
  const characters = Array.from(region);
  const untrustedContent = characters.slice(0, maxChars).join("");
  const endIndex = startIndex + untrustedContent.length;
  const linesInExcerpt = untrustedContent === ""
    ? 0
    : untrustedContent.split("\n").length - (untrustedContent.endsWith("\n") ? 1 : 0);

  return {
    untrustedContent,
    startLine: effectiveStartLine,
    endLine: Math.max(effectiveStartLine, effectiveStartLine + linesInExcerpt - 1),
    startByte: new TextEncoder().encode(source.slice(0, startIndex)).byteLength,
    endByte: new TextEncoder().encode(source.slice(0, endIndex)).byteLength,
    truncated: endIndex < source.length,
  };
}

export type HandleKind = "upload" | "download";

export interface HandleDescriptor {
  id: string;
  kind: HandleKind;
  actorId: string;
  purpose: string;
  expiresAt: string;
  maxBytes: number;
  artifactId?: string;
  expectedSha256?: string;
}

interface StoredHandle extends HandleDescriptor {
  consumed: boolean;
}

function randomHandleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `wh_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class TransferHandleStore {
  private readonly handles = new Map<string, StoredHandle>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(input: Omit<HandleDescriptor, "id">): Readonly<HandleDescriptor> {
    if (input.actorId === "" || input.purpose === "") {
      throw new ArtifactError("WEBX_REQUEST_INVALID", "A handle requires an actor and one purpose.");
    }
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw new ArtifactError("WEBX_BUDGET_INVALID", "A handle requires a finite positive byte limit.");
    }
    const expiresAt = new Date(input.expiresAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(input.expiresAt) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= this.now()) {
      throw new ArtifactError("WEBX_REQUEST_INVALID", "A handle expiry must be in the future.");
    }
    if (input.kind === "download" && input.artifactId === undefined) {
      throw new ArtifactError("WEBX_REQUEST_INVALID", "A download handle requires an artifact ID.");
    }
    if (input.expectedSha256 !== undefined) assertSha256(input.expectedSha256);

    const id = randomHandleId();
    const descriptor: StoredHandle = { ...input, id, consumed: false };
    this.handles.set(descriptor.id, descriptor);
    const publicDescriptor: HandleDescriptor = { ...input, id };
    return Object.freeze(publicDescriptor);
  }

  async consumeUpload(id: string, actorId: string, purpose: string, bytes: Uint8Array): Promise<Uint8Array> {
    const handle = this.consume(id, actorId, purpose, "upload");
    if (bytes.byteLength > handle.maxBytes) {
      throw new ArtifactError("WEBX_OUTPUT_TOO_LARGE", "The upload exceeds its handle byte limit.");
    }
    if (handle.expectedSha256 !== undefined && await sha256Hex(bytes) !== handle.expectedSha256) {
      throw new ArtifactError("WEBX_HASH_MISMATCH", "The upload does not match its handle digest.");
    }
    return bytes.slice();
  }

  consumeDownload(id: string, actorId: string, purpose: string): string {
    const handle = this.consume(id, actorId, purpose, "download");
    if (handle.artifactId === undefined) {
      throw new ArtifactError("WEBX_INVARIANT_VIOLATION", "A download handle has no artifact ID.");
    }
    return handle.artifactId;
  }

  private consume(id: string, actorId: string, purpose: string, kind: HandleKind): StoredHandle {
    const handle = this.handles.get(id);
    if (handle === undefined || handle.consumed) {
      throw new ArtifactError("WEBX_INPUT_HANDLE_EXPIRED", "The transfer handle is missing or already used.");
    }
    handle.consumed = true;
    if (new Date(handle.expiresAt) <= this.now()) {
      throw new ArtifactError("WEBX_INPUT_HANDLE_EXPIRED", "The transfer handle has expired.");
    }
    if (handle.actorId !== actorId) {
      throw new ArtifactError("WEBX_SCOPE_REQUIRED", "The transfer handle belongs to another actor.");
    }
    if (handle.purpose !== purpose || handle.kind !== kind) {
      throw new ArtifactError("WEBX_SCOPE_REQUIRED", "The transfer handle cannot be used for this purpose.");
    }
    return handle;
  }
}
