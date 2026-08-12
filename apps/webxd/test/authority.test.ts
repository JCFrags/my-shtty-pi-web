import { describe, expect, it, vi } from "vitest";
import { WebxAuthority } from "../src/authority.js";
import { PUBLIC_ARTIFACTS, PUBLIC_SOURCES } from "../src/fixtures.js";
import type { AuthorityActor, BrowserDaemonPort } from "../src/ports.js";

const paths = [
  { pathId: "agent-browser/chrome", actions: ["navigate", "click"], observations: ["main", "visual"], visual: true, touch: false, uploads: false, downloads: true },
  { pathId: "pinchtab/chrome", actions: ["navigate", "fill", "wait"], observations: ["main", "interactive"], visual: false, touch: false, uploads: false, downloads: false },
] as const;

function actor(principalId = "principal-a", agentId = "agent-a"): AuthorityActor {
  return { principalId, agentId, scopes: new Set(["system.read", "search.write", "retrieval.read", "research.write", "pages.read", "pages.write", "artifacts.read", "browser.read", "browser.write", "browser.control", "browser.debug"]) };
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

function authority(browserPort = browser()) {
  return new WebxAuthority({ browser: browserPort, sources: PUBLIC_SOURCES, artifacts: PUBLIC_ARTIFACTS, clock: { now: () => "2026-08-12T00:00:00Z" }, ids: { next: (prefix) => `${prefix}-1` } });
}

async function call(instance: WebxAuthority, owner: AuthorityActor, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, key?: string, maxResponseBytes = 1_048_576) {
  return instance.handle(owner, { method, path, body, maxResponseBytes, headers: key === undefined ? undefined : { "idempotency-key": key } });
}

describe("WebxAuthority", () => {
  it("serves bounded deterministic search, read, research, page, and artifact operations", async () => {
    const instance = authority();
    expect((await call(instance, actor(), "POST", "/v1/search", { query: "WebX routes", limit: 1 }, "search-key-001")).status).toBe(200);
    const read = await call(instance, actor(), "POST", "/v1/read", { pageId: "page-webx-001", maxChars: 4 }, "read-key-001");
    expect(read.body).toMatchObject({ untrustedContent: "WebX", truncated: true, artifactId: "artifact-webx-001" });
    expect((await call(instance, actor(), "POST", "/v1/research", { question: "browser paths", maxSources: 2 }, "research-key-001")).status).toBe(200);
    expect((await call(instance, actor(), "GET", "/v1/pages/page-webx-001")).status).toBe(200);
    const artifact = await call(instance, actor(), "GET", "/v1/artifacts/artifact-webx-001/excerpt?offset=0&max_bytes=4");
    expect(artifact.body).toMatchObject({ excerpt: "WebX", integrityVerified: true, nextOffset: 4 });
  });

  it("searches and forgets only owner-visible public page-library records", async () => {
    const fixture = PUBLIC_SOURCES[0];
    if (fixture === undefined) throw new Error("fixture source is missing");
    const source = { ...fixture, ownerPrincipalId: "principal-a", pageId: "owned-page", artifactId: "owned-artifact" };
    const instance = new WebxAuthority({ browser: browser(), sources: [source], artifacts: [], clock: { now: () => "" }, ids: { next: () => "" } });
    const found = await call(instance, actor(), "POST", "/v1/pages/search", { query: "WebX" }, "pages-search-001");
    expect(found).toMatchObject({ status: 200, body: { pages: [{ pageId: "owned-page", visibility: "public" }] } });
    expect(await call(instance, actor(), "DELETE", "/v1/pages", { pageId: "owned-page" }, "pages-forget-001")).toMatchObject({ status: 200, body: { forgotten: true, pageId: "owned-page" } });
    expect(await call(instance, actor(), "GET", "/v1/pages/owned-page")).toMatchObject({ status: 404, body: { code: "not-found" } });
    expect(await call(instance, actor(), "POST", "/v1/pages/search", { query: "WebX", includeHistory: true }, "pages-history-001")).toMatchObject({ status: 501, body: { code: "unavailable" } });
  });

  it("rejects private content for the wrong principal without revealing it", async () => {
    const publicSource = PUBLIC_SOURCES[0];
    if (publicSource === undefined) throw new Error("fixture source is missing");
    const privateSource = { ...publicSource, pageId: "private-page", artifactId: "private-artifact", ownerPrincipalId: "principal-a", visibility: "private" as const };
    const instance = new WebxAuthority({ browser: browser(), sources: [privateSource], artifacts: [], clock: { now: () => "" }, ids: { next: () => "" } });
    const response = await call(instance, actor("principal-b", "agent-b"), "GET", "/v1/pages/private-page");
    expect(response).toMatchObject({ status: 404, body: { code: "not-found" } });
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
    const limited = await call(instance, actor(), "GET", "/v1/pages/page-webx-001", undefined, undefined, 20);
    expect(limited.status).toBe(413);
    expect(new TextEncoder().encode(JSON.stringify(limited.body ?? null)).byteLength).toBeLessThanOrEqual(20);
    const controller = new AbortController();
    controller.abort();
    const response = await instance.handle(actor(), { method: "GET", path: "/v1/version", maxResponseBytes: 1000, signal: controller.signal });
    expect(response).toMatchObject({ status: 499, body: { code: "cancelled" } });
  });
});
