import { describe, expect, it, vi } from "vitest";
import { ApiVersionError, FACADE_OPERATION_INVENTORY, HttpTransport, ResponseLimitError, WebxClient } from "../src/index.js";

function transport(version = "1.0.0") {
  const request = vi.fn(async (input) => {
    if (input.path === "/v1/version") return { status: 200, headers: {}, body: { apiVersion: version, webxVersion: "0.1.0", browserProtocolVersion: "2.0.0" } };
    return { status: 200, headers: {}, body: { query: "q", hits: [], truncated: false } };
  });
  return { request };
}

describe("WebxClient", () => {
  it("negotiates once and preserves an idempotency key", async () => {
    const wire = transport();
    const client = new WebxClient(wire);
    await client.search({ query: "q" }, { idempotencyKey: "search-key-1" });
    await client.search({ query: "q" }, { idempotencyKey: "search-key-1" });
    expect(wire.request.mock.calls.filter(([request]) => request.path === "/v1/version")).toHaveLength(1);
    expect(wire.request.mock.calls.at(-1)?.[0].headers).toEqual({ "idempotency-key": "search-key-1" });
  });

  it("rejects API-major mismatch with exact versions", async () => {
    const client = new WebxClient(transport("2.0.0"));
    await expect(client.capabilities()).rejects.toEqual(expect.objectContaining<ApiVersionError>({ expectedMajor: 1, actualVersion: "2.0.0" }));
  });

  it("requires idempotency for browser mutations", () => {
    const client = new WebxClient(transport());
    expect(() => client.createBrowserSession({ pathId: "agent-browser/chrome" }, {})).toThrow("idempotency key");
    expect(() => client.getBrowserVisualFrame("session-1", {})).toThrow("idempotency key");
  });

  it("maps the complete facade inventory to SDK methods or explicit unavailable results", async () => {
    expect(Object.keys(FACADE_OPERATION_INVENTORY)).toEqual([
      "web.search", "web.read", "web.research", "library.search", "library.get", "library.forget", "artifact.read",
      "browser.open", "browser.tabs", "browser.observe", "browser.act", "browser.debug", "browser.workspace",
    ]);
    expect(FACADE_OPERATION_INVENTORY["browser.workspace"]).toBe("manageBrowserWorkspace");
    expect(FACADE_OPERATION_INVENTORY["browser.tabs"]).toContain("closeBrowserTab");
    expect(FACADE_OPERATION_INVENTORY["browser.act"]).toContain("bound visual actions");

    const wire = transport();
    const client = new WebxClient(wire);
    await client.searchPages({ query: "q" }, { idempotencyKey: "library-search-1" });
    await client.getPage("page-1");
    await client.forgetPage({ pageId: "page-1" }, { idempotencyKey: "library-forget-1" });
    await client.getArtifactExcerpt("artifact-1");
    await client.listBrowserSessions();
    await client.manageBrowserWorkspace({ action: "list" }, { idempotencyKey: "workspace-list-1" });
    await client.closeBrowserTab("session-1", "tab-1", { idempotencyKey: "browser-tab-close" });
    await client.getBrowserSession("session-1");
    await client.observeBrowser("session-1", "main", 100, { idempotencyKey: "browser-observe-1" });
    await client.getBrowserVisualFrame("session-1", { idempotencyKey: "browser-frame-01" });
    await client.actBrowser("session-1", { kind: "reload" }, { idempotencyKey: "browser-action-01" });
    await client.debugBrowser("session-1", { operation: "console" }, { idempotencyKey: "browser-debug-001" });
    await client.setBrowserControl("session-1", "agent", { idempotencyKey: "browser-control-1" });
    await client.cancelBrowserOperation("operation-1", { idempotencyKey: "browser-cancel-01" });
    await client.closeBrowserSession("session-1", { idempotencyKey: "browser-close-01" });
    expect(wire.request.mock.calls.map(([request]) => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining([
      "POST /v1/pages/search", "GET /v1/pages/page-1", "DELETE /v1/pages", "GET /v1/artifacts/artifact-1/excerpt?offset=0&max_bytes=16384",
      "GET /v1/browser/sessions", "POST /v1/browser/workspace", "DELETE /v1/browser/sessions/session-1/tabs/tab-1", "GET /v1/browser/sessions/session-1", "POST /v1/browser/sessions/session-1/observe", "POST /v1/browser/sessions/session-1/frame",
      "POST /v1/browser/sessions/session-1/actions", "POST /v1/browser/sessions/session-1/debug", "POST /v1/browser/sessions/session-1/control",
      "POST /v1/browser/operations/operation-1/cancel", "DELETE /v1/browser/sessions/session-1",
    ]));
  });

  it("bounds HTTP response bytes before JSON parsing", async () => {
    const fetch = vi.fn(async () => new Response("123456", { status: 200, headers: { "content-type": "text/plain" } }));
    const wire = new HttpTransport({ baseUrl: "http://127.0.0.1", fetch, retryCount: 0 });
    await expect(wire.request({ method: "GET", path: "/", maxResponseBytes: 5 })).rejects.toBeInstanceOf(ResponseLimitError);
  });

  it("propagates AbortSignal to the transport", async () => {
    const wire = transport();
    const client = new WebxClient(wire);
    const controller = new AbortController();
    await client.search({ query: "q" }, { signal: controller.signal, idempotencyKey: "search-key-2" });
    expect(wire.request.mock.calls.at(-1)?.[0].signal).toBe(controller.signal);
  });
});
