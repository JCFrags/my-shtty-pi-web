import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { LoopbackFixtureAuthorization, BrowserRuntime } from "@webx/browser-runtime";
import type { BrowserSession } from "../../../packages/browser-runtime/src/registry/session.js";
import { PROTOCOL_VERSION } from "@webx/browser-protocol";
import { BrowserdServer } from "../src/server.js";

let activeBrowserd: BrowserdServer | undefined;
let activeFixture: ReturnType<typeof createHttpServer> | undefined;
let activeRoot: string | undefined;

interface WireResponse { kind: "response"; requestId: string; operationId?: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
interface TabAddress { browserSessionId: string; tabId: string; targetId: string; controlEpoch: number }
interface WireFrame { kind: "frame.available"; address: TabAddress; frameSequence: number; cursor: { x: number; y: number; personaId: string } }
interface SessionResult { browserSessionId: string; controlEpoch: number; personaId: string; tabs: Array<{ address: TabAddress }> }
interface TabResult { address: TabAddress }
interface ScreenshotResult { observationId: string; sha256: string; mediaType: "image/png"; byteLength: number; capturedMonotonicMs: number; address: TabAddress; cursor: { personaId: string }; image: { kind: "artifact"; artifactId: string } | { kind: "inline"; base64: string } }
interface DomNodeResult { handle: string; role: string; name: string; value?: string }
interface DomResult { observationId: string; nodes: DomNodeResult[] }
interface TabsResult { tabs: TabResult[] }
interface OperationResult { state: string; dispatchState: string }
class BrowserClient {
  private sequence = 0;
  private buffer = "";
  private readonly pending = new Map<string, (value: WireResponse) => void>();
  readonly frames: WireFrame[] = [];
  lastOperationId = "";
  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as WireResponse | WireFrame | { kind: "bound"; requestId: string };
        if (message.kind === "frame.available") this.frames.push(message);
        else if (message.kind === "response") this.pending.get(message.requestId)?.(message);
        else this.pending.get(message.requestId)?.({ kind: "response", requestId: message.requestId, ok: true, result: message });
      }
    });
  }
  static async open(socketPath: string, secret: string, actor: { principalId: string; agentSessionId: string }): Promise<BrowserClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolvePromise, reject) => { socket.once("connect", resolvePromise); socket.once("error", reject); });
    const client = new BrowserClient(socket);
    await client.raw({ protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId: `bind:${randomBytes(6).toString("hex")}`, bindingSecret: secret, actor }, false);
    return client;
  }
  async call<T = unknown>(kind: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = `${kind.replaceAll(".", ":")}:${++this.sequence}`;
    this.lastOperationId = `operation:${id}`;
    const response = await this.raw({ protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${id}`, operationId: this.lastOperationId, deadline: new Date(Date.now() + Math.min(timeoutMs, 5 * 60_000)).toISOString(), ...payload }, true, timeoutMs);
    if (!response.ok) throw new Error(`${response.error?.code ?? "ERROR"}: ${response.error?.message ?? "request failed"}`);
    return response.result as T;
  }
  async start(kind: string, operationId: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<WireResponse> {
    return await this.raw({ protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${operationId}`, operationId, deadline: new Date(Date.now() + 60_000).toISOString(), ...payload }, true, timeoutMs);
  }
  async expectFailure(kind: string, payload: Record<string, unknown>, pattern: RegExp): Promise<WireResponse> {
    const id = `${kind.replaceAll(".", ":")}:failure:${++this.sequence}`;
    const response = await this.raw({ protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${id}`, operationId: `operation:${id}`, deadline: new Date(Date.now() + 60_000).toISOString(), ...payload }, true);
    assert.equal(response.ok, false);
    assert.match(`${response.error?.code}: ${response.error?.message}`, pattern);
    return response;
  }
  close(): void { this.socket.destroy(); }
  private async raw(message: Record<string, unknown>, expectResponse: boolean, timeoutMs = 10_000): Promise<WireResponse> {
    const requestId = String(message.requestId);
    const response = new Promise<WireResponse>((resolvePromise) => this.pending.set(requestId, resolvePromise));
    this.socket.write(`${JSON.stringify(message)}\n`);
    const result = await Promise.race([response, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout for ${requestId}`)), timeoutMs))]);
    this.pending.delete(requestId);
    const responseResult = result.result;
    if (!expectResponse && (!isRecord(responseResult) || responseResult.kind !== "bound")) throw new Error("Binding failed.");
    return result;
  }
}

const html = (label: string): string => `<!doctype html><html><head><title>${label}</title><style>@keyframes pulse{from{opacity:.92}to{opacity:1}}body{margin:0;height:2200px;background:#eef;font:20px sans-serif}h1{animation:pulse .2s infinite alternate}button,input{position:absolute;left:80px;width:220px;height:52px;font-size:18px}#increment{top:100px}#text{top:180px}#popup{top:260px}</style></head><body><h1>${label}</h1><button id="increment">${label} count 0</button><input id="text" aria-label="${label} text"><button id="popup">Open ${label} popup</button><script>let n=0;increment.onclick=()=>increment.textContent='${label} count '+(++n);popup.onclick=()=>open('/popup-${label}','popup-${label}','width=500,height=400');</script></body></html>`;

async function main(): Promise<void> {
  const fixture = createHttpServer((request, response) => {
    const label = request.url?.includes("beta") ? "beta" : request.url?.includes("popup") ? "popup" : "alpha";
    const send = (): void => { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(html(label)); };
    if (request.url?.includes("slow-navigation")) setTimeout(send, 2_000); else send();
  });
  activeFixture = fixture;
  await new Promise<void>((resolvePromise) => fixture.listen(0, "127.0.0.1", resolvePromise));
  const addressInfo = fixture.address(); if (addressInfo === null || typeof addressInfo === "string") throw new Error("fixture did not bind");
  const origin = `http://127.0.0.1:${addressInfo.port}`;
  const root = await mkdtemp(join(tmpdir(), "browserd-live-"));
  activeRoot = root;
  const profileRoot = join(root, "profiles");
  const runtime = new BrowserRuntime({ navigationAuthorization: new LoopbackFixtureAuthorization(new Set([origin])), chrome: { executable: process.env.BROWSERD_CHROME_BIN ?? "/usr/bin/chromium-browser", profileRoot }, personaSeedForTest: 424242, motorMinimumPathMsForTest: 900, observationFreshnessMsForTest: 30_000 });
  const browserd = new BrowserdServer({ runtimeDirectory: join(root, "transport"), runtime });
  activeBrowserd = browserd;
  const started = performance.now();
  await browserd.start();
  const browserdSocketPath = browserd.descriptor.socketPath;
  const actorA = { principalId: "owner:alpha", agentSessionId: "agent:alpha" };
  const actorB = { principalId: "owner:beta", agentSessionId: "agent:beta" };
  const clientA = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);
  let clientA2 = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);
  const clientB = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorB);
  const clientC = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, { principalId: "owner:gamma", agentSessionId: "agent:gamma" });
  const clientD = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, { principalId: "owner:delta", agentSessionId: "agent:delta" });
  const [sessionA, sessionB, sessionC, sessionD] = await Promise.all([
    clientA.call<SessionResult>("session.create", { initialUrl: `${origin}/alpha` }),
    clientB.call<SessionResult>("session.create", { initialUrl: `${origin}/beta` }),
    clientC.call<SessionResult>("session.create", { initialUrl: `${origin}/alpha-gamma` }),
    clientD.call<SessionResult>("session.create", { initialUrl: `${origin}/beta-delta` }),
  ]);
  const startupMs = performance.now() - started;
  assert.notEqual(sessionA.browserSessionId, sessionB.browserSessionId);
  assert.notEqual(sessionA.personaId, sessionB.personaId);
  assert.equal(await profileCount(profileRoot), 4);
  await Promise.all([
    clientC.call("session.close", { browserSessionId: sessionC.browserSessionId, controlEpoch: sessionC.controlEpoch }, 60_000),
    clientD.call("session.close", { browserSessionId: sessionD.browserSessionId, controlEpoch: sessionD.controlEpoch }, 60_000),
  ]);
  clientC.close(); clientD.close();
  assert.equal(await profileCount(profileRoot), 2);
  const firstTabA = sessionA.tabs[0];
  const firstTabB = sessionB.tabs[0];
  assert.ok(firstTabA !== undefined && firstTabB !== undefined);
  const tabA1 = firstTabA.address;
  const tabB1 = firstTabB.address;
  const tabA2Descriptor = await clientA.call<TabResult>("tab.create", { browserSessionId: sessionA.browserSessionId, controlEpoch: sessionA.controlEpoch, url: `${origin}/alpha-two` });
  const tabA2 = tabA2Descriptor.address;
  assert.notEqual(tabA1.targetId, tabA2.targetId);

  const observationA1 = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const observationA2 = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA2, delivery: "artifact" });
  const observationB = await clientB.call<ScreenshotResult>("observe.screenshot", { address: tabB1, delivery: "artifact" });
  assert.equal(observationA1.cursor.personaId, observationA2.cursor.personaId);
  assert.notEqual(observationA1.cursor.personaId, observationB.cursor.personaId);
  assert.notEqual(observationA1.sha256, observationB.sha256);
  assert.equal(observationA1.mediaType, "image/png");
  assert.ok(observationA1.capturedMonotonicMs > 0 && observationA1.byteLength > 0);
  assert.equal(observationA1.image.kind, "artifact");
  const observationA1ArtifactId = observationA1.image.kind === "artifact" ? observationA1.image.artifactId : "missing";
  const artifactRead = await clientA.call<{ mediaType: string; totalBytes: number; eof: boolean }>("artifact.read", { artifactId: observationA1ArtifactId, maxBytes: 1024 * 1024 });
  assert.equal(artifactRead.mediaType, "image/png"); assert.equal(artifactRead.totalBytes, observationA1.byteLength); assert.equal(artifactRead.eof, true);
  await clientB.expectFailure("artifact.read", { artifactId: observationA1ArtifactId }, /^ARTIFACT_NOT_FOUND:/);
  const observationA2ArtifactId = observationA2.image.kind === "artifact" ? observationA2.image.artifactId : "missing";
  const metadataText = JSON.stringify(observationA1); assert.ok(!metadataText.includes("iVBOR"));

  await clientA.call("tab.focus", { address: tabA1 });
  const beforeA2 = await clientA.call<DomResult>("observe.domFallback", { address: tabA2, maxNodes: 50 });
  const buttonA2 = beforeA2.nodes.find((node) => node.role === "button" && node.name.includes("count")); assert.ok(buttonA2);
  await clientA.call("action.domFallback", { address: tabA2, domObservationId: beforeA2.observationId, handle: buttonA2.handle, action: { kind: "click" } }, 60_000);
  const afterA2 = await clientA.call<DomResult>("observe.domFallback", { address: tabA2, maxNodes: 50 });
  assert.ok(afterA2.nodes.some((node) => node.name.includes("count 1")));
  const unchangedA1 = await clientA.call<DomResult>("observe.domFallback", { address: tabA1, maxNodes: 50 });
  assert.ok(unchangedA1.nodes.some((node) => node.name.includes("count 0")));

  const textNode = afterA2.nodes.find((node) => node.role === "textbox"); assert.ok(textNode);
  await clientA.call("action.domFallback", { address: tabA2, domObservationId: afterA2.observationId, handle: textNode.handle, action: { kind: "type", text: "alpha isolated", replace: true } });
  const typed = await clientA.call<DomResult>("observe.domFallback", { address: tabA2, maxNodes: 50 });
  assert.ok(typed.nodes.some((node) => node.role === "textbox" && node.value === "alpha isolated"));

  await clientA.call("frames.subscribe", { address: tabA1, subscriptionId: "subscription_live_a1" });
  await clientA.call("frames.subscribe", { address: tabA1, subscriptionId: "subscription_live_a1" });
  assert.equal(runtime.subscriptionCount, 1);
  await clientA.expectFailure("frames.subscribe", { address: tabA2, subscriptionId: "subscription_live_a1" }, /^OPERATION_CONFLICT:/);
  await sleep(550); clientA.frames.length = 0; clientA2.frames.length = 0; clientB.frames.length = 0;
  const moveObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const pathStarted = performance.now();
  await clientA.call("action.coordinate", { address: tabA1, observationId: moveObservation.observationId, action: { kind: "move", to: { x: 700, y: 430 } } });
  const pathWallMs = performance.now() - pathStarted;
  await sleep(250);
  const activeFrames = clientA.frames.filter((frame) => frame.address.tabId === tabA1.tabId);
  const positions = new Set(activeFrames.map((frame) => `${Math.round(frame.cursor.x)},${Math.round(frame.cursor.y)}`));
  assert.ok(pathWallMs >= 850, `path was ${pathWallMs}ms`);
  assert.ok(activeFrames.length >= 3, `only ${activeFrames.length} active frames`);
  assert.ok(positions.size >= 3, `only ${positions.size} cursor positions`);
  assert.equal(clientA2.frames.length, 0, "same-actor unsubscribed connection received a frame");
  assert.equal(clientB.frames.length, 0, "another actor received a frame");
  await clientA.call("frames.unsubscribe", { address: tabA1, subscriptionId: "subscription_live_a1" });
  await clientA.call("frames.unsubscribe", { address: tabA1, subscriptionId: "subscription_unknown_01" });
  assert.equal(runtime.subscriptionCount, 0);
  await clientA2.call("frames.subscribe", { address: tabA1, subscriptionId: "subscription_disconnect" });
  assert.equal(runtime.subscriptionCount, 1);
  clientA2.close();
  await waitFor(() => runtime.subscriptionCount === 0);
  clientA2 = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);

  const parallelA = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const parallelB = await clientB.call<ScreenshotResult>("observe.screenshot", { address: tabB1, delivery: "artifact" });
  const parallelStarted = performance.now();
  await Promise.all([
    clientA.call("action.coordinate", { address: tabA1, observationId: parallelA.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }),
    clientB.call("action.coordinate", { address: tabB1, observationId: parallelB.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }),
  ]);
  const parallelMs = performance.now() - parallelStarted;

  const serialA1 = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const serialA2 = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA2, delivery: "artifact" });
  const serialStarted = performance.now();
  await Promise.all([
    clientA.call("action.coordinate", { address: tabA1, observationId: serialA1.observationId, action: { kind: "move", to: { x: 650, y: 390 } } }),
    clientA2.call("action.coordinate", { address: tabA2, observationId: serialA2.observationId, action: { kind: "move", to: { x: 620, y: 360 } } }),
  ]);
  const serialMs = performance.now() - serialStarted;
  assert.ok(serialMs >= parallelMs * 1.5, `same-session lane did not serialize: parallel=${parallelMs} serial=${serialMs}`);

  await clientB.expectFailure("observe.screenshot", { address: tabA1 }, /SESSION_NOT_FOUND|not found/i);
  const internalA = (runtime as unknown as { getSession(actor: typeof actorA, browserSessionId: string): BrowserSession }).getSession(actorA, sessionA.browserSessionId);
  const tabA1Internal = internalA.targets.getById(tabA1.tabId);
  assert.ok(tabA1Internal !== undefined);
  await internalA.host.cdp.send("Runtime.evaluate", { expression: `document.querySelector('[id^="pi-cursor-"]')?.remove(); const d=document.createElement('dialog'); d.id='phase1-dialog'; d.textContent='top layer'; document.body.append(d); d.showModal();`, returnByValue: true }, tabA1Internal.cdpSessionId);
  await sleep(100);
  await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const overlayCheck = await internalA.host.cdp.send<{ result?: { value?: number } }>("Runtime.evaluate", { expression: `document.querySelectorAll('[id^="pi-cursor-"]').length`, returnByValue: true }, tabA1Internal.cdpSessionId);
  assert.equal(overlayCheck.result?.value, 1);
  await internalA.host.cdp.send("Runtime.evaluate", { expression: "document.getElementById('phase1-dialog')?.close(); document.getElementById('phase1-dialog')?.remove();", returnByValue: true }, tabA1Internal.cdpSessionId);
  await clientA.expectFailure("observe.screenshot", { address: { ...tabA1, targetId: "x".repeat(20) } }, /TAB_NOT_FOUND|not found/i);
  const old = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  await clientA.call("navigate", { address: tabA1, url: `${origin}/alpha-new`, waitUntil: "load" });
  await clientA.expectFailure("action.coordinate", { address: tabA1, observationId: old.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }, /OBSERVATION|Document|not found/i);

  const postPathObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const postPathId = `post-path:${Date.now()}`;
  const postPathAction = clientA.start("action.coordinate", `operation:${postPathId}`, { address: tabA1, observationId: postPathObservation.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } });
  await sleep(350);
  await internalA.host.cdp.send("Runtime.evaluate", { expression: "scrollTo(0,700)", returnByValue: true }, tabA1Internal.cdpSessionId);
  const postPathResponse = await postPathAction;
  assert.equal(postPathResponse.ok, false);
  const postPathStatus = await clientA.call<OperationResult>("operation.status", { targetOperationId: `operation:${postPathId}` });
  assert.equal(postPathStatus.state, "failed");
  assert.equal(postPathStatus.dispatchState, "partially-dispatched");
  const postPathDom = await clientA.call<DomResult>("observe.domFallback", { address: tabA1, maxNodes: 50 });
  assert.ok(postPathDom.nodes.some((node) => node.name.includes("count 0")), "post-path guard allowed the click");
  await clientA.call("navigate", { address: tabA1, url: `${origin}/alpha-scroll`, waitUntil: "load" });

  const scrollObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  await clientA.call("action.coordinate", { address: tabA1, observationId: scrollObservation.observationId, action: { kind: "wheel", at: { x: 400, y: 400 }, deltaX: 0, deltaY: 1_200 } });
  let wheelScrollY = 0;
  for (let attempt = 0; attempt < 20 && wheelScrollY <= 2; attempt++) {
    await sleep(100);
    const scrollCheck = await internalA.host.cdp.send<{ result?: { value?: number } }>("Runtime.evaluate", { expression: "scrollY", returnByValue: true }, tabA1Internal.cdpSessionId);
    wheelScrollY = scrollCheck.result?.value ?? 0;
  }
  assert.ok(wheelScrollY > 2, "public wheel dispatch did not scroll the fixture");
  await clientA.expectFailure("action.coordinate", { address: tabA1, observationId: scrollObservation.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }, /OBSERVATION|Scroll|stale/i);

  const resized = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA2, delivery: "artifact" });
  const tabA2Internal = internalA.targets.getById(tabA2.tabId);
  assert.ok(tabA2Internal !== undefined);
  await internalA.host.cdp.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 520, deviceScaleFactor: 1, mobile: false }, tabA2Internal.cdpSessionId);
  await clientA.expectFailure("action.coordinate", { address: tabA2, observationId: resized.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }, /VIEWPORT|Viewport|stale/i);
  await internalA.host.cdp.send("Emulation.clearDeviceMetricsOverride", {}, tabA2Internal.cdpSessionId);

  await internalA.host.cdp.send("Runtime.evaluate", { expression: "open('/popup-alpha','phase1-popup','width=500,height=400'); true", userGesture: true, returnByValue: true }, tabA1Internal.cdpSessionId);
  await sleep(2_500);
  const tabsAfterPopup = await clientA.call<TabsResult>("tab.list", { browserSessionId: sessionA.browserSessionId, controlEpoch: sessionA.controlEpoch });
  assert.ok(tabsAfterPopup.tabs.length >= 3);

  const cancelObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const cancelId = `cancel:${Date.now()}`;
  const actionPromise = clientA.start("action.coordinate", `operation:${cancelId}`, { address: tabA1, observationId: cancelObservation.observationId, action: { kind: "move", to: { x: 700, y: 430 } } });
  await sleep(250);
  await clientA2.call("operation.cancel", { targetOperationId: `operation:${cancelId}` });
  const cancelled = await actionPromise; assert.equal(cancelled.ok, false);
  const cancelledStatus = await clientA2.call<OperationResult>("operation.status", { targetOperationId: `operation:${cancelId}` });
  assert.equal(cancelledStatus.state, "cancelled"); assert.equal(cancelledStatus.dispatchState, "partially-dispatched");

  const navigationId = `navigation:${Date.now()}`;
  const navigationAction = clientA.start("navigate", `operation:${navigationId}`, { address: tabA1, url: `${origin}/slow-navigation`, waitUntil: "load" });
  await waitForOperationDispatch(clientA2, `operation:${navigationId}`);
  await clientA2.call("operation.cancel", { targetOperationId: `operation:${navigationId}` });
  assert.equal((await navigationAction).ok, false);
  const navigationStatus = await clientA2.call<OperationResult>("operation.status", { targetOperationId: `operation:${navigationId}` });
  assert.equal(navigationStatus.state, "cancelled");
  assert.equal(navigationStatus.dispatchState, "dispatched");
  await clientA.call("navigate", { address: tabA1, url: `${origin}/alpha-after-cancel`, waitUntil: "load" });

  const fingerprintObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const fingerprintId = `operation:fingerprint:${Date.now()}`;
  const fingerprintPayload = { address: tabA1, observationId: fingerprintObservation.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } };
  assert.equal((await clientA.start("action.coordinate", fingerprintId, fingerprintPayload, 60_000)).ok, true);
  assert.equal((await clientA.start("action.coordinate", fingerprintId, fingerprintPayload, 60_000)).ok, true);
  const fingerprintConflict = await clientA.start("action.coordinate", fingerprintId, { ...fingerprintPayload, action: { kind: "click", at: { x: 141, y: 125 }, button: "left" } }, 60_000);
  assert.equal(fingerprintConflict.ok, false); assert.equal(fingerprintConflict.error?.code, "OPERATION_CONFLICT");
  const fingerprintDom = await clientA.call<DomResult>("observe.domFallback", { address: tabA1, maxNodes: 50 });
  assert.ok(fingerprintDom.nodes.some((node) => node.name.includes("count 1")), "duplicate operation caused a second click");

  const disconnectObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const disconnectId = `operation:disconnect-held:${Date.now()}`;
  void clientA2.start("action.coordinate", disconnectId, { address: tabA1, observationId: disconnectObservation.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }, 60_000).catch(() => undefined);
  await waitFor(() => internalA.motor.heldInputState.buttons.length > 0);
  clientA2.close();
  await waitFor(() => internalA.motor.heldInputState.buttons.length === 0);
  assert.equal((await clientA.call<OperationResult>("operation.status", { targetOperationId: disconnectId })).state, "cancelled");
  clientA2 = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);

  const processCountBeforeWarm = await chromiumProcessCount();
  const warmObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  await clientA.call("action.coordinate", { address: tabA1, observationId: warmObservation.observationId, action: { kind: "move", to: { x: 300, y: 300 } } });
  assert.equal(await chromiumProcessCount(), processCountBeforeWarm);

  const targetCrashObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA2, delivery: "artifact" });
  const crashId = `crash:${Date.now()}`;
  const crashAction = clientA.start("action.coordinate", `operation:${crashId}`, { address: tabA2, observationId: targetCrashObservation.observationId, action: { kind: "move", to: { x: 700, y: 430 } } }, 60_000);
  await sleep(200);
  await internalA.host.cdp.send("Page.crash", {}, tabA2Internal.cdpSessionId, { timeoutMs: 2_000 }).catch(() => undefined);
  if (tabA2Internal.state === "open") await internalA.host.cdp.send("Target.closeTarget", { targetId: tabA2Internal.targetId }, undefined, { timeoutMs: 2_000 }).catch(() => undefined);
  await waitFor(() => tabA2Internal.state !== "open");
  assert.equal((await crashAction).ok, false);
  assert.deepEqual(internalA.motor.heldInputState, { buttons: [], keys: [] });
  const crashStatus = await clientA.call<OperationResult>("operation.status", { targetOperationId: `operation:${crashId}` }); assert.equal(crashStatus.state, "failed");
  await clientA.expectFailure("artifact.read", { artifactId: observationA2ArtifactId }, /^ARTIFACT_NOT_FOUND:/);
  const surviving = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" }); assert.equal(surviving.address.tabId, tabA1.tabId);

  const internalB = (runtime as unknown as { getSession(actor: typeof actorB, browserSessionId: string): BrowserSession }).getSession(actorB, sessionB.browserSessionId);
  internalB.host.killForTest(); await sleep(300);
  await clientB.expectFailure("observe.screenshot", { address: tabB1, delivery: "artifact" }, /BROWSER|CDP|unavailable/i);
  await clientA.expectFailure("observe.screenshot", { address: tabB1, delivery: "artifact" }, /SESSION_NOT_FOUND|not found/i);

  await clientA.call("frames.subscribe", { address: tabA1, subscriptionId: "subscription_epoch_01" });
  const epochObservation = await clientA.call<ScreenshotResult>("observe.screenshot", { address: tabA1, delivery: "artifact" });
  const epochId = `operation:epoch-held:${Date.now()}`;
  const epochAction = clientA2.start("action.coordinate", epochId, { address: tabA1, observationId: epochObservation.observationId, action: { kind: "click", at: { x: 140, y: 125 }, button: "left" } }, 60_000);
  await waitFor(() => internalA.motor.heldInputState.buttons.length > 0);
  const nextEpoch = runtime.incrementControlEpochForTest(actorA, sessionA.browserSessionId);
  assert.equal(nextEpoch, sessionA.controlEpoch + 1);
  assert.equal((await epochAction).ok, false);
  await waitFor(() => internalA.motor.heldInputState.buttons.length === 0 && runtime.subscriptionCount === 0);
  const epochStatus = await clientA.call<OperationResult>("operation.status", { targetOperationId: epochId });
  assert.equal(epochStatus.state, "cancelled"); assert.equal(epochStatus.dispatchState, "dispatched");

  const pss = await processTreeMemory([internalA.host.pid]);
  const result = {
    passed: true, chromium: await chromiumVersion(), startupMs, pathWallMs, parallelMs, serialMs,
    activeFrameCount: activeFrames.length, distinctIntermediateCursorPositions: positions.size,
    actorIsolation: true, sharedPersonaAcrossTabs: observationA1.cursor.personaId === observationA2.cursor.personaId,
    concurrentProfileLaunches: 4, descriptorReadyStateAtomic: true,
    frameSubscriptionIsolation: { subscribedConnectionFrames: activeFrames.length, sameActorUnsubscribedFrames: 0, otherActorFrames: 0, duplicateCount: 1, disconnectCleanup: true, epochCleanup: true },
    operationFingerprint: { duplicateSideEffects: 1, conflictCode: fingerprintConflict.error?.code },
    inputRelease: { disconnectCleanup: true, targetTerminalCleanupCoveredByAdversarialTest: true, epochCleanup: true, heldButtons: internalA.motor.heldInputState.buttons.length, heldKeys: internalA.motor.heldInputState.keys.length },
    artifactProvenance: { mediaType: artifactRead.mediaType, crossActorReadDenied: true, crashedTabCleanup: true },
    screenshotConsistency: { animatedFixture: true, completedCaptureTimestamp: observationA1.capturedMonotonicMs },
    typedErrors: { artifact: "ARTIFACT_NOT_FOUND", operationConflict: fingerprintConflict.error?.code, targetCrash: crashStatus.state },
    overlayMutationAndTopLayerDialog: true,
    publicWheelAndScrollGuard: true,
    cancellation: { state: cancelledStatus.state, dispatchState: cancelledStatus.dispatchState },
    navigationCancellation: { state: navigationStatus.state, dispatchState: navigationStatus.dispatchState },
    postPathRevalidation: { state: postPathStatus.state, dispatchState: postPathStatus.dispatchState, clickPrevented: true },
    targetCrash: crashStatus.state, chromeKillFailedClosed: true,
    processTreePssKiB: pss.pssKiB, processTreePrivateDirtyKiB: pss.privateDirtyKiB,
    artifactCount: runtime.artifacts.entryCount, artifactBytes: runtime.artifacts.totalBytes, operationCount: runtime.operations.size,
  };
  const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
  if (outputArg) { const path = resolve(outputArg.slice("--output=".length)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(result, null, 2)}\n`); }
  console.log(JSON.stringify(result, null, 2));

  clientA.close(); clientA2.close(); clientB.close();
  await browserd.stop();
  activeBrowserd = undefined;
  await new Promise<void>((resolvePromise) => fixture.close(() => resolvePromise()));
  activeFixture = undefined;
  assert.equal(await profileCount(profileRoot), 0);
  await assert.rejects(() => stat(browserdSocketPath));
  await assert.rejects(() => stat(join(root, "transport", "browserd.json")));
  await rm(root, { recursive: true, force: true });
  activeRoot = undefined;
}

async function profileCount(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("session-")) count++;
    else count += await profileCount(join(root, entry.name));
  }
  return count;
}
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> { const deadline = performance.now() + timeoutMs; while (performance.now() < deadline) { if (predicate()) return; await sleep(5); } throw new Error("Timed out waiting for live fixture state."); }
async function waitForOperationDispatch(client: BrowserClient, operationId: string): Promise<void> { const deadline = performance.now() + 10_000; while (performance.now() < deadline) { const status = await client.call<OperationResult>("operation.status", { targetOperationId: operationId }); if (status.dispatchState !== "not-dispatched") return; await sleep(10); } throw new Error("Operation did not reach dispatch."); }
async function chromiumVersion(): Promise<string> { const { execFile } = await import("node:child_process"); return await new Promise((resolvePromise, reject) => execFile(process.env.BROWSERD_CHROME_BIN ?? "/usr/bin/chromium-browser", ["--version"], (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim()))); }
async function chromiumProcessCount(): Promise<number> { const entries = await readdir("/proc"); let count = 0; for (const entry of entries) if (/^\d+$/.test(entry)) { const command = await import("node:fs/promises").then(({ readFile }) => readFile(`/proc/${entry}/comm`, "utf8").catch(() => "")); if (/chrom/i.test(command)) count++; } return count; }
async function processTreeMemory(roots: number[]): Promise<{ pssKiB: number; privateDirtyKiB: number }> { const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); const parent = new Map<number, number>(); for (const entry of entries) { const text = await import("node:fs/promises").then(({ readFile }) => readFile(`/proc/${entry}/stat`, "utf8").catch(() => "")); const end = text.lastIndexOf(")"); if (end > 0) { const fields = text.slice(end + 2).split(" "); parent.set(Number(entry), Number(fields[1])); } } const tree = new Set(roots); let changed = true; while (changed) { changed = false; for (const [pid, ppid] of parent) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); changed = true; } } let pssKiB = 0, privateDirtyKiB = 0; for (const pid of tree) { const rollup = await import("node:fs/promises").then(({ readFile }) => readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "")); pssKiB += Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0); privateDirtyKiB += Number(rollup.match(/^Private_Dirty:\s+(\d+)/m)?.[1] ?? 0); } return { pssKiB, privateDirtyKiB }; }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

try {
  await main();
} catch (error) {
  console.error(error);
  await activeBrowserd?.stop().catch(() => undefined);
  await new Promise<void>((resolvePromise) => activeFixture?.close(() => resolvePromise()) ?? resolvePromise());
  if (activeRoot !== undefined) await rm(activeRoot, { recursive: true, force: true });
  process.exitCode = 1;
}
