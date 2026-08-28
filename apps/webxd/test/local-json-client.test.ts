import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedLocalJsonClient, LOCAL_JSON_LIMITS, LocalJsonClientError } from "../src/local-json-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("BoundedLocalJsonClient", () => {
  it("freezes the operation deadlines and byte limits", () => {
    expect(LOCAL_JSON_LIMITS).toEqual({
      searxQuery: { timeoutMs: 15_000, maxBodyBytes: 2 * 1024 * 1024 },
      reader: { timeoutMs: 45_000, maxBodyBytes: 4 * 1024 * 1024 },
      health: { timeoutMs: 2_000, maxBodyBytes: 2 * 1024 * 1024 },
    });
  });

  it("combines caller cancellation with its internal deadline", async () => {
    let serviceSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      serviceSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => serviceSignal?.addEventListener("abort", () => reject(serviceSignal?.reason), { once: true }));
    }));
    const caller = new AbortController();
    const pending = new BoundedLocalJsonClient().request(new URL("http://127.0.0.1:8888/search"), {}, { timeoutMs: 60_000, maxBodyBytes: 100 }, caller.signal);
    await vi.waitFor(() => expect(serviceSignal).toBeDefined());
    caller.abort(new DOMException("caller stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(serviceSignal).not.toBe(caller.signal);
    expect(serviceSignal?.aborted).toBe(true);
  });

  it("stops an oversized stream before JSON parsing", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new Uint8Array(64));
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    const pending = new BoundedLocalJsonClient().request(new URL("http://localhost:8787/v1/read"), {}, { timeoutMs: 1_000, maxBodyBytes: 16 });
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<LocalJsonClientError>>({ code: "body-too-large" }));
    expect(cancelled).toBe(true);
  });

  it("refuses non-loopback service URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new BoundedLocalJsonClient().request(new URL("http://example.com/search"), {}, LOCAL_JSON_LIMITS.searxQuery))
      .rejects.toEqual(expect.objectContaining<Partial<LocalJsonClientError>>({ code: "invalid-local-url" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
