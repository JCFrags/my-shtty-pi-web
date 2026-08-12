import { describe, expect, it } from "vitest";
import {
  ArtifactError,
  ContentAddressedStore,
  MemoryArtifactBackend,
  TransferHandleStore,
  boundedExcerpt,
  safeArtifactPath,
  sha256Hex,
} from "../src/index.js";

function expectArtifactCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining<Partial<ArtifactError>>({ code }));
}

async function expectArtifactCodeAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ code });
}

describe("content-addressed artifacts", () => {
  it("commits and verifies immutable content by digest", async () => {
    const backend = new MemoryArtifactBackend();
    const store = new ContentAddressedStore(backend);
    const bytes = new TextEncoder().encode("trusted bytes, untrusted meaning");
    const committed = await store.commit(bytes);
    expect(committed.sha256).toBe(await sha256Hex(bytes));
    expect(await store.readVerified(committed.sha256)).toEqual(bytes);
  });

  it("quarantines bytes after digest corruption", async () => {
    const backend = new MemoryArtifactBackend();
    const store = new ContentAddressedStore(backend);
    const committed = await store.commit(new TextEncoder().encode("original"));
    backend.objects.set(committed.key, new TextEncoder().encode("tampered"));

    await expectArtifactCodeAsync(() => store.readVerified(committed.sha256), "WEBX_ARTIFACT_CORRUPT");
    expect(backend.objects.has(committed.key)).toBe(false);
    expect([...backend.objects.keys()].some((key) => key.startsWith("quarantine/corrupt/"))).toBe(true);
  });

  it.each(["../secret", "safe/../../secret", "/absolute", "safe\\escape", "safe//file"])(
    "refuses traversal or unsafe artifact path %s",
    (path) => expectArtifactCode(() => safeArtifactPath(path), "WEBX_POLICY_FILE_PATH_DENIED"),
  );
});

describe("bounded excerpts", () => {
  it("returns bounded Unicode text and exact byte coordinates", () => {
    const excerpt = boundedExcerpt("first\nαβγ\nthird\nfourth", {
      startLine: 2,
      maxLines: 2,
      maxChars: 5,
    });
    expect(excerpt.untrustedContent).toBe("αβγ\nt");
    expect(excerpt.startByte).toBe(new TextEncoder().encode("first\n").byteLength);
    expect(excerpt.endByte - excerpt.startByte).toBe(new TextEncoder().encode("αβγ\nt").byteLength);
    expect(excerpt.truncated).toBe(true);
  });

  it("refuses excessive excerpt bounds", () => {
    expectArtifactCode(
      () => boundedExcerpt("body", { maxChars: 100_001 }),
      "WEBX_BUDGET_INVALID",
    );
  });
});

describe("actor-bound one-use transfer handles", () => {
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  it("consumes an upload handle once", async () => {
    const handles = new TransferHandleStore(now);
    const bytes = new TextEncoder().encode("upload");
    const handle = handles.issue({
      kind: "upload",
      actorId: "actor-a",
      purpose: "document.inspect",
      expiresAt: "2026-08-12T10:01:00.000Z",
      maxBytes: bytes.byteLength,
      expectedSha256: await sha256Hex(bytes),
    });
    await expect(handles.consumeUpload(handle.id, "actor-a", "document.inspect", bytes)).resolves.toEqual(bytes);
    await expectArtifactCodeAsync(
      () => handles.consumeUpload(handle.id, "actor-a", "document.inspect", bytes),
      "WEBX_INPUT_HANDLE_EXPIRED",
    );
  });

  it("refuses cross-owner download reuse", () => {
    const handles = new TransferHandleStore(now);
    const handle = handles.issue({
      kind: "download",
      actorId: "actor-a",
      purpose: "worker.input",
      artifactId: "artifact-1",
      expiresAt: "2026-08-12T10:01:00.000Z",
      maxBytes: 64,
    });
    expectArtifactCode(
      () => handles.consumeDownload(handle.id, "actor-b", "worker.input"),
      "WEBX_SCOPE_REQUIRED",
    );
    expectArtifactCode(
      () => handles.consumeDownload(handle.id, "actor-a", "worker.input"),
      "WEBX_INPUT_HANDLE_EXPIRED",
    );
  });

  it("consumes an oversized upload handle without accepting bytes", async () => {
    const handles = new TransferHandleStore(now);
    const handle = handles.issue({
      kind: "upload",
      actorId: "actor-a",
      purpose: "artifact.upload",
      expiresAt: "2026-08-12T10:01:00.000Z",
      maxBytes: 2,
    });
    await expectArtifactCodeAsync(
      () => handles.consumeUpload(handle.id, "actor-a", "artifact.upload", new Uint8Array(3)),
      "WEBX_OUTPUT_TOO_LARGE",
    );
    await expectArtifactCodeAsync(
      () => handles.consumeUpload(handle.id, "actor-a", "artifact.upload", new Uint8Array(1)),
      "WEBX_INPUT_HANDLE_EXPIRED",
    );
  });
});
