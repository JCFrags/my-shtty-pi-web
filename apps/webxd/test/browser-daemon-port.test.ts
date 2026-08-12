import { describe, expect, it, vi } from "vitest";
import { BrowserDaemonRpcPort } from "../src/browser-daemon-port.js";
import type { AuthorityActor } from "../src/ports.js";

const owner: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set() };
const digest = "a".repeat(64);
const capabilities = {
  protocolVersion: "2.0.0",
  supportedPathIds: ["agent-browser/chrome", "pinchtab/chrome"],
  paths: [
    { pathId: "agent-browser/chrome", actions: ["navigate", "mouse-move", "mouse-down", "mouse-up", "click", "double-click", "wheel", "drag", "key-press", "key-down", "key-up", "text-input", "fill", "select", "upload", "download", "back", "forward", "reload", "wait"], observations: ["main", "interactive", "visual", "full", "diff"], visual: true, touch: false, uploads: true, downloads: true },
    { pathId: "pinchtab/chrome", actions: ["navigate", "click", "fill"], observations: ["main", "interactive"], visual: false, touch: false, uploads: false, downloads: false },
  ],
};

function sessionResponse(pathId: "agent-browser/chrome" | "pinchtab/chrome") {
  return {
    pathId,
    host: { hostId: "host-1", backend: pathId.startsWith("agent") ? "agent-browser" : "pinchtab", engine: "chromium", state: "ready", backendSessionId: "backend-1", createdAt: "2026-08-12T00:00:00Z" },
    browserSession: { browserSessionId: "session-1", ownerAgentId: "agent-a", hostId: "host-1", label: "fixture", createdAt: "2026-08-12T00:00:00Z", lastActivityAt: "2026-08-12T00:00:00Z" },
    tab: { tabId: "tab-1", hostId: "host-1", browserSessionId: "session-1", ownerAgentId: "agent-a", title: "Fixture", url: "https://fixture.invalid", index: 0, control: "agent", state: "idle" },
    controlEpoch: 1,
  };
}

function workspaceSnapshot() {
  return {
    scopeId: "scope-1", agentLabel: "Invoking agent",
    sessions: [{ browserSessionId: "session-1", label: "fixture", pathId: "agent-browser/chrome", backend: "agent-browser", engine: "chrome" }],
    tabs: [{ tabId: "tab-1", browserSessionId: "session-1", title: "Fixture", url: "https://fixture.invalid", state: "idle" }],
    selected: { agentLabel: "Invoking agent", browserSessionId: "session-1", sessionLabel: "fixture", tabId: "tab-1", viewportId: "viewport-tab-1", pathId: "agent-browser/chrome", backend: "agent-browser", engine: "chrome", coordinateSpace: "css-viewport", viewportGeneration: 2, hostGeneration: 1, engineGeneration: 1, controlEpoch: 1 },
    viewportState: "connecting", controlState: "agent", events: [],
  };
}

function rpc(pathId: "agent-browser/chrome" | "pinchtab/chrome" = "agent-browser/chrome", failInput = false, failFrame = false, leaseMs = 30_000) {
  let controlCall = 0;
  const call = vi.fn(async (method: string) => {
    if (method === "system.capabilities") return capabilities;
    if (method === "session.create") return sessionResponse(pathId);
    if (method === "workspace.focusTab" || method === "workspace.show") return { agentId: "agent-a", browserSessionId: "session-1", tabId: "tab-1", visible: true };
    if (method === "workspace.hide") return { agentId: "agent-a", tabId: "tab-1", visible: false };
    if (method === "tab.close") return { closed: true };
    if (method === "workspace.openScoped" || method === "workspace.selectOwnedTab") return workspaceSnapshot();
    if (method === "workspace.acquireViewportLease") return { leaseId: "lease-1", expiresAt: new Date(Date.now() + leaseMs).toISOString(), transport: "polled-frames", identity: workspaceSnapshot().selected, geometry: { imageWidth: 1, imageHeight: 1, viewportWidth: 1, viewportHeight: 1, deviceScaleFactor: 1 }, inputSupported: true };
    if (method === "workspace.getFrame") {
      if (failFrame) throw new Error("frame failed");
      return { viewportId: "viewport-tab-1", viewportGeneration: 2, sequence: 7, capturedAt: new Date().toISOString(), mediaType: "image/png", width: 640, height: 480, coordinateSpace: "css-viewport", payload: "cG5n", screenshotSha256: digest, controlEpoch: 1, geometry: { imageWidth: 640, imageHeight: 480, viewportWidth: 640, viewportHeight: 480, deviceScaleFactor: 1 } };
    }
    if (method === "workspace.compareSetControl") return { controlEpoch: ++controlCall + 1 };
    if (method === "workspace.input") {
      if (failInput) throw new Error("input failed");
      return { accepted: true, bindingSequence: 7 };
    }
    if (method === "workspace.releaseViewportLease") return { released: true };
    if (method === "session.list") return { hosts: [], sessions: [{ ...sessionResponse(pathId).browserSession, pathId }], tabs: [{ ...sessionResponse(pathId).tab, pathId, controlEpoch: 1 }] };
    if (method === "browser.observe") return { view: "full", title: "Fixture", url: "https://fixture.invalid", content: "bounded", controls: [], changed: [], artifactId: "screenshot-artifact", truncated: true, metadata: { contentArtifactId: "content-artifact" }, operationId: "operation-observe" };
    if (method === "browser.act") return { ok: true, action: "fill", changed: ["input"], backend: {}, operationId: "operation-fill" };
    if (method === "browser.debug") return { ok: true, operation: "console", data: { entries: [] }, artifactId: "debug-artifact", operationId: "operation-debug" };
    return {};
  });
  return { call, close: vi.fn(async () => undefined) };
}

async function create(port: BrowserDaemonRpcPort, pathId: "agent-browser/chrome" | "pinchtab/chrome" = "agent-browser/chrome") {
  return port.createSession(owner, { pathId }, "operation-create");
}

describe("BrowserDaemonRpcPort frozen browserd seam", () => {
  it("preserves the exact two path IDs and frozen session.create shape", async () => {
    const connection = rpc("pinchtab/chrome");
    const port = new BrowserDaemonRpcPort(async () => connection);
    expect((await port.capabilities()).map((item) => item.pathId)).toEqual(["agent-browser/chrome", "pinchtab/chrome"]);
    const session = await create(port, "pinchtab/chrome");
    expect(session).toMatchObject({ pathId: "pinchtab/chrome", ownerPrincipalId: "principal-a", ownerAgentId: "agent-a" });
    expect(connection.call).toHaveBeenCalledWith("session.create", { pathId: "pinchtab/chrome" }, undefined);
  });

  it("lists owned frozen sessions and routes safe debug", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    expect(await port.listSessions(owner)).toEqual([expect.objectContaining({ sessionId: "session-1", tabId: "tab-1", pathId: "agent-browser/chrome" })]);
    expect(await port.debug(owner, "session-1", { operation: "console", maxChars: 100 }, "operation-debug")).toMatchObject({ ok: true, operation: "console", artifactId: "debug-artifact" });
    expect(connection.call).toHaveBeenCalledWith("browser.debug", { browserSessionId: "session-1", tabId: "tab-1", operation: "console", args: {}, maxChars: 100, operationId: "operation-debug" }, undefined);
    await port.shutdown();
    expect(connection.close).toHaveBeenCalledTimes(2);
  });

  it("maps workspace takeover and return plus close-tab to frozen methods", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.workspace(owner, { action: "takeover", sessionId: "session-1" }, "workspace-1");
    await port.workspace(owner, { action: "return", sessionId: "session-1" }, "workspace-2");
    await port.closeTab(owner, "session-1", "tab-1");
    const controls = connection.call.mock.calls.filter(([method]) => method === "workspace.compareSetControl").map(([, params]) => params.control);
    expect(controls).toEqual(["human", "agent"]);
    expect(connection.call).toHaveBeenCalledWith("tab.close", { browserSessionId: "session-1", tabId: "tab-1" }, undefined);
  });

  it("parses the frozen legacy Observation shape after artifact ingestion", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    const observed = await port.observe(owner, "session-1", "full", 100, "operation-observe");
    expect(observed).toMatchObject({ operationId: "operation-observe", content: "bounded", truncated: true, artifactId: "content-artifact" });
    expect(observed).not.toHaveProperty("screenshot");
    expect(connection.call).toHaveBeenCalledWith("browser.observe", { browserSessionId: "session-1", tabId: "tab-1", view: "full", maxChars: 100, operationId: "operation-observe" }, undefined);
  });

  it("retains the exact captured frame lease for one later bound action", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    const frame = await port.captureFrame(owner, "session-1", "operation-frame");
    expect(frame).toMatchObject({ mediaType: "image/png", width: 640, height: 480, payloadBase64: "cG5n", screenshotSha256: digest, screenshotSequence: 7, viewportId: "viewport-tab-1", viewportGeneration: 2 });
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.getFrame");
    expect(connection.call.mock.calls.some(([method]) => method === "workspace.releaseViewportLease")).toBe(false);
  });

  it("routes screenshot-bound mouse input through the exact scoped workspace sequence", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await port.act(owner, "session-1", { kind: "mouse-move", x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua");
    const methods = connection.call.mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method.startsWith("workspace."))).toEqual(["workspace.focusTab", "workspace.openScoped", "workspace.selectOwnedTab", "workspace.acquireViewportLease", "workspace.getFrame", "workspace.compareSetControl", "workspace.input", "workspace.compareSetControl", "workspace.releaseViewportLease"]);
    expect(connection.call).toHaveBeenCalledWith("workspace.input", {
      scopeId: "scope-1", leaseId: "lease-1", viewportId: "viewport-tab-1", viewportGeneration: 2,
      controlEpoch: 2, screenshotSha256: digest, screenshotSequence: 7, inputSequence: 1,
      action: { type: "mouse_move", x: 12, y: 34 },
    }, undefined);
    expect(methods).not.toContain("browser.act");
    expect(methods.filter((method) => method === "workspace.acquireViewportLease")).toHaveLength(1);
    expect(methods.filter((method) => method === "workspace.getFrame")).toHaveLength(1);
  });

  it("returns control to the agent and releases the lease after input failure", async () => {
    const connection = rpc("agent-browser/chrome", true);
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua")).rejects.toThrow("input failed");
    const controls = connection.call.mock.calls.filter(([method]) => method === "workspace.compareSetControl");
    expect(controls.map(([, params]) => params.control)).toEqual(["human", "agent"]);
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
  });

  it("returns control and releases the lease when caller cancellation aborts input", async () => {
    const connection = rpc();
    const original = connection.call.getMockImplementation();
    const controller = new AbortController();
    connection.call.mockImplementation(async (method, params, signal) => {
      if (method === "workspace.input") {
        controller.abort();
        throw new DOMException("input cancelled", "AbortError");
      }
      if (original === undefined) throw new Error("missing RPC fixture implementation");
      return original(method, params, signal);
    });
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame", controller.signal);
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.compareSetControl").map(([, params]) => params.control)).toEqual(["human", "agent"]);
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
  });

  it("fails a stale visual guard before input and still releases the lease", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await expect(port.act(owner, "session-1", { kind: "click", x: 12, y: 34, button: "left", visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: "b".repeat(64), screenshotSequence: 7 } }, "operation-cua")).rejects.toMatchObject({ code: "stale-visual" });
    expect(connection.call.mock.calls.some(([method]) => method === "workspace.input")).toBe(false);
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
  });

  it("consumes a captured frame once and refuses replay", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    const action = { kind: "mouse-move" as const, x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } };
    await port.act(owner, "session-1", action, "operation-cua-1");
    await expect(port.act(owner, "session-1", action, "operation-cua-2")).rejects.toMatchObject({ code: "stale-visual" });
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.input")).toHaveLength(1);
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.releaseViewportLease")).toHaveLength(1);
  });

  it("serializes concurrent replay attempts so only one action can consume the frame", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    const action = { kind: "mouse-move" as const, x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } };
    const results = await Promise.allSettled([
      port.act(owner, "session-1", action, "operation-cua-1"),
      port.act(owner, "session-1", action, "operation-cua-2"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.input")).toHaveLength(1);
  });

  it("expires an unused captured frame and releases its bounded lease", async () => {
    vi.useFakeTimers();
    try {
      const connection = rpc("agent-browser/chrome", false, false, 100);
      const port = new BrowserDaemonRpcPort(async () => connection);
      await create(port);
      await port.captureFrame(owner, "session-1", "operation-frame");
      await vi.advanceTimersByTimeAsync(101);
      await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 1, y: 1, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua")).rejects.toMatchObject({ code: "stale-visual" });
      expect(connection.call.mock.calls.filter(([method]) => method === "workspace.releaseViewportLease")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a captured frame after an intervening semantic action", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await port.act(owner, "session-1", { kind: "fill", ref: "e1", text: "value" }, "operation-fill");
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 1, y: 1, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua")).rejects.toMatchObject({ code: "stale-visual" });
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.releaseViewportLease")).toHaveLength(1);
    expect(connection.call.mock.calls.some(([method]) => method === "workspace.input")).toBe(false);
  });

  it("invalidates a captured frame across human takeover and return", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await port.setControl(owner, "session-1", "human", "operation-takeover");
    await port.setControl(owner, "session-1", "agent", "operation-return");
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 1, y: 1, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua")).rejects.toMatchObject({ code: "stale-visual" });
    expect(connection.call.mock.calls.some(([method]) => method === "workspace.input")).toBe(false);
  });

  it("does not let another actor consume or invalidate an owned captured frame", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    const action = { kind: "mouse-move" as const, x: 1, y: 1, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } };
    await expect(port.act({ ...owner, agentId: "agent-b" }, "session-1", action, "operation-cross-owner")).rejects.toMatchObject({ code: "wrong-owner" });
    await port.act(owner, "session-1", action, "operation-owner");
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.input")).toHaveLength(1);
  });

  it("releases retained leases on frame error and shutdown", async () => {
    const failedConnection = rpc("agent-browser/chrome", false, true);
    const failedPort = new BrowserDaemonRpcPort(async () => failedConnection);
    await create(failedPort);
    await expect(failedPort.captureFrame(owner, "session-1", "operation-frame-error")).rejects.toThrow("frame failed");
    expect(failedConnection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");

    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.captureFrame(owner, "session-1", "operation-frame");
    await port.shutdown();
    expect(connection.call.mock.calls.filter(([method]) => method === "workspace.releaseViewportLease")).toHaveLength(1);
    expect(connection.close).toHaveBeenCalledTimes(2);
  });

  it("uses frozen legacy browser.act shapes only for semantic actions", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.act(owner, "session-1", { kind: "fill", ref: "e1", text: "value" }, "operation-fill");
    expect(connection.call).toHaveBeenCalledWith("browser.act", { browserSessionId: "session-1", tabId: "tab-1", action: { kind: "fill", ref: "e1", text: "value" }, operationId: "operation-fill" }, undefined);
  });

  it("rejects PinchTab visual CUA and wrong owners before daemon dispatch", async () => {
    const connection = rpc("pinchtab/chrome");
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port, "pinchtab/chrome");
    const before = connection.call.mock.calls.length;
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 1, y: 1, visualGuard: { viewportId: "v", viewportGeneration: 1, screenshotSha256: digest, screenshotSequence: 1 } }, "operation-2")).rejects.toMatchObject({ code: "unsupported" });
    await expect(port.getSession({ ...owner, principalId: "principal-b" }, "session-1")).rejects.toMatchObject({ code: "wrong-owner" });
    expect(connection.call).toHaveBeenCalledTimes(before);
  });
});
