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

function rpc(pathId: "agent-browser/chrome" | "pinchtab/chrome" = "agent-browser/chrome", failInput = false) {
  let controlCall = 0;
  const call = vi.fn(async (method: string) => {
    if (method === "system.capabilities") return capabilities;
    if (method === "session.create") return sessionResponse(pathId);
    if (method === "workspace.focusTab") return { agentId: "agent-a", browserSessionId: "session-1", tabId: "tab-1", visible: true };
    if (method === "workspace.openScoped" || method === "workspace.selectOwnedTab") return workspaceSnapshot();
    if (method === "workspace.acquireViewportLease") return { leaseId: "lease-1", expiresAt: "2026-08-12T00:00:30Z", transport: "polled-frames", identity: workspaceSnapshot().selected, geometry: { imageWidth: 1, imageHeight: 1, viewportWidth: 1, viewportHeight: 1, deviceScaleFactor: 1 }, inputSupported: true };
    if (method === "workspace.getFrame") return { viewportId: "viewport-tab-1", viewportGeneration: 2, sequence: 7, capturedAt: "2026-08-12T00:00:01Z", mediaType: "image/png", width: 640, height: 480, coordinateSpace: "css-viewport", payload: "cG5n", screenshotSha256: digest, controlEpoch: 1, geometry: { imageWidth: 640, imageHeight: 480, viewportWidth: 640, viewportHeight: 480, deviceScaleFactor: 1 } };
    if (method === "workspace.compareSetControl") return { controlEpoch: ++controlCall + 1 };
    if (method === "workspace.input") {
      if (failInput) throw new Error("input failed");
      return { accepted: true, bindingSequence: 7 };
    }
    if (method === "workspace.releaseViewportLease") return { released: true };
    if (method === "browser.observe") return { view: "full", title: "Fixture", url: "https://fixture.invalid", content: "bounded", controls: [], changed: [], artifactId: "screenshot-artifact", truncated: true, metadata: { contentArtifactId: "content-artifact" }, operationId: "operation-observe" };
    if (method === "browser.act") return { ok: true, action: "fill", changed: ["input"], backend: {}, operationId: "operation-fill" };
    return {};
  });
  return { call };
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

  it("parses the frozen legacy Observation shape after artifact ingestion", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    const observed = await port.observe(owner, "session-1", "full", 100, "operation-observe");
    expect(observed).toMatchObject({ operationId: "operation-observe", content: "bounded", truncated: true, artifactId: "content-artifact" });
    expect(observed).not.toHaveProperty("screenshot");
    expect(connection.call).toHaveBeenCalledWith("browser.observe", { browserSessionId: "session-1", tabId: "tab-1", view: "full", maxChars: 100, operationId: "operation-observe" }, undefined);
  });

  it("returns a visual guard source from the exact frozen workspace frame shape", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    const frame = await port.captureFrame(owner, "session-1", "operation-frame");
    expect(frame).toMatchObject({ mediaType: "image/png", width: 640, height: 480, payloadBase64: "cG5n", screenshotSha256: digest, screenshotSequence: 7, viewportId: "viewport-tab-1", viewportGeneration: 2 });
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
  });

  it("routes screenshot-bound mouse input through the exact scoped workspace sequence", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await port.act(owner, "session-1", { kind: "mouse-move", x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua");
    const methods = connection.call.mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method.startsWith("workspace."))).toEqual(["workspace.focusTab", "workspace.openScoped", "workspace.selectOwnedTab", "workspace.acquireViewportLease", "workspace.getFrame", "workspace.compareSetControl", "workspace.input", "workspace.compareSetControl", "workspace.releaseViewportLease"]);
    expect(connection.call).toHaveBeenCalledWith("workspace.input", {
      scopeId: "scope-1", leaseId: "lease-1", viewportId: "viewport-tab-1", viewportGeneration: 2,
      controlEpoch: 2, screenshotSha256: digest, screenshotSequence: 7, inputSequence: 1,
      action: { type: "mouse_move", x: 12, y: 34 },
    }, undefined);
    expect(methods).not.toContain("browser.act");
  });

  it("returns control to the agent and releases the lease after input failure", async () => {
    const connection = rpc("agent-browser/chrome", true);
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await expect(port.act(owner, "session-1", { kind: "mouse-move", x: 12, y: 34, visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: digest, screenshotSequence: 7 } }, "operation-cua")).rejects.toThrow("input failed");
    const controls = connection.call.mock.calls.filter(([method]) => method === "workspace.compareSetControl");
    expect(controls.map(([, params]) => params.control)).toEqual(["human", "agent"]);
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
  });

  it("fails a stale visual guard before input and still releases the lease", async () => {
    const connection = rpc();
    const port = new BrowserDaemonRpcPort(async () => connection);
    await create(port);
    await expect(port.act(owner, "session-1", { kind: "click", x: 12, y: 34, button: "left", visualGuard: { viewportId: "viewport-tab-1", viewportGeneration: 2, screenshotSha256: "b".repeat(64), screenshotSequence: 7 } }, "operation-cua")).rejects.toMatchObject({ code: "stale-visual" });
    expect(connection.call.mock.calls.some(([method]) => method === "workspace.input")).toBe(false);
    expect(connection.call.mock.calls.at(-1)?.[0]).toBe("workspace.releaseViewportLease");
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
