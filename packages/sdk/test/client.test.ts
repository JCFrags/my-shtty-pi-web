import { describe, expect, it, vi } from "vitest";
import { FACADE_OPERATION_INVENTORY, HttpTransport, ResponseLimitError, UnixSocketTransport, WebxClient } from "../src/index.js";
import type { BrowserAction } from "../src/types.js";

function transport(version = "3.0.0") {
  const request = vi.fn(async (input) => {
    if (input.path === "/v1/version") return { status: 200, headers: {}, body: { apiVersion: version, webxVersion: "0.1.0", browserProtocolVersion: "3.0.0" } };
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
    expect(wire.request.mock.calls.at(-1)?.[0].maxResponseBytes).toBe(6 * 1024 * 1024);
  });

  it("rejects API-major mismatch with exact versions", async () => {
    const client = new WebxClient(transport("1.0.0"));
    await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({ expectedMajor: 3, actualVersion: "1.0.0" }));
  });

  it("requires idempotency for browser mutations", () => {
    const client = new WebxClient(transport());
    expect(() => client.createBrowserSession({ pathId: "agent-browser/chrome" }, {})).toThrow("idempotency key");
    expect(() => client.getBrowserVisualFrame("session-1", "tab-1", {})).toThrow("idempotency key");
  });

  it("maps the complete facade inventory to SDK methods or explicit unavailable results", async () => {
    expect(Object.keys(FACADE_OPERATION_INVENTORY)).toEqual([
      "web.search", "web.read", "web.readBatch", "web.content",
      "browser.open", "browser.tabs", "browser.observe", "browser.act", "browser.cancel", "browser.debug", "browser.workspace",
    ]);
    expect(FACADE_OPERATION_INVENTORY["browser.workspace"]).toBe("manageBrowserWorkspace");
    expect(FACADE_OPERATION_INVENTORY["browser.tabs"]).toContain("closeBrowserTab");
    expect(FACADE_OPERATION_INVENTORY["browser.act"]).toContain("bound visual actions");
    expect(FACADE_OPERATION_INVENTORY["browser.cancel"]).toBe("cancelBrowserOperation");

    const wire = transport();
    const client = new WebxClient(wire);
    await client.readBatch({ items: [{ url: "https://one.test" }, { url: "https://two.test" }] }, { idempotencyKey: "read-batch-001" });
    await client.content({ contentId: `cnt_${"x".repeat(32)}`, offset: 0, limit: 10 }, { idempotencyKey: "content-read-001" });
    await client.readRange({ url: "https://data.example/warc", offset: 0, length: 10 }, { idempotencyKey: "range-read-001" });
    await client.getArtifactBytes("artifact-1", 0, 10);
    await client.listBrowserSessions();
    await client.manageBrowserWorkspace({ action: "list" }, { idempotencyKey: "workspace-list-1" });
    await client.closeBrowserTab("session-1", "tab-1", { idempotencyKey: "browser-tab-close" });
    await client.getBrowserSession("session-1");
    await client.observeBrowser("session-1", "tab-1", "dom", 100, { idempotencyKey: "browser-observe-1" });
    await client.getBrowserVisualFrame("session-1", "tab-1", { idempotencyKey: "browser-frame-01" });
    await client.actBrowser("session-1", "tab-1", { kind: "key-press", key: "Escape" }, { idempotencyKey: "browser-action-01" });
    await client.debugBrowser("session-1", { operation: "console" }, { idempotencyKey: "browser-debug-001" });
    await client.setBrowserControl("session-1", "agent", { idempotencyKey: "browser-control-1" });
    await client.cancelBrowserOperation("operation-1", { idempotencyKey: "browser-cancel-01" });
    await client.closeBrowserSession("session-1", { idempotencyKey: "browser-close-01" });
    expect(wire.request.mock.calls.map(([request]) => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining([
      "POST /v1/read-batch", "POST /v1/content", "POST /v1/read-range", "GET /v1/artifacts/artifact-1/bytes?offset=0&max_bytes=10",
      "GET /v1/browser/sessions", "POST /v1/browser/workspace", "DELETE /v1/browser/sessions/session-1/tabs/tab-1", "GET /v1/browser/sessions/session-1", "POST /v1/browser/sessions/session-1/observe", "POST /v1/browser/sessions/session-1/frame",
      "POST /v1/browser/sessions/session-1/actions", "POST /v1/browser/sessions/session-1/debug", "POST /v1/browser/sessions/session-1/control",
      "POST /v1/browser/operations/operation-1/cancel", "DELETE /v1/browser/sessions/session-1",
    ]));
  });

  it("keeps upload out of the SDK-facing browser action union", () => {
    // @ts-expect-error Upload has no complete singular Pi typed-handle seam.
    const upload: BrowserAction = { kind: "upload", ref: "e1", uploadHandleIds: ["handle-1"] };
    expect(upload.kind).toBe("upload");
  });

  it("bounds HTTP response bytes before JSON parsing", async () => {
    const fetch = vi.fn(async () => new Response("123456", { status: 200, headers: { "content-type": "text/plain" } }));
    const wire = new HttpTransport({ baseUrl: "http://127.0.0.1", fetch, retryCount: 0 });
    await expect(wire.request({ method: "GET", path: "/", maxResponseBytes: 5 })).rejects.toBeInstanceOf(ResponseLimitError);
  });

  it("renews one stale runtime binding and retries the rejected request", async () => {
    const lines: unknown[] = [];
    let bindingSequence = 0;
    const connect = vi.fn(async () => ({
      close: async () => undefined,
      send: async (line: string) => {
        const wire = JSON.parse(line) as { bind?: { ownerId?: string }; binding?: { bindingId?: string } };
        lines.push(wire);
        if (wire.bind !== undefined) {
          bindingSequence += 1;
          return JSON.stringify({ bindingId: `binding-${bindingSequence}`, bindingSecret: `secret-${bindingSequence}` });
        }
        if (wire.binding?.bindingId === "binding-1") return JSON.stringify({ status: 400, headers: {}, body: { code: "invalid-wire-request", message: "runtime actor binding is invalid", retryable: false } });
        return JSON.stringify({ status: 200, headers: {}, body: { ok: true } });
      },
    }));
    const wire = new UnixSocketTransport("/run/user/1000/webxd.sock", connect);
    await wire.bind("owner-rebind");
    await expect(wire.request({ method: "GET", path: "/v1/version", maxResponseBytes: 1024 })).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(bindingSequence).toBe(2);
    expect(lines).toHaveLength(4);
    expect(lines.at(2)).toEqual({ bind: { ownerId: "owner-rebind" } });
  });

  it("propagates AbortSignal to the transport", async () => {
    const wire = transport();
    const client = new WebxClient(wire);
    const controller = new AbortController();
    await client.search({ query: "q" }, { signal: controller.signal, idempotencyKey: "search-key-2" });
    expect(wire.request.mock.calls.at(-1)?.[0].signal).toBe(controller.signal);
  });
});
