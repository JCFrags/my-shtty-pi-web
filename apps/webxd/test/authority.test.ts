import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebxAuthority } from "../src/authority.js";
import { NormalizedContentStore } from "../src/content-store.js";
import { PUBLIC_SOURCES } from "../src/fixtures.js";
import type { AuthorityActor, BrowserDaemonPort } from "../src/ports.js";

afterEach(() => vi.unstubAllGlobals());

const paths = [
  { pathId: "agent-browser/chrome", actions: ["navigate", "click"], observations: ["main", "visual"], visual: true, touch: false, uploads: false, downloads: true },
  { pathId: "pinchtab/chrome", actions: ["navigate", "fill", "wait"], observations: ["main", "interactive"], visual: false, touch: false, uploads: false, downloads: false },
] as const;

function actor(principalId = "principal-a", agentId = "agent-a"): AuthorityActor {
  return { principalId, agentId, scopes: new Set(["system.read", "search.write", "retrieval.read", "artifacts.read", "browser.read", "browser.write", "browser.control", "browser.debug"]) };
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
  it("serves the streamlined search contract and rejects removed fields", async () => {
    const instance = authority();
    const search = await call(instance, actor(), "POST", "/v1/search", { query: "WebX routes" }, "search-key-001");
    expect(search).toMatchObject({ status: 200, body: { output: "links", metadata: { searches: 1, fallbackUsed: false, partial: false, pagesRead: 0, readAttempts: 0 } } });
    expect(await call(instance, actor(), "POST", "/v1/search", { query: "WebX routes", effort: "fast" }, "search-key-002")).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    const read = await call(instance, actor(), "POST", "/v1/read", { url: "https://fixture.invalid/webx", maxChars: 4 }, "read-key-001");
    expect(read.body).toMatchObject({ untrustedContent: "WebX", truncated: true });
    const incompatibleContinuation = await call(instance, actor(), "POST", "/v1/read", { url: "https://fixture.invalid/webx", contentOffset: 10, maxPages: 2 }, "read-key-002");
    expect(incompatibleContinuation).toMatchObject({ status: 400, body: { code: "invalid-request" } });
  });

  it("keeps one query, applies small relevance ranking, and removes canonical duplicates", async () => {
    const query = "major changes in Fedora Linux 44 for desktop users";
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe(query);
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("time_range")).toBeNull();
      return new Response(JSON.stringify({ results: [
        { title: "Major definition", url: "https://dictionary.example/major", content: "A dictionary definition." },
        { title: "Fedora Linux 44 Changes", url: "https://fedoraproject.org/wiki/Releases/44/ChangeSet?utm_source=test", content: "Major approved desktop changes for Fedora Linux 44, including the complete official change set for workstation users." },
        { title: "Fedora Linux 44 Changes", url: "https://fedoraproject.org/wiki/Releases/44/ChangeSet?utm_medium=duplicate", content: "Major approved desktop changes for Fedora Linux 44, including the complete official change set for workstation users." },
        { title: "Official Fedora desktop changes", url: "https://fedoraproject.org/wiki/Releases/44/ChangeSet/wiki/Releases/44/ChangeSet", content: "Major approved desktop changes for Fedora Linux 44, including the complete official change set for workstation users." },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const result = await call(instance, actor(), "POST", "/v1/search", { query }, "search-fedora");
    const body = result.body as { hits: Array<{ title: string; url: string }> };
    expect(result.status).toBe(200);
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]).toMatchObject({ title: "Fedora Linux 44 Changes", url: "https://fedoraproject.org/wiki/Releases/44/ChangeSet" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the query once and enforces explicit domains without leaks", async () => {
    const query = "Pi coding agent extensions documentation official";
    const fetchMock = vi.fn(async (input: unknown) => {
      expect(new URL(String(input)).searchParams.get("q")).toBe(query);
      return new Response(JSON.stringify({
        results: [
          { title: "Pi Coding Agent", url: "https://pi.dev/", content: "Pi home." },
          { title: "Extensions", url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md", content: "Pi extension documentation." },
        ],
        unresponsive_engines: [["bing", "timeout"]],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const result = await call(instance, actor(), "POST", "/v1/search", { query, domains: ["github.com"] }, "strict-domain");
    expect(result).toMatchObject({ status: 200, body: { hits: [{ title: "Extensions" }], metadata: { searches: 1, partial: true } } });
    const hits = (result.body as { hits: Array<{ url: string }> }).hits;
    expect(hits.every((hit) => new URL(hit.url).hostname === "github.com")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses one narrow site-query recovery and rejects conflicting domain constraints", async () => {
    const queries: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const query = new URL(String(input)).searchParams.get("q") ?? "";
      queries.push(query);
      const results = query.startsWith("site:") ? [] : [
        { title: "Data API docs", url: "https://artificialanalysis.ai/data-api/docs", content: "Language model endpoint documentation." },
      ];
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const query = "site:artificialanalysis.ai/data-api/docs language models endpoint";
    const recovered = await call(instance, actor(), "POST", "/v1/search", { query }, "site-recovery");
    expect(recovered).toMatchObject({ status: 200, body: { hits: [{ url: "https://artificialanalysis.ai/data-api/docs" }], metadata: { searches: 2, fallbackUsed: true } } });
    expect(queries).toEqual([query, "artificialanalysis.ai/data-api/docs language models endpoint"]);
    const conflict = await call(instance, actor(), "POST", "/v1/search", { query: "site:pi.dev extensions", domains: ["github.com"] }, "site-conflict");
    expect(conflict).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a SearXNG body above 2 MiB before it can become a search result", async () => {
    const oversized = JSON.stringify({ results: [{ title: "Oversized", url: "https://example.test/", content: "x".repeat(2 * 1024 * 1024) }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, { status: 200, headers: { "content-type": "application/json" } })));
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const result = await call(instance, actor(), "POST", "/v1/search", { query: "oversized response" }, "oversized-search");
    expect(result).toMatchObject({ status: 502, body: { code: "backend-failure", retryable: true } });
    expect((result.body as { message: string }).message).toContain("exceeded 2097152 bytes");
  });

  it("reports unavailable providers instead of a false successful empty search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [], unresponsive_engines: [["bing news", "too many requests"], ["brave.news", "CAPTCHA"]] }), { status: 200, headers: { "content-type": "application/json" } })));
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const result = await call(instance, actor(), "POST", "/v1/search", { query: "market news" }, "failed-news");
    expect(result).toMatchObject({ status: 502, body: { code: "backend-failure", retryable: true } });
    expect((result.body as { message: string }).message).toMatch(/bing news.*too many requests.*brave\.news.*CAPTCHA/iu);
  });

  it("reads a bounded extract set concurrently and never substitutes search snippets", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let activeReaders = 0;
    let maximumReaders = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("http://127.0.0.1:8888/search")) {
        return new Response(JSON.stringify({ results: Array.from({ length: 6 }, (_, index) => ({
          title: `Product result ${index + 1}`, url: `https://docs.example.org/page-${index + 1}`, content: `Unverified search snippet ${index + 1}.`,
        })) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { url: string; query?: string; maxChars: number };
      expect(body.query).toBeUndefined();
      expect(body.maxChars).toBe(30_000);
      activeReaders += 1;
      maximumReaders = Math.max(maximumReaders, activeReaders);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReaders -= 1;
      if (body.url.endsWith("page-2")) return new Response("failed", { status: 500 });
      return new Response(JSON.stringify({
        url: body.url, title: `Verified ${body.url.split("-").at(-1)}`,
        content: `Introduction for ${body.url}. Product feature support is documented in this verified page passage with enough useful detail to be returned. Additional unrelated page text follows.`,
        truncated: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const contentStore = new NormalizedContentStore();
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888", readerUrl: "http://127.0.0.1:8787", contentStore });
    const result = await call(instance, actor(), "POST", "/v1/search", { query: "Product feature support", output: "extracts", domains: ["docs.example.org"] }, "extract-search");
    const body = result.body as { hits: Array<{ snippet: string }>; metadata: { searches: number; pagesRead: number; readAttempts: number; partial: boolean } };
    expect(result.status).toBe(200);
    expect(body.metadata).toMatchObject({ searches: 1, fallbackUsed: false, partial: true, pagesRead: 5, readAttempts: 6 });
    expect(body.hits).toHaveLength(4);
    expect(body.hits.every((hit) => hit.snippet.includes("verified page passage") && !hit.snippet.includes("Unverified search snippet") && hit.snippet.length <= 700)).toBe(true);
    expect(requests.filter((item) => item.url.includes("/search"))).toHaveLength(1);
    expect(requests.filter((item) => item.url.includes(":8787/"))).toHaveLength(6);
    expect(maximumReaders).toBe(4);
    expect(await contentStore.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("does not coalesce concurrent identical searches from different owners", async () => {
    const release = Promise.withResolvers<undefined>();
    const fetchMock = vi.fn(async () => {
      await release.promise;
      return new Response(JSON.stringify({ results: [{ title: "Shared", url: "https://shared.test/", content: "shared result" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const first = call(instance, actor("principal-a"), "POST", "/v1/search", { query: "same query" }, "owner-a-search");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = call(instance, actor("principal-b"), "POST", "/v1/search", { query: "same query" }, "owner-b-search");
    try { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); }
    finally { release.resolve(undefined); }
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => (response.body as { metadata: { delivery: { coalesced: boolean } } }).metadata.delivery.coalesced)).toEqual([false, false]);
  });

  it("coalesces concurrent identical searches from the same owner", async () => {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const fetchMock = vi.fn(async () => {
      started.resolve(undefined);
      await release.promise;
      return new Response(JSON.stringify({ results: [{ title: "Shared", url: "https://shared.test/", content: "shared result" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = new WebxAuthority({ browser: browser(), sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-24T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, searxUrl: "http://127.0.0.1:8888" });
    const first = call(instance, actor("principal-a"), "POST", "/v1/search", { query: "same query" }, "same-owner-search-one");
    await started.promise;
    const second = call(instance, actor("principal-a"), "POST", "/v1/search", { query: "same query" }, "same-owner-search-two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release.resolve(undefined);
    const responses = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((responses[1]?.body as { metadata: { delivery: { coalesced: boolean } } }).metadata.delivery.coalesced).toBe(true);
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

  it("negotiates search, static read, and optional browser health independently", async () => {
    const failedBrowser = browser();
    vi.mocked(failedBrowser.capabilities).mockRejectedValue(new Error("browser offline"));
    const healthFetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.port === "8787" && url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected probe: ${url}`);
    });
    vi.stubGlobal("fetch", healthFetch);
    const instance = new WebxAuthority({
      browser: failedBrowser, sources: PUBLIC_SOURCES,
      clock: { now: () => "2026-08-27T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` },
      searxUrl: "http://127.0.0.1:8888", readerUrl: "http://127.0.0.1:8787", crawlUrl: "http://127.0.0.1:8793",
    });
    const response = await call(instance, actor(), "GET", "/v1/capabilities");
    expect(response).toMatchObject({ status: 200, body: {
      capabilities: [
        { id: "search", enabled: true, healthy: true },
        { id: "read", enabled: true, healthy: true },
        { id: "browser", enabled: true, healthy: false },
      ],
      browserPaths: [],
    } });
    expect(JSON.stringify(response.body)).not.toContain("crawl");
    expect(healthFetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(healthFetch.mock.calls[0]?.[0])).pathname).toBe("/health");
  });

  it("does not let reader health remove healthy search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.port === "8888") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      throw new Error("reader offline");
    }));
    const instance = new WebxAuthority({
      browser: browser(), sources: PUBLIC_SOURCES,
      clock: { now: () => "2026-08-27T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` },
      searxUrl: "http://127.0.0.1:8888", readerUrl: "http://127.0.0.1:8787",
    });
    const response = await call(instance, actor(), "GET", "/v1/capabilities");
    expect(response).toMatchObject({ status: 200, body: { capabilities: [
      { id: "search", healthy: true }, { id: "read", healthy: false }, { id: "browser", healthy: true },
    ] } });
  });

  it("stores normalized read content and retrieves exact or focused passages without refetching", async () => {
    const normalized = `${"prefix ".repeat(5_000)}UNIQUE NEEDLE ${"suffix ".repeat(5_000)}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: "https://docs.example/page", title: "Stored page", content: normalized, truncated: false, metadata: { totalCharacters: normalized.length } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const read = await call(instance, actor(), "POST", "/v1/read", { url: "https://docs.example/page" }, "stored-read-001");
    expect(read).toMatchObject({ status: 200, body: { truncated: true, metadata: { contentId: expect.stringMatching(/^cnt_/u), reader: { returnedCharacters: 30_000, nextStoredOffset: 30_000 } } } });
    const readBody = read.body as { metadata: { contentId: string } };
    const exact = await call(instance, actor(), "POST", "/v1/content", { contentId: readBody.metadata.contentId, offset: 30_000, limit: 100 }, "stored-exact-001");
    expect(exact).toMatchObject({ status: 200, body: { metadata: { mode: "exact", offset: 30_000, returnedCharacters: 100 } } });
    const focused = await call(instance, actor(), "POST", "/v1/content", { contentId: readBody.metadata.contentId, findText: "unique needle", limit: 200 }, "stored-focus-001");
    expect(focused).toMatchObject({ status: 200, body: { untrustedContent: expect.stringContaining("UNIQUE NEEDLE"), metadata: { mode: "findText", matchOffset: expect.any(Number) } } });
    const queried = await call(instance, actor(), "POST", "/v1/content", { contentId: readBody.metadata.contentId, query: "unique needle", limit: 200 }, "stored-query-001");
    expect(queried).toMatchObject({ status: 200, body: { untrustedContent: expect.stringContaining("UNIQUE NEEDLE"), metadata: { mode: "query" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replaces a cached read whose owned stored content was evicted", async () => {
    let sequence = 0;
    const contentStore = new NormalizedContentStore({ maxEntries: 1, nextId: () => `cnt_${(++sequence).toString(36).padStart(32, "a")}` });
    const sources = [
      { hitId: "one", ownerPrincipalId: "principal-a", title: "One", url: "https://fixture.invalid/one", content: "first body", visibility: "public" as const },
      { hitId: "two", ownerPrincipalId: "principal-a", title: "Two", url: "https://fixture.invalid/two", content: "second body", visibility: "public" as const },
    ];
    const instance = new WebxAuthority({ browser: browser(), sources, clock: { now: () => "2026-08-27T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, contentStore });
    const first = await call(instance, actor(), "POST", "/v1/read", { url: sources[0].url }, "cache-eviction-1");
    const oldId = (first.body as { metadata: { contentId: string } }).metadata.contentId;
    await call(instance, actor(), "POST", "/v1/read", { url: sources[1].url }, "cache-eviction-2");
    const replacement = await call(instance, actor(), "POST", "/v1/read", { url: sources[0].url }, "cache-eviction-3");
    const newId = (replacement.body as { metadata: { contentId: string } }).metadata.contentId;
    expect(newId).not.toBe(oldId);
    expect(await call(instance, actor(), "POST", "/v1/content", { contentId: newId }, "cache-eviction-content")).toMatchObject({ status: 200, body: { untrustedContent: "first body" } });
  });

  it("acquires complete structured rows when maxChars is omitted", async () => {
    const projected = JSON.stringify([{ id: 1, value: `${"x".repeat(40_000)}ROW-END` }]);
    let readerRequest: { maxChars?: number; fields?: string[]; itemLimit?: number } = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      readerRequest = JSON.parse(String(init?.body)) as typeof readerRequest;
      return new Response(JSON.stringify({ url: "https://api.example/rows", title: "Rows", content: projected, truncated: false, metadata: { returnedItems: 1, totalItems: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const read = await call(instance, actor(), "POST", "/v1/read", { url: "https://api.example/rows", fields: ["id", "value"], itemLimit: 1 }, "structured-complete");
    expect(readerRequest).toMatchObject({ maxChars: 1_000_000, fields: ["id", "value"], itemLimit: 1 });
    const contentId = (read.body as { metadata: { contentId: string } }).metadata.contentId;
    const tail = await call(instance, actor(), "POST", "/v1/content", { contentId, offset: 30_000, limit: 20_000 }, "structured-tail");
    expect((tail.body as { untrustedContent: string }).untrustedContent).toContain("ROW-END");
  });

  it("validates stored-content modes and hides missing or other-owner IDs", async () => {
    const instance = authority();
    const read = await call(instance, actor(), "POST", "/v1/read", { url: "https://fixture.invalid/webx" }, "content-validation-read");
    const contentId = (read.body as { metadata: { contentId: string } }).metadata.contentId;
    expect(await call(instance, actor(), "POST", "/v1/content", { contentId, offset: 0, query: "webx" }, "content-invalid-mode")).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await call(instance, actor(), "POST", "/v1/content", { contentId, limit: 30_001 }, "content-invalid-limit")).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await call(instance, actor("other"), "POST", "/v1/content", { contentId }, "content-other-owner")).toMatchObject({ status: 404, body: { code: "content-not-found" } });
    expect(await call(instance, actor(), "POST", "/v1/content", { contentId: `cnt_${"x".repeat(32)}` }, "content-missing")).toMatchObject({ status: 404, body: { code: "content-not-found" } });
  });

  it("returns ordered separate batch envelopes with concurrency at most three and partial success", async () => {
    let active = 0;
    let maximum = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { url: string };
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, request.url.endsWith("/1") ? 15 : 5));
      active -= 1;
      if (request.url.endsWith("/2")) return new Response("failed", { status: 500 });
      return new Response(JSON.stringify({ url: request.url, title: request.url, content: `body for ${request.url}`, truncated: false }), { status: 200 });
    }));
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const urls = Array.from({ length: 5 }, (_, index) => `https://batch.test/${index}`);
    const response = await call(instance, actor(), "POST", "/v1/read-batch", { items: urls.map((url) => ({ url })) }, "batch-partial");
    expect(response.status).toBe(200);
    const body = response.body as { results: Array<{ index: number; url: string; ok: boolean; result?: { metadata: { contentId: string } } }>; metadata: unknown };
    expect(body.results.map((item) => item.url)).toEqual(urls);
    expect(body.results.map((item) => item.index)).toEqual([0, 1, 2, 3, 4]);
    expect(body.results.map((item) => item.ok)).toEqual([true, true, false, true, true]);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(body.metadata).toEqual({ requested: 5, succeeded: 4, failed: 1, maxConcurrency: 3 });
    for (const item of body.results.filter((value) => value.ok)) expect(item.result?.metadata.contentId).toMatch(/^cnt_/u);
  });

  it("coalesces equivalent singular and batch reads and returns the same stored content ID", async () => {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      started.resolve(undefined);
      await release.promise;
      const request = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({ url: request.url, title: "Shared", content: "one shared stored body", truncated: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const direct = call(instance, actor(), "POST", "/v1/read", { url: "https://same.test" }, "same-direct");
    await started.promise;
    const batch = call(instance, actor(), "POST", "/v1/read-batch", { items: [{ url: "https://same.test" }] }, "same-batch");
    release.resolve(undefined);
    const [directResponse, batchResponse] = await Promise.all([direct, batch]);
    const directBody = directResponse.body as { metadata: { contentId: string } };
    const batchBody = batchResponse.body as { results: Array<{ ok: true; result: { metadata: { contentId: string; delivery: { coalesced: boolean } } } }> };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batchBody.results[0]?.result.metadata.contentId).toBe(directBody.metadata.contentId);
    expect(batchBody.results[0]?.result.metadata.delivery.coalesced).toBe(true);
  });

  it("returns one failure envelope for every failed batch input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failed", { status: 503 })));
    const response = await call(authority(browser(), "http://127.0.0.1:8787"), actor(), "POST", "/v1/read-batch", { items: [{ url: "https://fail.test/1" }, { url: "https://fail.test/2" }] }, "batch-failed");
    expect(response).toMatchObject({ status: 200, body: { metadata: { requested: 2, succeeded: 0, failed: 2 }, results: [{ ok: false }, { ok: false }] } });
  });

  it("keeps batch content IDs in the calling owner scope", async () => {
    const instance = authority();
    const first = await call(instance, actor("owner-one"), "POST", "/v1/read-batch", { items: [{ url: "https://fixture.invalid/webx" }] }, "batch-owner-one");
    const second = await call(instance, actor("owner-two"), "POST", "/v1/read-batch", { items: [{ url: "https://fixture.invalid/webx" }] }, "batch-owner-two");
    const firstId = (first.body as { results: Array<{ result: { metadata: { contentId: string } } }> }).results[0]?.result.metadata.contentId ?? "";
    const secondId = (second.body as { results: Array<{ result: { metadata: { contentId: string } } }> }).results[0]?.result.metadata.contentId ?? "";
    expect(firstId).not.toBe(secondId);
    expect(await call(instance, actor("owner-two"), "POST", "/v1/content", { contentId: firstId }, "batch-owner-cross-read")).toMatchObject({ status: 404, body: { code: "content-not-found" } });
  });

  it("validates direct batch items at the daemon boundary and keeps exact offsets", async () => {
    const readerBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      readerBodies.push(body);
      return new Response(JSON.stringify({ url: body.url, title: "Offset", content: "offset body", truncated: false }), { status: 200 });
    }));
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const valid = await call(instance, actor(), "POST", "/v1/read-batch", { items: [{ url: "https://offset.test", contentOffset: 37, itemOffset: 4, itemLimit: 2, fields: ["id"] }] }, "batch-offset");
    expect(valid.status).toBe(200);
    expect(readerBodies[0]).toMatchObject({ contentOffset: 37, itemOffset: 4, itemLimit: 2, fields: ["id"] });
    for (const [index, field] of ["maxPages", "maxDepth", "sameDomain", "save", "unknown"].entries()) {
      const rejected = await call(instance, actor(), "POST", "/v1/read-batch", { items: [{ url: "https://invalid.test", [field]: field === "save" ? { path: "x.md" } : 1 }] }, `batch-invalid-${index}`);
      expect(rejected).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    }
  });

  it("cancels batch fan-out without turning cancellation into a partial result", async () => {
    const started = Promise.withResolvers<undefined>();
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      started.resolve(undefined);
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    }));
    const controller = new AbortController();
    const pending = authority(browser(), "http://127.0.0.1:8787").handle(actor(), { method: "POST", path: "/v1/read-batch", body: { items: [{ url: "https://cancel.test/1" }, { url: "https://cancel.test/2" }] }, maxResponseBytes: 1_048_576, headers: { "idempotency-key": "batch-cancel" }, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(await pending).toMatchObject({ status: 499, body: { code: "cancelled" } });
  });

  it("coalesces identical reads and keeps waiter cancellation independent", async () => {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      started.resolve(undefined);
      await release.promise;
      const request = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({ url: request.url, title: "Shared", content: "shared body", truncated: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const cancelled = new AbortController();
    const first = instance.handle(actor(), { method: "POST", path: "/v1/read", body: { url: "https://shared.test" }, maxResponseBytes: 1_048_576, headers: { "idempotency-key": "shared-first" }, signal: cancelled.signal });
    await started.promise;
    const second = instance.handle(actor(), { method: "POST", path: "/v1/read", body: { url: "https://shared.test" }, maxResponseBytes: 1_048_576, headers: { "idempotency-key": "shared-second" } });
    cancelled.abort();
    release.resolve(undefined);
    expect(await first).toMatchObject({ status: 499 });
    expect(await second).toMatchObject({ status: 200, body: { metadata: { delivery: { cache: "miss", coalesced: true } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears coalescing state when every waiter cancels", async () => {
    const started = Promise.withResolvers<undefined>();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) {
        started.resolve(undefined);
        await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
      }
      return new Response(JSON.stringify({ url: "https://cancel-all.test", title: "Retry", content: "retry body", truncated: false }), { status: 200 });
    }));
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const controller = new AbortController();
    const first = instance.handle(actor(), { method: "POST", path: "/v1/read", body: { url: "https://cancel-all.test" }, maxResponseBytes: 1_048_576, headers: { "idempotency-key": "cancel-all-one" }, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(await first).toMatchObject({ status: 499 });
    expect((await call(instance, actor(), "POST", "/v1/read", { url: "https://cancel-all.test" }, "cancel-all-two")).status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("clears failed coalescing state", async () => {
    const fetchMock = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return new Response("failed", { status: 500 }); });
    vi.stubGlobal("fetch", fetchMock);
    const instance = authority(browser(), "http://127.0.0.1:8787");
    const pair = await Promise.all([
      call(instance, actor(), "POST", "/v1/read", { url: "https://shared-fail.test" }, "failure-one"),
      call(instance, actor(), "POST", "/v1/read", { url: "https://shared-fail.test" }, "failure-two"),
    ]);
    expect(pair.map((item) => item.status)).toEqual([500, 500]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await call(instance, actor(), "POST", "/v1/read", { url: "https://shared-fail.test" }, "failure-three")).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds idempotency records by entries and bytes", async () => {
    const port = browser();
    const entryBound = new WebxAuthority({ browser: port, sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, idempotencyMaxEntries: 2 });
    for (const key of ["idempotency-one", "idempotency-two", "idempotency-three", "idempotency-one"]) {
      expect((await call(entryBound, actor(), "POST", "/v1/browser/workspace", { action: "list" }, key)).status).toBe(200);
    }
    expect(port.workspace).toHaveBeenCalledTimes(4);

    const bytePort = browser();
    const byteBound = new WebxAuthority({ browser: bytePort, sources: PUBLIC_SOURCES, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` }, idempotencyMaxBytes: 1 });
    await call(byteBound, actor(), "POST", "/v1/browser/workspace", { action: "list" }, "idempotency-byte");
    await call(byteBound, actor(), "POST", "/v1/browser/workspace", { action: "list" }, "idempotency-byte");
    expect(bytePort.workspace).toHaveBeenCalledTimes(2);
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
