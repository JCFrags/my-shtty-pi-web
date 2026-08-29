import { describe, expect, it, vi } from "vitest";
import { BrowserDaemonRpcPort } from "../src/browser-daemon-port.js";
import type { AuthorityActor } from "../src/ports.js";

const owner: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set() };
const other: AuthorityActor = { principalId: "principal-b", agentId: "agent-b", scopes: new Set() };
const digest = "a".repeat(64);

function capabilities() {
  return {
    protocolVersion: "2.0.0",
    supportedPathIds: ["agent-browser/chrome"],
    paths: [{
      pathId: "agent-browser/chrome",
      actions: ["navigate", "mouse-move", "click", "double-click", "wheel", "drag", "key-press", "text-input", "tab-new", "tab-close", "tab-focus"],
      observations: ["main", "interactive", "visual"],
      visual: true,
      touch: false,
      uploads: true,
      downloads: true,
    }],
  };
}

function sessionResponse() {
  return {
    pathId: "agent-browser/chrome",
    browserSession: { browserSessionId: "session-1", ownerAgentId: "agent-a", hostId: "host-1", label: "fixture", createdAt: "2026-08-12T00:00:00Z", lastActivityAt: "2026-08-12T00:00:00Z" },
    tab: { tabId: "tab-1", browserSessionId: "session-1", ownerAgentId: "agent-a", title: "Fixture", url: "https://fixture.invalid/", index: 0, control: "agent", state: "idle" },
    controlEpoch: 1,
  };
}

function workspaceIdentity() {
  return { browserSessionId: "session-1", tabId: "tab-1", viewportId: "viewport-1", pathId: "agent-browser/chrome", coordinateSpace: "css-viewport", viewportGeneration: 2, controlEpoch: 1 };
}

function rpc() {
  let epoch = 1;
  const call = vi.fn(async (method: string, params: Readonly<Record<string, unknown>> = {}) => {
    if (method === "system.capabilities") return capabilities();
    if (method === "session.create") return sessionResponse();
    if (method === "session.list") return { sessions: [{ ...sessionResponse().browserSession, pathId: "agent-browser/chrome" }], tabs: [{ ...sessionResponse().tab, pathId: "agent-browser/chrome", controlEpoch: 1 }] };
    if (method === "browser.observe") return { operationId: params.operationId, title: "Fixture", url: "https://fixture.invalid/", content: "bounded", truncated: false };
    if (method === "workspace.focusTab") return { focused: true };
    if (method === "workspace.openScoped" || method === "workspace.selectOwnedTab") return { scopeId: "scope-1", controlState: "agent" };
    if (method === "workspace.acquireViewportLease") return { leaseId: "lease-1", expiresAt: new Date(Date.now() + 30_000).toISOString(), identity: workspaceIdentity() };
    if (method === "workspace.getFrame") return { ...workspaceIdentity(), sequence: 7, mediaType: "image/png", width: 640, height: 480, payload: "cG5n", screenshotSha256: digest };
    if (method === "workspace.compareSetControl") return { controlEpoch: ++epoch };
    if (method === "workspace.input") return { accepted: true, operationId: params.operationId };
    if (method === "browser.act") return { ok: true, operationId: params.operationId };
    if (method === "workspace.releaseViewportLease" || method === "workspace.hide" || method === "tab.close" || method === "session.close") return { ok: true };
    return {};
  });
  return { call, close: vi.fn(async () => undefined) };
}

async function create(port: BrowserDaemonRpcPort) {
  return await port.createSession(owner, { pathId: "agent-browser/chrome" }, "create-1");
}

describe("BrowserDaemonRpcPort API-v3 legacy adapter", () => {
  it("reports only the retained legacy path and removes unsupported capabilities", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await expect(port.capabilities()).resolves.toEqual([expect.objectContaining({ pathId: "agent-browser/chrome", uploads: false, downloads: false, observations: ["screenshot"] })]);
    expect((await port.capabilities())[0]?.actions).not.toContain("download");
  });

  it("projects a clean explicit session and tab descriptor without owner fields", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    const session = await create(port);
    expect(session).toEqual(expect.objectContaining({ browserSessionId: "session-1", pathId: "agent-browser/chrome", controlEpoch: 1, state: "ready", tabs: [expect.objectContaining({ tabId: "tab-1", url: "https://fixture.invalid/" })] }));
    expect(session).not.toHaveProperty("ownerPrincipalId");
    expect(session).not.toHaveProperty("tabId");
  });

  it("keeps actor ownership non-enumerating at the adapter boundary", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await expect(port.getSession(other, "session-1")).rejects.toMatchObject({ code: "wrong-owner" });
    expect(connection.call.mock.calls.filter(([method]) => method === "session.list")).toHaveLength(0);
  });

  it("returns one typed screenshot observation and the exact retained image", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    const observation = await port.observe(owner, "session-1", "screenshot", 200, "observe-1");
    expect(observation).toEqual(expect.objectContaining({ kind: "screenshot", observationId: "observe-1", browserSessionId: "session-1", tabId: "tab-1", imagePixelWidth: 640, imagePixelHeight: 480, digest }));
    const frame = await port.captureFrame(owner, "session-1", "frame-1");
    expect(frame).toEqual(expect.objectContaining({ observationId: "observe-1", payloadBase64: "cG5n", digest }));
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.getFrame")).toHaveLength(1);
  });

  it("binds one coordinate action to the retained observation and rejects replay", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.observe(owner, "session-1", "screenshot", 200, "observe-1");
    await expect(port.act(owner, "session-1", { kind: "click", observationId: "observe-1", x: 10, y: 20 }, "act-1")).resolves.toMatchObject({ state: "succeeded" });
    await expect(port.act(owner, "session-1", { kind: "click", observationId: "observe-1", x: 10, y: 20 }, "act-2")).rejects.toMatchObject({ status: 409 });
    expect(connection.call).toHaveBeenCalledWith("workspace.input", expect.objectContaining({ action: { type: "click", x: 10, y: 20, button: "left" }, operationId: "act-1" }), undefined);
  });

  it("normalizes initial, explicit navigation, and new-tab URLs before dispatch", async () => {
    const connection = rpc();
    const authority = { authorize: vi.fn(async ({ url }: { url: string }) => ({ mode: "egress-bound" as const, normalizedUrl: `${url}/normalized`, asciiHostname: "example.test", port: 443, resolvedAddresses: ["8.8.8.8"], redirectPolicy: { revalidateEveryHop: true as const, maxRedirects: 10 }, egressBindingId: "proxy-1" })) };
    const port = new BrowserDaemonRpcPort(async () => connection, authority);
    await port.createSession(owner, { pathId: "agent-browser/chrome", url: "https://example.test" }, "create-1");
    await port.act(owner, "session-1", { kind: "navigate", url: "https://next.test" }, "navigate-1");
    await port.createTab(owner, "session-1", "https://tab.test", "tab-1");
    expect(connection.call).toHaveBeenCalledWith("session.create", { pathId: "agent-browser/chrome", url: "https://example.test/normalized" }, undefined);
    expect(connection.call).toHaveBeenCalledWith("browser.act", expect.objectContaining({ action: { kind: "navigate", url: "https://next.test/normalized" } }), undefined);
    expect(connection.call).toHaveBeenCalledWith("browser.act", expect.objectContaining({ action: { kind: "tab-new", url: "https://tab.test/normalized" } }), undefined);
  });

  it("settles retained leases and actor connections on shutdown", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.observe(owner, "session-1", "screenshot", 200, "observe-1");
    await port.shutdown();
    expect(connection.call).toHaveBeenCalledWith("workspace.releaseViewportLease", { scopeId: "scope-1", leaseId: "lease-1" }, undefined);
    expect(connection.close).toHaveBeenCalled();
  });
});
