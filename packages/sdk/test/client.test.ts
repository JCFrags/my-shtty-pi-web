import { describe, expect, it, vi } from "vitest";
import { ApiVersionError, HttpTransport, ResponseLimitError, WebxClient } from "../src/index.js";

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
