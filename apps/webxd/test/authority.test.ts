import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebxAuthority } from "../src/authority.js";
import { PUBLIC_SOURCES } from "../src/fixtures.js";
import type { AuthorityActor, BrowserDaemonPort } from "../src/ports.js";

afterEach(() => vi.unstubAllGlobals());

const paths = [
  { pathId: "agent-browser/chrome", actions: ["navigate", "click"], observations: ["main", "visual"], visual: true, touch: false, uploads: false, downloads: true },
  { pathId: "pinchtab/chrome", actions: ["navigate", "fill", "wait"], observations: ["main", "interactive"], visual: false, touch: false, uploads: false, downloads: false },
] as const;

function actor(principalId = "principal-a", agentId = "agent-a"): AuthorityActor {
  return { principalId, agentId, scopes: new Set(["system.read", "search.write", "retrieval.read", "research.write", "artifacts.read", "browser.read", "browser.write", "browser.control", "browser.debug"]) };
}

function browser(): BrowserDaemonPort {
  return {
    capabilities: vi.fn(async () => paths),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async (owner, request) => {
      const capabilities = paths.find((item) => item.pathId === request.pathId);
      if (capabilities === undefined) throw new Error("unsupported path");
      return { sessionId: "session-1", tabId: "tab-1", pathId: request.pathId, ownerPrincipalId: owner.principalId, ownerAgentId: owner.agentId, state: "ready", capabilities };
    }),
    getSession: vi.fn(async (owner) => ({ sessionId: "session-1", tabId: "tab-1", pathId: "agent-browser/chrome", ownerPrincipalId: owner.principalId, ownerAgentId: owner.agentId, state: "ready", capabilities: paths[0] })),
    observe: vi.fn(async () => ({ operationId: "op-observe", address: { sessionId: "session-1", tabId: "tab-1", pathId: "agent-browser/chrome", hostGeneration: 1, engineGeneration: 1, controlEpoch: 1 }, title: "Fixture", url: "https://fixture.invalid", content: "bounded", truncated: false })),
    captureFrame: vi.fn(async () => ({ address: { sessionId: "session-1", tabId: "tab-1", pathId: "agent-browser/chrome", hostGeneration: 1, engineGeneration: 1, controlEpoch: 1 }, mediaType: "image/png", width: 1, height: 1, payloadBase64: "", screenshotSha256: "a".repeat(64), screenshotSequence: 1, viewportId: "viewport-1", viewportGeneration: 1 })),
    act: vi.fn(async (_owner, _session, _action, operationId) => ({ operationId, state: "succeeded" })),
    debug: vi.fn(async (_owner, _sessionId, request, operationId) => ({ operationId, operation: request.operation, ok: true, data: {} })),
    workspace: vi.fn(async (_owner, request) => ({ action: request.action, data: {} })),
    setControl: vi.fn(async (_owner, sessionId, controller) => ({ sessionId, tabId: "tab-1", controller, controlEpoch: 2 })),
    cancel: vi.fn(async (_owner, operationId) => ({ operationId, state: "cancelled" })),
    closeTab: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

function authority(browserPort = browser(), readerUrl?: string) {
  return new WebxAuthority({ browser: browserPort, sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, readerUrl });
}

async function call(instance: WebxAuthority, owner: AuthorityActor, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, key?: string, maxResponseBytes = 1_048_576) {
  return instance.handle(owner, { method, path, body, maxResponseBytes, headers: key === undefined ? undefined : { "idempotency-key": key } });
}

describe("WebxAuthority", () => {
  it("serves bounded deterministic search, read, and research operations", async () => {
    const instance = authority();
    expect((await call(instance, actor(), "POST", "/v1/search", { query: "WebX routes", operation: "links", effort: "fast" }, "search-key-001")).status).toBe(200);
    const read = await call(instance, actor(), "POST", "/v1/read", { url: "https://fixture.invalid/webx", maxChars: 4 }, "read-key-001");
    expect(read.body).toMatchObject({ untrustedContent: "WebX", truncated: true });
    const incompatibleContinuation = await call(instance, actor(), "POST", "/v1/read", { url: "https://fixture.invalid/webx", contentOffset: 10, maxPages: 2 }, "read-key-002");
    expect(incompatibleContinuation).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect((await call(instance, actor(), "POST", "/v1/research", { question: "browser paths", maxSources: 2 }, "research-key-001")).status).toBe(200);
  });

  it("returns clean SearXNG order without lexical intent filtering or rescoring", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("q")).toBe("major changes in Fedora Linux 44 for desktop users");
      return new Response(JSON.stringify({ results: [
        { title: "Major definition", url: "https://dictionary.example/major", content: "A dictionary definition." },
        { title: "Fedora Linux 44 Changes", url: "https://fedoraproject.org/wiki/Releases/44/ChangeSet", content: "Major approved changes for Fedora Linux 44." },
        { title: "Fedora 44 desktop overview", url: "https://fedoramagazine.org/fedora-44-desktop/", content: "Desktop changes." },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({
      browser: browser(), sources: PUBLIC_SOURCES,
      clock: { now: () => "2026-08-12T00:00:00Z" },
      ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888",
    });
    const result = await call(instance, actor(), "POST", "/v1/search", { query: "major changes in Fedora Linux 44 for desktop users", operation: "links", effort: "fast" }, "search-fedora");
    expect(result).toMatchObject({ status: 200, body: { hits: [
      { title: "Fedora Linux 44 Changes", rank: 1 },
      { title: "Fedora 44 desktop overview", rank: 2 },
      { title: "Major definition", rank: 3 },
    ] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes the four fixed search recipes without linked traversal or synthesis", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("http://127.0.0.1:8888/search")) {
        return new Response(JSON.stringify({ results: Array.from({ length: 10 }, (_, index) => ({
          title: `Product guide ${index + 1}`, url: `https://docs.example.org/page-${index + 1}`,
          content: `Short search description ${index + 1}.`,
        })) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { url: string; query: string; maxPages?: number; maxDepth?: number };
      expect(body.query).toBe("Product feature support");
      expect(body).not.toHaveProperty("maxPages");
      expect(body).not.toHaveProperty("maxDepth");
      return new Response(JSON.stringify({ url: body.url, title: `Verified ${body.url.split("-").at(-1)}`, content: "Product feature support is documented in this independent source passage with useful detail.", truncated: false }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888", readerUrl: "http://127.0.0.1:8787" });
    const run = async (operation: "links" | "extracts", effort: "fast" | "quality", key: string) => {
      requests.length = 0;
      const result = await call(instance, actor(), "POST", "/v1/search", { query: "Product feature support", operation, effort, domains: ["docs.example.org"], freshness: "month" }, key);
      expect(result.status).toBe(200);
      const body = result.body as { hits: Array<{ snippet: string }>; metadata: { searches: number; pagesRead: number; linkedDepth: number } };
      const searches = requests.filter((item) => item.url.includes("/search"));
      const reads = requests.filter((item) => item.url.includes(":8787/"));
      expect(searches).toHaveLength(effort === "quality" ? 3 : 1);
      expect(searches.every((item) => new URL(item.url).searchParams.get("q")?.includes("site:docs.example.org") && new URL(item.url).searchParams.get("time_range") === "month")).toBe(true);
      expect(reads).toHaveLength(operation === "links" ? effort === "quality" ? 5 : 0 : effort === "quality" ? 5 : 3);
      expect(body.metadata).toEqual({ searches: searches.length, pagesRead: reads.length, linkedDepth: 0 });
      expect(body.hits).toHaveLength(operation === "links" ? 10 : effort === "quality" ? 5 : 3);
      if (operation === "extracts") expect(body.hits.every((hit) => hit.snippet.includes("independent source passage"))).toBe(true);
      return result;
    };
    await run("links", "fast", "recipe-fast-links");
    await run("links", "quality", "recipe-quality-links");
    await run("extracts", "fast", "recipe-fast-extracts");
    await run("extracts", "quality", "recipe-quality-extracts");
  });

  it("reads a bounded byte range into an integrity-checked owner artifact", async () => {
    const bytes = new TextEncoder().encode("abcde");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ url: "https://data.example/archive.warc.gz", offset: 10, length: 5, maxRedirects: 2 });
      return new Response(JSON.stringify({
        requestedUrl: "https://data.example/archive.warc.gz",
        finalUrl: "https://data.example/archive.warc.gz",
        statusCode: 206,
        mediaType: "application/warc",
        contentRange: "bytes 10-14/100",
        rangeStart: 10,
        rangeEnd: 14,
        totalBytes: 100,
        bodyBase64: "YWJjZGU=",
        bodyBytes: 5,
        sha256: digest,
        redirectChain: ["https://data.example/archive.warc.gz"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const ranged = await call(instance, actor(), "POST", "/v1/read-range", { url: "https://data.example/archive.warc.gz", offset: 10, length: 5, maxRedirects: 2 }, "range-read-001", 1_048_576);
    expect(ranged).toMatchObject({ status: 200, body: { statusCode: 206, bodyBytes: 5, sha256: digest, visibility: "internal", integrityVerified: true } });
    const artifactId = (ranged.body as { artifactId: string }).artifactId;
    const excerpt = await call(instance, actor(), "GET", `/v1/artifacts/${artifactId}/bytes?offset=0&max_bytes=5`);
    expect(excerpt).toMatchObject({ status: 200, body: { bodyBase64: "YWJjZGU=", sha256: digest, sizeBytes: 5, integrityVerified: true } });
    const denied = await call(instance, actor("principal-b", "agent-b"), "GET", `/v1/artifacts/${artifactId}/bytes?offset=0&max_bytes=5`);
    expect(denied).toMatchObject({ status: 404, body: { code: "not-found" } });
  });

  it("evicts old binary artifacts at the in-memory count bound", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({
        requestedUrl: request.url, finalUrl: request.url, statusCode: 206,
        mediaType: "application/octet-stream", contentRange: "bytes 0-0/1",
        rangeStart: 0, rangeEnd: 0, totalBytes: 1, bodyBase64: "YQ==", bodyBytes: 1,
        sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
        redirectChain: [request.url],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const instance = authority(browser(), "http://127.0.0.1:8787");
    let oldest = "";
    for (let index = 0; index < 65; index += 1) {
      const result = await call(instance, actor(), "POST", "/v1/read-range", { url: `https://data.example/${index}.warc`, offset: 0, length: 1 }, `range-evict-${index}`);
      if (index === 0) oldest = (result.body as { artifactId: string }).artifactId;
    }
    expect(await call(instance, actor(), "GET", `/v1/artifacts/${oldest}/bytes?offset=0&max_bytes=1`)).toMatchObject({ status: 404 });
  });

  it("rejects invalid ranges and malformed reader integrity without fallback", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      requestedUrl: "https://data.example/archive.warc.gz", finalUrl: "https://data.example/archive.warc.gz",
      statusCode: 206, mediaType: "application/warc", contentRange: "bytes 0-4/5",
      rangeStart: 0, rangeEnd: 4, totalBytes: 5, bodyBase64: "YWJjZGU=", bodyBytes: 5,
      sha256: "0".repeat(64), redirectChain: ["https://data.example/archive.warc.gz"],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    expect(await call(instance, actor(), "POST", "/v1/read-range", { url: "https://data.example/archive.warc.gz", offset: 0, length: 0 }, "range-invalid-1")).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await call(instance, actor(), "POST", "/v1/read-range", { url: "https://data.example/archive.warc.gz", offset: 0, length: 5 }, "range-invalid-2")).toMatchObject({ status: 502, body: { code: "backend-failure" } });
  });

  it("propagates active range cancellation to the reader request", async () => {
    let seenSignal: AbortSignal | undefined;
    const started = Promise.withResolvers<undefined>();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      started.resolve(undefined);
      await new Promise((_resolve, reject) => seenSignal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
      throw new Error("unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = authority(browser(), "http://127.0.0.1:8787").handle(actor(), {
      method: "POST", path: "/v1/read-range", body: { url: "https://data.example/archive.warc.gz", offset: 0, length: 5 },
      maxResponseBytes: 1_048_576, headers: { "idempotency-key": "range-cancel-1" }, signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    expect(await pending).toMatchObject({ status: 499, body: { code: "cancelled" } });
    expect(seenSignal?.aborted).toBe(true);
  });

  it("replays one idempotent browser mutation and rejects changed reuse", async () => {
    const port = browser();
    const instance = authority(port);
    const request = { pathId: "agent-browser/chrome" };
    expect((await call(instance, actor(), "POST", "/v1/browser/sessions", request, "browser-create-1")).status).toBe(201);
    expect((await call(instance, actor(), "POST", "/v1/browser/sessions", request, "browser-create-1")).status).toBe(201);
    expect(port.createSession).toHaveBeenCalledTimes(1);
    const conflict = await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "pinchtab/chrome" }, "browser-create-1");
    expect(conflict).toMatchObject({ status: 409, body: { code: "idempotency-conflict" } });
  });

  it("rejects unsupported paths and wrong-owner browser access before dispatch", async () => {
    const port = browser();
    const instance = authority(port);
    expect(await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "other/chrome" }, "browser-create-2")).toMatchObject({ status: 400, body: { code: "unsupported" } });
    await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "agent-browser/chrome" }, "browser-create-3");
    const denied = await call(instance, actor("principal-b", "agent-b"), "GET", "/v1/browser/sessions/session-1");
    expect(denied).toMatchObject({ status: 403, body: { code: "wrong-owner" } });
    expect(port.getSession).not.toHaveBeenCalled();
  });

  it("routes workspace control and close-tab through owned browser state", async () => {
    const port = browser();
    const instance = authority(port);
    await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "agent-browser/chrome" }, "browser-create-workspace");
    expect(await call(instance, actor(), "POST", "/v1/browser/workspace", { action: "takeover", sessionId: "session-1" }, "browser-workspace-1")).toMatchObject({ status: 200, body: { action: "takeover" } });
    expect(await call(instance, actor(), "DELETE", "/v1/browser/sessions/session-1/tabs/tab-1", undefined, "browser-tab-close-1")).toMatchObject({ status: 204 });
    expect(port.workspace).toHaveBeenCalledTimes(1);
    expect(port.closeTab).toHaveBeenCalledTimes(1);
  });

  it("routes browser list and safe debug while refusing secret debug before dispatch", async () => {
    const port = browser();
    const instance = authority(port);
    expect(await call(instance, actor(), "GET", "/v1/browser/sessions")).toMatchObject({ status: 200, body: { sessions: [] } });
    await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "agent-browser/chrome" }, "browser-create-debug");
    expect(await call(instance, actor(), "POST", "/v1/browser/sessions/session-1/debug", { operation: "console", maxChars: 100 }, "browser-debug-001")).toMatchObject({ status: 200, body: { operation: "console", ok: true } });
    expect(await call(instance, actor(), "POST", "/v1/browser/sessions/session-1/debug", { operation: "cookies" }, "browser-debug-002")).toMatchObject({ status: 403, body: { code: "debug-refused" } });
    expect(port.debug).toHaveBeenCalledTimes(1);
  });

  it("routes visual frame capture through the browser daemon port", async () => {
    const port = browser();
    const instance = authority(port);
    await call(instance, actor(), "POST", "/v1/browser/sessions", { pathId: "agent-browser/chrome" }, "browser-create-frame");
    const frame = await call(instance, actor(), "POST", "/v1/browser/sessions/session-1/frame", {}, "browser-frame-001");
    expect(frame).toMatchObject({ status: 200, body: { mediaType: "image/png", viewportId: "viewport-1" } });
    expect(port.captureFrame).toHaveBeenCalledTimes(1);
  });

  it("reports response limits and cancellation without fallback", async () => {
    const instance = authority();
    const limited = await call(instance, actor(), "GET", "/v1/capabilities", undefined, undefined, 20);
    expect(limited.status).toBe(413);
    expect(new TextEncoder().encode(JSON.stringify(limited.body ?? null)).byteLength).toBeLessThanOrEqual(20);
    const controller = new AbortController();
    controller.abort();
    const response = await instance.handle(actor(), { method: "GET", path: "/v1/version", maxResponseBytes: 1000, signal: controller.signal });
    expect(response).toMatchObject({ status: 499, body: { code: "cancelled" } });
  });
});
