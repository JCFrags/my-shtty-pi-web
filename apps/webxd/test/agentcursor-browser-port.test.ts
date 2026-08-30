import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyNavigationAuthorization, type SessionDescriptor, type TabDescriptor } from "../../../packages/browser-protocol/src/index.js";
import { AgentCursorBrowserPort } from "../src/agentcursor-browser-port.js";
import { browserBackendSelection } from "../src/browser-backend-selection.js";
import type { BrowserdClientPool, BrowserdDescriptor, BrowserdRequestFields } from "../src/browserd-client.js";
import type { BrowserDestinationAuthority } from "../src/destination-authority.js";
import type { AuthorityActor } from "../src/ports.js";

const owner: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set(["browser.read", "browser.write"]) };
const other: AuthorityActor = { principalId: "principal-b", agentId: "agent-b", scopes: new Set(["browser.read", "browser.write"]) };
const bytes = (() => { const value = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value); value.write("IHDR", 12, "ascii"); value.writeUInt32BE(1600, 16); value.writeUInt32BE(1200, 20); return value; })();
const digest = createHash("sha256").update(bytes).digest("hex");
const descriptor: BrowserdDescriptor = {
  protocolVersion: "browser.v1",
  runtimeInstanceId: "runtime_fixture_a",
  pid: process.pid,
  processStartTicks: "1",
  socketPath: "/private/browserd.sock",
  bindingSecret: "b".repeat(43),
  brokerSigningSecret: "s".repeat(43),
  startedAt: "2026-08-29T00:00:00.000Z",
};

function tab(tabId = "tab-a", targetId = "target_identifier_a"): TabDescriptor {
  return {
    kind: "tab",
    address: { browserSessionId: "session-a", tabId, targetId, controlEpoch: 1 },
    documentGeneration: 2,
    viewportGeneration: 3,
    state: "ready",
    url: "https://example.test/normalized",
    title: "Fixture",
    frameSequence: 4,
  };
}

function session(tabs: readonly TabDescriptor[] = [tab()]): SessionDescriptor {
  return {
    kind: "session",
    browserSessionId: "session-a",
    controlEpoch: 1,
    state: "ready",
    personaId: "persona_identifier_a",
    cursor: { x: 5, y: 7, pathSequence: 8, sampleSequence: 9, personaId: "persona_identifier_a", visible: true },
    tabs: [...tabs],
  };
}

interface Call { readonly actor: AuthorityActor; readonly operationId: string; readonly fields: BrowserdRequestFields; readonly signal?: AbortSignal }

class FakeClient {
  readonly calls: Call[] = [];
  readonly close = vi.fn(async () => undefined);
  currentDescriptor = descriptor;
  currentTabs: TabDescriptor[] = [tab()];
  available = true;
  artifactBase64 = bytes.toString("base64");
  dynamicObservations = false;
  readonly dynamicArtifacts = new Map<string, Buffer>();

  descriptor = vi.fn(async () => this.currentDescriptor);

  request = vi.fn(async (actor: AuthorityActor, operationId: string, fields: BrowserdRequestFields, signal?: AbortSignal): Promise<unknown> => {
    this.calls.push({ actor, operationId, fields, signal });
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    if (fields.kind === "capabilities.get") return {
      kind: "capabilities",
      available: this.available,
      headed: true,
      screenshotFirst: true,
      domFallback: true,
      virtualMouse: true,
      osMouse: false,
      executableAvailable: true,
      displayAvailable: true,
      profileRootUsable: true,
      egressConfigured: true,
      egressBindingId: "proxy-binding-a",
      runtimeState: "open",
      sessionCapacity: { current: 0, limit: 8, available: 8 },
    };
    if (fields.kind === "session.create") return session(this.currentTabs);
    if (fields.kind === "session.list") return { kind: "sessions", sessions: [session(this.currentTabs)] };
    if (fields.kind === "tab.list") return { kind: "tabs", tabs: [...this.currentTabs] };
    if (fields.kind === "tab.create") {
      this.currentTabs.push(tab("tab-b", "target_identifier_b"));
      return tab("tab-b", "target_identifier_b");
    }
    if (fields.kind === "tab.close") {
      this.currentTabs = this.currentTabs.filter((item) => item.address.tabId !== fields.address.tabId);
      return { kind: "ack", operationId };
    }
    if (fields.kind === "observe.screenshot") {
      const dynamicBytes = this.dynamicObservations ? pngBytes(this.calls.filter((call) => call.fields.kind === "observe.screenshot").length) : bytes;
      const dynamicId = this.dynamicObservations ? `observation_${operationId.replace(/[^A-Za-z0-9]/gu, "_")}` : "observation_identifier_a";
      const dynamicArtifactId = this.dynamicObservations ? `artifact_${dynamicId}` : "artifact_identifier_a";
      if (this.dynamicObservations) this.dynamicArtifacts.set(dynamicArtifactId, dynamicBytes);
      return {
      kind: "screenshotObservation",
      observationId: dynamicId,
      address: fields.address,
      documentGeneration: 2,
      viewportGeneration: 3,
      url: "https://example.test/normalized",
      title: "Fixture",
      capturedAt: "2026-08-29T00:00:01.000Z",
      capturedMonotonicMs: 100,
      validUntil: "2099-08-29T00:00:31.000Z",
      viewport: { width: 800, height: 600, devicePixelRatio: 2 },
      scroll: { x: 0, y: 20 },
      frameSequence: 5,
      mediaType: "image/png",
      byteLength: dynamicBytes.byteLength,
      imagePixelWidth: 1600,
      imagePixelHeight: 1200,
      captureScale: 1,
      sha256: createHash("sha256").update(dynamicBytes).digest("hex"),
      cursor: session().cursor,
      image: { kind: "artifact", artifactId: dynamicArtifactId },
    };
    }
    if (fields.kind === "artifact.read") { const artifactBytes = this.dynamicArtifacts.get(fields.artifactId) ?? bytes; return {
      kind: "artifact",
      artifactId: fields.artifactId,
      mediaType: "image/png",
      byteLength: artifactBytes.byteLength,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      offset: fields.offset ?? 0,
      totalBytes: artifactBytes.byteLength,
      eof: true,
      base64: this.dynamicArtifacts.has(fields.artifactId) ? artifactBytes.toString("base64") : this.artifactBase64,
    }; }
    if (fields.kind === "observe.domFallback") return {
      kind: "domObservation",
      observationId: "dom_observation_identifier_a",
      address: fields.address,
      documentGeneration: 2,
      observedAt: "2026-08-29T00:00:02.000Z",
      truncated: false,
      nodes: [{ handle: "dom_handle_identifier_a", role: "button", name: "Continue", state: { enabled: true }, locatorDescription: "button Continue", bounds: { x: 10, y: 20, width: 100, height: 30 } }],
    };
    if (fields.kind === "operation.cancel") return { kind: "operation", operationId: fields.targetOperationId, state: "cancelled", dispatchState: "not-dispatched", queuedAt: "2026-08-29T00:00:00.000Z", finishedAt: "2026-08-29T00:00:01.000Z" };
    return { kind: "ack", operationId };
  });

  requestPinned = vi.fn(async (actor: AuthorityActor, operationId: string, fields: BrowserdRequestFields, signal?: AbortSignal) => ({ runtimeInstanceId: this.currentDescriptor.runtimeInstanceId, result: await this.request(actor, operationId, fields, signal) }));
  requestWithDescriptor = vi.fn(async (actor: AuthorityActor, operationId: string, fields: (value: BrowserdDescriptor) => Promise<BrowserdRequestFields>, signal?: AbortSignal) => ({ runtimeInstanceId: this.currentDescriptor.runtimeInstanceId, result: await this.request(actor, operationId, await fields(this.currentDescriptor), signal) }));
}

function pngBytes(marker: number): Buffer { const value = Buffer.alloc(25); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value); value.write("IHDR", 12, "ascii"); value.writeUInt32BE(1600, 16); value.writeUInt32BE(1200, 20); value[24] = marker; return value; }

function destination(egressBindingId: string | null = "proxy-binding-a", ready = true): BrowserDestinationAuthority {
  return {
    ...(egressBindingId === null ? {} : { egressBindingId }),
    assertReady: vi.fn(async () => {
      if (!ready) throw new Error("test egress is unavailable");
    }),
    authorize: vi.fn(async ({ url }) => ({
      mode: "egress-bound" as const,
      normalizedUrl: new URL(url).href.replace(/\/$/u, "/normalized"),
      asciiHostname: new URL(url).hostname,
      port: 443,
      resolvedAddresses: ["93.184.216.34"],
      redirectPolicy: { revalidateEveryHop: true as const, maxRedirects: 10 },
      ...(egressBindingId === null ? {} : { egressBindingId }),
    })),
  };
}

function port(client = new FakeClient(), authority = destination()): { readonly client: FakeClient; readonly authority: BrowserDestinationAuthority; readonly port: AgentCursorBrowserPort } {
  return { client, authority, port: new AgentCursorBrowserPort(client as unknown as BrowserdClientPool, authority) };
}

async function opened(value: ReturnType<typeof port>, url?: string) {
  return await value.port.createSession(owner, { pathId: "agentcursor/chrome", ...(url === undefined ? {} : { url }) }, "operation-create");
}

function callOf(client: FakeClient, kind: BrowserdRequestFields["kind"]): Call {
  const call = client.calls.find((item) => item.fields.kind === kind);
  if (call === undefined) throw new Error(`missing ${kind} request`);
  return call;
}

describe("browser backend selection", () => {
  it("defaults to legacy and accepts only immutable startup modes", () => {
    expect(browserBackendSelection(undefined)).toBe("legacy");
    expect(browserBackendSelection("legacy")).toBe("legacy");
    expect(browserBackendSelection("agentcursor")).toBe("agentcursor");
    expect(() => browserBackendSelection("agentcursor/chrome")).toThrow("legacy or agentcursor");
  });
});

describe("AgentCursorBrowserPort", () => {
  it("reports only the truthful agentcursor/chrome capability when browserd is healthy", async () => {
    const value = port();
    await expect(value.port.capabilities()).resolves.toEqual([
      expect.objectContaining({ pathId: "agentcursor/chrome", observations: ["screenshot", "dom"], visual: true, uploads: false, downloads: false }),
    ]);
    value.client.available = false;
    await expect(value.port.capabilities()).resolves.toEqual([]);
  });

  it("reports browser health only when the functional egress probe and binding identity agree", async () => {
    const healthy = port();
    await expect(healthy.port.capabilities()).resolves.toEqual([expect.objectContaining({ pathId: "agentcursor/chrome" })]);
    const mismatched = port(new FakeClient(), destination("different-proxy-binding"));
    await expect(mismatched.port.capabilities()).resolves.toEqual([]);
    const unavailable = port(new FakeClient(), destination("proxy-binding-a", false));
    await expect(unavailable.port.capabilities()).resolves.toEqual([]);
  });

  it("creates a clean public session and signs the normalized initial URL for the actor and runtime", async () => {
    const value = port();
    const result = await opened(value, "https://example.test");
    expect(result).toEqual(expect.objectContaining({
      browserSessionId: "session-a",
      pathId: "agentcursor/chrome",
      state: "ready",
      cursor: expect.objectContaining({ coordinateSpace: "cssViewport" }),
      tabs: [expect.objectContaining({ tabId: "tab-a", documentGeneration: 2, viewportGeneration: 3 })],
    }));
    expect(result).not.toHaveProperty("ownerPrincipalId");
    expect(result.tabs[0]).not.toHaveProperty("targetId");
    const create = callOf(value.client, "session.create").fields;
    if (create.kind !== "session.create" || create.initialUrl === undefined || create.navigationAuthorization === undefined) throw new Error("signed create request missing");
    expect(create.initialUrl).toBe("https://example.test/normalized");
    expect(verifyNavigationAuthorization(create.navigationAuthorization, {
      runtimeInstanceId: descriptor.runtimeInstanceId,
      principalId: owner.principalId,
      agentSessionId: owner.agentId,
      operationId: "operation-create",
      normalizedUrl: create.initialUrl,
      egressBindingId: "proxy-binding-a",
    }, descriptor.brokerSigningSecret)).toEqual(expect.objectContaining({ normalizedUrl: create.initialUrl }));
  });

  it("fails closed before session dispatch when the egress route is unavailable", async () => {
    const unavailable = port(new FakeClient(), destination("proxy-binding-a", false));
    await expect(opened(unavailable)).rejects.toThrow("test egress is unavailable");
    expect(unavailable.client.calls.some((call) => call.fields.kind === "session.create")).toBe(false);

    const unbound = port(new FakeClient(), destination(null));
    await expect(opened(unbound, "https://example.test/")).rejects.toMatchObject({ status: 503, code: "WEBX_POLICY_EGRESS_REQUIRED" });
    expect(unbound.client.calls.some((call) => call.fields.kind === "session.create")).toBe(false);
  });

  it("returns a real screenshot observation and the exact verified artifact bytes", async () => {
    const value = port();
    await opened(value);
    const observation = await value.port.observe(owner, "session-a", "screenshot", 200, "operation-observe", undefined, "tab-a");
    expect(observation).toEqual(expect.objectContaining({
      kind: "screenshot",
      observationId: "observation_identifier_a",
      browserSessionId: "session-a",
      tabId: "tab-a",
      cssViewportWidth: 800,
      cssViewportHeight: 600,
      imagePixelWidth: 1600,
      imagePixelHeight: 1200,
      devicePixelRatio: 2,
      digest,
      mediaType: "image/png",
    }));
    const frame = await value.port.captureFrame(owner, "session-a", "tab-a", "observation_identifier_a");
    expect(frame).toEqual(expect.objectContaining({ observationId: "observation_identifier_a", payloadBase64: bytes.toString("base64"), digest }));
    expect(JSON.stringify(observation)).not.toContain(bytes.toString("base64"));
  });

  it("retrieves concurrent exact observations independently across one session and two tabs", async () => {
    const client = new FakeClient();
    client.currentTabs = [tab(), tab("tab-b", "target_identifier_b")];
    client.dynamicObservations = true;
    const value = port(client);
    await opened(value);
    const first = await value.port.observe(owner, "session-a", "screenshot", 200, "observe-first", undefined, "tab-a");
    const second = await value.port.observe(owner, "session-a", "screenshot", 200, "observe-second", undefined, "tab-a");
    const otherTab = await value.port.observe(owner, "session-a", "screenshot", 200, "observe-other-tab", undefined, "tab-b");
    if (first.kind !== "screenshot" || second.kind !== "screenshot" || otherTab.kind !== "screenshot") throw new Error("expected screenshots");
    const frames = await Promise.all([
      value.port.captureFrame(owner, "session-a", "tab-a", first.observationId),
      value.port.captureFrame(owner, "session-a", "tab-a", second.observationId),
      value.port.captureFrame(owner, "session-a", "tab-b", otherTab.observationId),
    ]);
    expect(new Set(frames.map((frame) => frame.digest)).size).toBe(3);
    expect(frames.map((frame) => frame.observationId)).toEqual([first.observationId, second.observationId, otherTab.observationId]);
    await expect(value.port.captureFrame(other, "session-a", "tab-a", first.observationId)).rejects.toMatchObject({ status: 404 });
    await expect(value.port.captureFrame(owner, "session-a", "tab-b", first.observationId)).rejects.toMatchObject({ status: 409 });
    expect((value.port as unknown as { latestScreenshot?: unknown }).latestScreenshot).toBeUndefined();
  });

  it("rejects changed or non-canonical artifact bytes", async () => {
    const client = new FakeClient();
    client.artifactBase64 = Buffer.from("changed").toString("base64");
    const value = port(client);
    await opened(value);
    await value.port.observe(owner, "session-a", "screenshot", 200, "operation-observe", undefined, "tab-a");
    await expect(value.port.captureFrame(owner, "session-a", "tab-a", "observation_identifier_a")).rejects.toMatchObject({ status: 502 });
  });

  it("forwards image-pixel and CSS coordinate identity with the exact observation", async () => {
    const value = port();
    await opened(value);
    await value.port.act(owner, "session-a", { kind: "click", observationId: "observation_identifier_a", coordinateSpace: "imagePixels", x: 800, y: 600 }, "operation-click", undefined, "tab-a");
    const imageCall = callOf(value.client, "action.coordinate").fields;
    expect(imageCall).toEqual(expect.objectContaining({ observationId: "observation_identifier_a", coordinateSpace: "imagePixels", action: { kind: "click", at: { x: 800, y: 600 }, button: "left" } }));

    value.client.calls.length = 0;
    await value.port.act(owner, "session-a", { kind: "drag", observationId: "observation_identifier_a", coordinateSpace: "cssViewport", from: { x: 10, y: 20 }, to: { x: 30, y: 40 } }, "operation-drag", undefined, "tab-a");
    const cssCall = callOf(value.client, "action.coordinate").fields;
    expect(cssCall).toEqual(expect.objectContaining({ coordinateSpace: "cssViewport", action: { kind: "drag", from: { x: 10, y: 20 }, to: { x: 30, y: 40 } } }));
  });

  it("keeps DOM fallback explicit and forwards opaque handle actions", async () => {
    const value = port();
    await opened(value);
    const observation = await value.port.observe(owner, "session-a", "dom", 40, "operation-dom", undefined, "tab-a");
    expect(observation).toEqual(expect.objectContaining({ kind: "dom", domObservationId: "dom_observation_identifier_a", nodes: [expect.objectContaining({ handle: "dom_handle_identifier_a", role: "button" })] }));
    await value.port.act(owner, "session-a", { kind: "dom-fill", domObservationId: "dom_observation_identifier_a", handle: "dom_handle_identifier_a", text: "hello" }, "operation-dom-action", undefined, "tab-a");
    const action = callOf(value.client, "action.domFallback").fields;
    expect(action).toEqual(expect.objectContaining({ domObservationId: "dom_observation_identifier_a", handle: "dom_handle_identifier_a", action: { kind: "type", text: "hello", replace: true } }));
  });

  it("signs normalized explicit navigation and URL-bearing new tabs without backend fallback", async () => {
    const value = port();
    await opened(value);
    await value.port.act(owner, "session-a", { kind: "navigate", url: "https://next.test" }, "operation-navigate", undefined, "tab-a");
    await value.port.createTab(owner, "session-a", "https://tab.test", "operation-new-tab");
    const navigate = callOf(value.client, "navigate").fields;
    const createTab = callOf(value.client, "tab.create").fields;
    expect(navigate).toEqual(expect.objectContaining({ url: "https://next.test/normalized", navigationAuthorization: expect.any(String) }));
    expect(createTab).toEqual(expect.objectContaining({ url: "https://tab.test/normalized", navigationAuthorization: expect.any(String) }));
    expect(value.client.calls.some((call) => (call.fields as { pathId?: string }).pathId === "agent-browser/chrome")).toBe(false);
  });

  it("lists, focuses, and closes explicit tabs", async () => {
    const value = port();
    await opened(value);
    const withSecond = await value.port.createTab(owner, "session-a", undefined, "operation-new-tab");
    expect(withSecond.tabs.map((item) => item.tabId)).toEqual(["tab-a", "tab-b"]);
    await expect(value.port.focusTab(owner, "session-a", "tab-b", "operation-focus")).resolves.toMatchObject({ tabs: expect.any(Array) });
    await value.port.closeTab(owner, "session-a", "tab-b", "operation-close-tab");
    await expect(value.port.getSession(owner, "session-a")).resolves.toMatchObject({ tabs: [expect.objectContaining({ tabId: "tab-a" })] });
    expect(callOf(value.client, "tab.focus").fields).toEqual(expect.objectContaining({ address: expect.objectContaining({ tabId: "tab-b" }) }));
    expect(callOf(value.client, "tab.close").fields).toEqual(expect.objectContaining({ address: expect.objectContaining({ tabId: "tab-b" }) }));
  });

  it("does not enumerate foreign sessions and confirms ownership with browserd", async () => {
    const value = port();
    await opened(value);
    const before = value.client.calls.length;
    await expect(value.port.getSession(other, "session-a")).rejects.toMatchObject({ status: 404, code: "not-found" });
    expect(value.client.calls).toHaveLength(before);
    await expect(value.port.getSession(owner, "session-a")).resolves.toMatchObject({ browserSessionId: "session-a" });
    expect(value.client.calls.some((call) => call.fields.kind === "session.list")).toBe(true);
  });

  it("rehydrates actor-owned sessions after a webxd port restart without recreating Chrome", async () => {
    const client = new FakeClient();
    const restarted = port(client);
    await expect(restarted.port.listSessions(owner)).resolves.toHaveLength(1);
    const observation = await restarted.port.observe(owner, "session-a", "screenshot", 200, "rehydrated-observe", undefined, "tab-a");
    if (observation.kind !== "screenshot") throw new Error("expected screenshot");
    await expect(restarted.port.captureFrame(owner, "session-a", "tab-a", observation.observationId)).resolves.toMatchObject({ observationId: observation.observationId, digest });
    await expect(restarted.port.act(owner, "session-a", { kind: "click", observationId: observation.observationId, x: 10, y: 20 }, "rehydrated-action", undefined, "tab-a")).resolves.toMatchObject({ state: "succeeded" });
    expect(client.calls.filter((call) => call.fields.kind === "session.create")).toHaveLength(0);
  });

  it("marks old sessions replaced after browserd runtime identity changes", async () => {
    const value = port();
    await opened(value);
    value.client.currentDescriptor = { ...descriptor, runtimeInstanceId: "runtime_fixture_b" };
    await expect(value.port.getSession(owner, "session-a")).rejects.toMatchObject({ status: 409, code: "BROWSER_INSTANCE_REPLACED", retryable: true });
    expect(value.client.calls.filter((call) => call.fields.kind === "session.create")).toHaveLength(1);
  });

  it("forwards cancellation and settles shutdown without closing browser sessions", async () => {
    const value = port();
    await opened(value);
    await expect(value.port.cancel(owner, "operation-running", "operation-cancel-request")).resolves.toEqual({ operationId: "operation-running", state: "cancelled" });
    await value.port.shutdown();
    expect(value.client.close).toHaveBeenCalledOnce();
    expect(value.client.calls.some((call) => call.fields.kind === "session.close")).toBe(false);
  });
});
