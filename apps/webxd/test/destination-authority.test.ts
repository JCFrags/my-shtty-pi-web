import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  FailClosedBrowserDestinationAuthority,
  ProxyBoundBrowserDestinationAuthority,
  type DestinationResolver,
} from "../src/destination-authority.js";
import type { AuthorityActor } from "../src/ports.js";

const actor: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set() };
const request = (url: string) => ({ actor, operationId: "operation-1", operation: "navigate" as const, url });

function resolver(addresses: readonly string[]): DestinationResolver {
  return { resolve: vi.fn(async () => addresses) };
}

describe("fail-closed browser destination authority", () => {
  it.each([
    ["http://127.0.0.1/", ["127.0.0.1"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["http://10.0.0.8/", ["10.0.0.8"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["http://169.254.2.3/", ["169.254.2.3"], "WEBX_POLICY_LINK_LOCAL_ADDRESS"],
    ["http://169.254.169.254/latest/meta-data", ["169.254.169.254"], "WEBX_POLICY_METADATA_ENDPOINT"],
    ["http://metadata.google.internal/computeMetadata/v1/", [], "WEBX_POLICY_METADATA_ENDPOINT"],
    ["http://[::ffff:127.0.0.1]/", ["::ffff:127.0.0.1"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["https://mixed.example/", ["93.184.216.34", "192.168.1.4"], "WEBX_POLICY_PRIVATE_ADDRESS"],
  ])("refuses %s before egress binding", async (url, answers, code) => {
    const authority = new FailClosedBrowserDestinationAuthority(resolver(answers));
    await expect(authority.authorize(request(url))).rejects.toMatchObject({ code, status: 403 });
  });

  it("refuses session readiness and public URLs when connection-bound egress is absent", async () => {
    const authority = new FailClosedBrowserDestinationAuthority(resolver(["93.184.216.34"]));
    await expect(authority.assertReady()).rejects.toMatchObject({ code: "WEBX_POLICY_EGRESS_REQUIRED", status: 503, retryable: true });
    await expect(authority.authorize(request("https://example.com/"))).rejects.toMatchObject({
      code: "WEBX_POLICY_EGRESS_REQUIRED",
      status: 403,
    });
  });

  it("requires the exact bounded branded functional probe and detects proxy restarts", async () => {
    const healthy = "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let mode: "healthy" | "wrong" | "malformed" | "stall" = "healthy";
    const server = createServer((socket) => socket.on("data", () => {
      if (mode === "healthy") socket.end(healthy);
      else if (mode === "wrong") socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      else if (mode === "malformed") socket.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
    }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("proxy fixture did not bind");
    const authority = new ProxyBoundBrowserDestinationAuthority("127.0.0.1", address.port, resolver(["93.184.216.34"]));
    expect(authority.egressBindingId).toBe(`forward-proxy://127.0.0.1:${address.port}`);
    await expect(authority.assertReady()).resolves.toBeUndefined();
    mode = "wrong";
    await expect(authority.assertReady()).rejects.toMatchObject({ code: "WEBX_EGRESS_UNAVAILABLE", status: 503, retryable: true });
    mode = "malformed";
    await expect(authority.assertReady()).rejects.toMatchObject({ code: "WEBX_EGRESS_UNAVAILABLE" });
    mode = "stall";
    await expect(authority.assertReady()).rejects.toMatchObject({ code: "WEBX_EGRESS_UNAVAILABLE" });
    mode = "healthy";
    await expect(authority.assertReady()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(authority.assertReady()).rejects.toMatchObject({ code: "WEBX_EGRESS_UNAVAILABLE", status: 503, retryable: true });
  });
});
