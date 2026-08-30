import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseBindRequest,
  parseBrowserRequest,
  type ActorIdentity,
  type BrowserRequest,
  type SessionDescriptor,
  type TabDescriptor,
} from "../../../packages/browser-protocol/src/index.js";
import {
  WebxClient,
  WebxFacadeClient,
  UnixSocketTransport,
  nodeNdjsonConnectionFactory,
} from "../../../packages/sdk/src/index.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "../src/runtime.js";

const imageBytes = (() => { const value = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value); value.write("IHDR", 12, "ascii"); value.writeUInt32BE(1600, 16); value.writeUInt32BE(1200, 20); return value; })();
const imageBase64 = imageBytes.toString("base64");
const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
const artifactId = "artifact_route_fixture_0001";
const observationId = "observation_route_fixture_0001";
const domObservationId = "dom_observation_route_0001";
const domHandle = "dom_handle_route_fixture_0001";
const personaId = "persona_route_fixture_0001";

interface RecordedRequest {
  readonly actor: ActorIdentity;
  readonly request: BrowserRequest;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

class PrivateBrowserdFixture {
  readonly boundActors: ActorIdentity[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly sockets = new Set<Socket>();
  readonly sessions = new Map<string, SessionDescriptor[]>();
  readonly directory: string;
  readonly socketPath: string;
  readonly descriptorPath: string;
  #server?: Server;
  #runtimeInstanceId = "runtime_route_fixture_a";
  #sessionSequence = 0;

  private constructor(directory: string) {
    this.directory = directory;
    this.socketPath = join(directory, "browserd-route-fixture.sock");
    this.descriptorPath = join(directory, "browserd.json");
  }

  static async start(directory: string): Promise<PrivateBrowserdFixture> {
    const fixture = new PrivateBrowserdFixture(directory);
    await fixture.listen();
    await fixture.writeDescriptor();
    return fixture;
  }

  async replaceRuntime(): Promise<void> {
    this.#runtimeInstanceId = "runtime_route_fixture_b";
    await this.writeDescriptor();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async remove(): Promise<void> {
    await this.stop();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async listen(): Promise<void> {
    const actors = new WeakMap<Socket, ActorIdentity>();
    this.#server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const value = JSON.parse(line) as unknown;
          if (isBind(value)) {
            const bind = parseBindRequest(value);
            actors.set(socket, bind.actor);
            this.boundActors.push(bind.actor);
            this.send(socket, { protocolVersion: PROTOCOL_VERSION, kind: "bound", requestId: bind.requestId, actor: bind.actor });
            continue;
          }
          const actor = actors.get(socket);
          if (actor === undefined) throw new Error("fixture request arrived before actor binding");
          const request = parseBrowserRequest(value);
          this.requests.push({ actor, request });
          this.respond(socket, actor, request);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.socketPath, () => resolve());
    });
    await chmod(this.socketPath, 0o600);
  }

  private respond(socket: Socket, actor: ActorIdentity, request: BrowserRequest): void {
    if (request.kind === "capabilities.get") {
      this.success(socket, request, {
        kind: "capabilities", available: true, headed: true, screenshotFirst: true, domFallback: true,
        virtualMouse: true, osMouse: false, executableAvailable: true, displayAvailable: true,
        profileRootUsable: true, egressConfigured: true, egressBindingId: "test-route-proxy", runtimeState: "open",
        sessionCapacity: { current: this.sessionCount(), limit: 8, available: 8 - this.sessionCount() },
      });
      return;
    }
    if (request.kind === "session.create") {
      const descriptor = this.createSession(actor);
      this.success(socket, request, descriptor);
      return;
    }
    if (request.kind === "session.list") {
      this.success(socket, request, { kind: "sessions", sessions: this.sessions.get(actor.agentSessionId) ?? [] });
      return;
    }
    if (request.kind === "artifact.read") {
      const offset = request.offset ?? 0;
      const bytes = imageBytes.subarray(offset, Math.min(imageBytes.byteLength, offset + (request.maxBytes ?? imageBytes.byteLength)));
      this.success(socket, request, {
        kind: "artifact", artifactId, mediaType: "image/png", byteLength: bytes.byteLength,
        sha256: imageDigest, offset, totalBytes: imageBytes.byteLength, eof: offset + bytes.byteLength === imageBytes.byteLength,
        base64: bytes.toString("base64"),
      });
      return;
    }
    const session = this.findSession(actor, sessionIdOf(request));
    if (request.kind === "tab.list") {
      this.success(socket, request, { kind: "tabs", tabs: session.tabs });
      return;
    }
    if (request.kind === "observe.screenshot") {
      this.success(socket, request, {
        kind: "screenshotObservation", observationId, address: request.address,
        documentGeneration: 1, viewportGeneration: 1, url: "about:blank", title: "Route fixture",
        capturedAt: "2026-08-29T20:00:00.000Z", capturedMonotonicMs: 100,
        validUntil: "2099-08-29T20:00:30.000Z", viewport: { width: 800, height: 600, devicePixelRatio: 2 },
        scroll: { x: 0, y: 0 }, frameSequence: 1, mediaType: "image/png", byteLength: imageBytes.byteLength,
        imagePixelWidth: 1600, imagePixelHeight: 1200, captureScale: 1, sha256: imageDigest,
        cursor: session.cursor, image: { kind: "artifact", artifactId },
      });
      return;
    }
    if (request.kind === "observe.domFallback") {
      this.success(socket, request, {
        kind: "domObservation", observationId: domObservationId, address: request.address,
        documentGeneration: 1, observedAt: "2026-08-29T20:00:01.000Z", validUntil: "2099-08-29T20:01:01.000Z", truncated: false,
        nodes: [{ handle: domHandle, role: "button", name: "Continue", state: { enabled: true }, bounds: { x: 10, y: 20, width: 90, height: 30 }, locatorDescription: "Continue button" }],
      });
      return;
    }
    if (request.kind === "session.close") {
      const values = this.sessions.get(actor.agentSessionId) ?? [];
      this.sessions.set(actor.agentSessionId, values.filter((value) => value.browserSessionId !== request.browserSessionId));
    }
    this.success(socket, request, { kind: "ack", operationId: request.operationId });
  }

  private createSession(actor: ActorIdentity): SessionDescriptor {
    this.#sessionSequence += 1;
    const suffix = `${actor.agentSessionId.replace(/[^A-Za-z0-9]/gu, "_")}_${this.#sessionSequence}`;
    const browserSessionId = `session_${suffix}`;
    const tab: TabDescriptor = {
      kind: "tab",
      address: { browserSessionId, tabId: `tab_${suffix}`, targetId: `target_${suffix}_000000000000`, controlEpoch: 1 },
      documentGeneration: 1, viewportGeneration: 1, state: "ready", url: "about:blank", title: "Route fixture", frameSequence: 0,
    };
    const descriptor: SessionDescriptor = {
      kind: "session", browserSessionId, controlEpoch: 1, state: "ready", personaId,
      cursor: { x: 0, y: 0, pathSequence: 0, sampleSequence: 0, personaId, visible: true }, tabs: [tab],
    };
    const values = this.sessions.get(actor.agentSessionId) ?? [];
    this.sessions.set(actor.agentSessionId, [...values, descriptor]);
    return descriptor;
  }

  private findSession(actor: ActorIdentity, browserSessionId: string): SessionDescriptor {
    const found = (this.sessions.get(actor.agentSessionId) ?? []).find((value) => value.browserSessionId === browserSessionId);
    if (found === undefined) throw new Error("fixture session was not found for bound actor");
    return found;
  }

  private sessionCount(): number {
    return [...this.sessions.values()].reduce((total, values) => total + values.length, 0);
  }

  private success(socket: Socket, request: BrowserRequest, result: unknown): void {
    this.send(socket, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: request.requestId, operationId: request.operationId, ok: true, result });
  }

  private send(socket: Socket, value: unknown): void {
    socket.write(`${JSON.stringify(value)}\n`);
  }

  private async writeDescriptor(): Promise<void> {
    const descriptor = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeInstanceId: this.#runtimeInstanceId,
      pid: process.pid,
      processStartTicks: await processStartTicks(),
      socketPath: this.socketPath,
      bindingSecret: "b".repeat(43),
      brokerSigningSecret: "s".repeat(43),
      workspaceBrokerSecret: "w".repeat(43),
      startedAt: "2026-08-29T20:00:00.000Z",
    };
    await writeFile(this.descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    await chmod(this.descriptorPath, 0o600);
  }
}

function isBind(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "bind";
}

function sessionIdOf(request: BrowserRequest): string {
  if ("address" in request) return request.address.browserSessionId;
  if ("browserSessionId" in request) return request.browserSessionId;
  throw new Error(`fixture cannot derive a session for ${request.kind}`);
}

async function processStartTicks(): Promise<string> {
  const text = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const ticks = text.slice(end + 2).split(" ")[19];
  if (ticks === undefined) throw new Error("process start ticks are unavailable");
  return ticks;
}

describe("actual AgentCursor WebX Unix route", () => {
  it("keeps backend, actors, images, DOM fallback, restart loss, and search independence truthful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webxd-agentcursor-route-"));
    await chmod(directory, 0o700);
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = directory;
    cleanup.push(async () => { process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory; });

    const browserd = await PrivateBrowserdFixture.start(directory);
    cleanup.push(async () => browserd.remove());
    const webxPath = join(directory, "webxd.sock");
    const runtime = new WebxdRuntime({
      socketPath: webxPath,
      browserSocketPath: join(directory, "unused-legacy.sock"),
      browserBackend: "agentcursor",
      browserDescriptorPath: browserd.descriptorPath,
      browserRuntimeDirectory: directory,
      browserDestinationAuthority: {
        egressBindingId: "test-route-proxy",
        assertReady: async () => undefined,
        authorize: async ({ url }) => ({ mode: "egress-bound", normalizedUrl: url, asciiHostname: new URL(url).hostname, port: 443, resolvedAddresses: ["93.184.216.34"], redirectPolicy: { revalidateEveryHop: true, maxRedirects: 10 }, egressBindingId: "test-route-proxy" }),
      },
      cwd: "/deterministic/agentcursor-route",
      authenticateActor: sameUserPiActorAuthenticator,
    });
    await runtime.start();
    cleanup.push(async () => runtime.stop());

    const actorA = new WebxClient(new UnixSocketTransport(webxPath, nodeNdjsonConnectionFactory));
    const actorB = new WebxClient(new UnixSocketTransport(webxPath, nodeNdjsonConnectionFactory));
    await actorA.bind("route-a");
    await actorB.bind("route-b");

    const capabilities = await actorA.capabilities();
    expect(capabilities.browserPaths.map((path) => path.pathId)).toEqual(["agentcursor/chrome"]);
    expect(capabilities.browserPaths.some((path) => path.pathId === "agent-browser/chrome")).toBe(false);

    const sessionA = await actorA.createBrowserSession({ pathId: "agentcursor/chrome" }, { idempotencyKey: "route-open-a" });
    const sessionB = await actorB.createBrowserSession({ pathId: "agentcursor/chrome" }, { idempotencyKey: "route-open-b" });
    expect(sessionA.browserSessionId).not.toBe(sessionB.browserSessionId);
    expect(browserd.boundActors).toEqual(expect.arrayContaining([
      { principalId: "route-a", agentSessionId: "route-a" },
      { principalId: "route-b", agentSessionId: "route-b" },
    ]));
    expect(await actorA.listBrowserSessions()).toMatchObject({ sessions: [{ browserSessionId: sessionA.browserSessionId }] });
    expect(await actorB.listBrowserSessions()).toMatchObject({ sessions: [{ browserSessionId: sessionB.browserSessionId }] });

    const tabA = sessionA.tabs[0]?.tabId;
    const tabB = sessionB.tabs[0]?.tabId;
    if (tabA === undefined || tabB === undefined) throw new Error("route fixture did not create tabs");
    const screenshot = await actorA.observeBrowser(sessionA.browserSessionId, tabA, "screenshot", 1, { idempotencyKey: "route-observe-a" });
    expect(screenshot).toMatchObject({ kind: "screenshot", observationId, imagePixelWidth: 1600, cssViewportWidth: 800, devicePixelRatio: 2 });
    expect(JSON.stringify(screenshot)).not.toContain(imageBase64);
    const frame = await actorA.getBrowserVisualFrame(sessionA.browserSessionId, tabA, observationId);
    expect(frame.payloadBase64).toBe(imageBase64);
    expect(Buffer.from(frame.payloadBase64, "base64")).toEqual(imageBytes);

    const dom = await actorB.observeBrowser(sessionB.browserSessionId, tabB, "dom", 20, { idempotencyKey: "route-dom-b" });
    expect(dom).toMatchObject({ kind: "dom", domObservationId, nodes: [{ handle: domHandle, role: "button" }] });
    await actorA.actBrowser(sessionA.browserSessionId, tabA, { kind: "click", observationId, coordinateSpace: "imagePixels", x: 800, y: 600 }, { idempotencyKey: "route-click-a" });
    expect(browserd.requests).toContainEqual(expect.objectContaining({
      actor: { principalId: "route-a", agentSessionId: "route-a" },
      request: expect.objectContaining({ kind: "action.coordinate", observationId, coordinateSpace: "imagePixels", action: { kind: "click", at: { x: 800, y: 600 }, button: "left" } }),
    }));

    const facade = new WebxFacadeClient(webxPath, join(directory, "exports"));
    const facadeSignal = new AbortController();
    await facade.start({ signal: facadeSignal.signal, ownerId: "route-facade", cwd: "/deterministic/agentcursor-route" });
    const facadeOptions = { signal: facadeSignal.signal, ownerId: "route-facade", cwd: "/deterministic/agentcursor-route", idempotencyKey: "route-facade-open" };
    const opened = await facade.request("browser.open", {}, facadeOptions);
    const openedData = opened.data as { browserSessionId: string; tabs: Array<{ tabId: string }> };
    const presented = await facade.request("browser.observe", { browserSessionId: openedData.browserSessionId, tabId: openedData.tabs[0]?.tabId }, { ...facadeOptions, idempotencyKey: "route-facade-observe" });
    expect(presented.artifactPayload).toMatchObject({ mediaType: "image/png", dataBase64: imageBase64, complete: true, mode: "image" });
    expect(JSON.stringify(presented.data)).not.toContain(imageBase64);
    expect(JSON.stringify((presented as unknown as { details?: unknown }).details ?? null)).not.toContain(imageBase64);
    await facade.stop({ ownerId: "route-facade" });

    await browserd.replaceRuntime();
    await expect(actorA.getBrowserSession(sessionA.browserSessionId)).rejects.toMatchObject({ status: 409 });

    await browserd.stop();
    await expect(actorA.search({ query: "WebX" }, { idempotencyKey: "route-search-live" })).resolves.toMatchObject({ hits: expect.any(Array) });
    await expect(actorA.capabilities()).resolves.toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "search", healthy: true }),
        expect.objectContaining({ id: "read", healthy: true }),
        expect.objectContaining({ id: "browser", healthy: false }),
      ]),
      browserPaths: [],
    });
  });
});
