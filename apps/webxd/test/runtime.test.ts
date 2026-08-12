import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { NdjsonConnectionFactory } from "../../../packages/sdk/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebxClient, WebxError, WebxFacadeClient, UnixSocketTransport, nodeNdjsonConnectionFactory } from "../../../packages/sdk/src/index.js";
import { FailClosedBrowserDestinationAuthority, type DestinationResolver } from "../src/destination-authority.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "../src/runtime.js";

const paths = [
  { pathId: "agent-browser/chrome", actions: ["navigate", "click", "mouse-move", "mouse-down", "mouse-up", "double-click", "wheel", "drag", "fill", "type", "press", "hover", "scroll", "semantic-drag", "wait", "tab-new", "tab-close", "tab-focus"], observations: ["main", "visual"], visual: true, touch: false, uploads: false, downloads: true },
  { pathId: "pinchtab/chrome", actions: ["navigate", "fill"], observations: ["main", "interactive"], visual: false, touch: false, uploads: false, downloads: false },
];

class FakeBrowserd {
  server?: Server;
  readonly clients = new Set<Socket>();
  readonly methods: string[] = [];
  registrations = 0;
  unregisters = 0;

  constructor(readonly path: string) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
          this.methods.push(request.method);
          if (request.method === "agent.register") this.registrations += 1;
          if (request.method === "agent.unregister") this.unregisters += 1;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: this.result(request.method, request.params) })}\n`);
        }
      });
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.on("error", reject);
      this.server?.listen(this.path, resolve);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  result(method: string, params: Record<string, unknown>): unknown {
    if (method === "agent.register") return { agentId: params.agentId, clientId: params.clientId };
    if (method === "agent.unregister") return { removed: true };
    if (method === "system.capabilities") return { protocolVersion: "2.0.0", supportedPathIds: paths.map((item) => item.pathId), paths };
    if (method === "session.create") return {
      pathId: params.pathId,
      browserSession: { browserSessionId: "session-runtime", ownerAgentId: "owner-runtime", hostId: "host-1", label: "runtime", createdAt: "2026-08-12T00:00:00Z", lastActivityAt: "2026-08-12T00:00:00Z" },
      tab: { tabId: "tab-runtime", hostId: "host-1", browserSessionId: "session-runtime", ownerAgentId: "owner-runtime", title: "Fixture", url: "about:blank", index: 0, control: "agent", state: "idle" },
      controlEpoch: 1,
    };
    if (method === "session.list") return { hosts: [], sessions: [], tabs: [] };
    if (method === "workspace.show" || method === "workspace.focusTab") return { agentId: params.agentId, browserSessionId: params.browserSessionId, tabId: params.tabId, visible: true };
    if (method === "workspace.hide") return { agentId: params.agentId, tabId: params.tabId, visible: false };
    if (method === "workspace.openScoped" || method === "workspace.selectOwnedTab") return { scopeId: "scope-runtime", sessions: [], tabs: [], selected: { browserSessionId: "session-runtime", tabId: "tab-runtime" }, viewportState: "ready", controlState: "agent", events: [] };
    if (method === "workspace.acquireViewportLease") return { leaseId: "lease-runtime", identity: { pathId: "agent-browser/chrome", browserSessionId: "session-runtime", tabId: "tab-runtime", viewportId: "viewport-runtime", viewportGeneration: 2, controlEpoch: 1 } };
    if (method === "workspace.getFrame") return { viewportId: "viewport-runtime", viewportGeneration: 2, sequence: 7, screenshotSha256: "a".repeat(64), controlEpoch: 1, mediaType: "image/png", width: 640, height: 480, payload: "cG5n", coordinateSpace: "css-viewport" };
    if (method === "workspace.compareSetControl") return { controlEpoch: params.control === "human" ? 2 : 3 };
    if (method === "workspace.input") return { accepted: true, bindingSequence: 7 };
    if (method === "workspace.releaseViewportLease") return { released: true };
    if (method === "browser.observe") return { operationId: params.operationId, view: params.view, title: "Runtime", url: "https://fixture.invalid", content: "visual", truncated: false, metadata: {} };
    if (method === "browser.act") return { operationId: params.operationId, ok: true };
    if (method === "tab.close") return { closed: true };
    throw new Error(`unexpected fake browser method: ${method}`);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("actual WebX Unix runtime", () => {
  it("starts, authenticates persistent browser connections, reconnects, and cleans up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webxd-runtime-"));
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = directory;
    cleanup.push(async () => { process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory; });
    const browserPath = join(directory, "browserd.sock");
    const webxPath = join(directory, "webxd.sock");
    let browser = new FakeBrowserd(browserPath);
    await browser.start();
    cleanup.push(() => browser.stop());
    const runtime = new WebxdRuntime({ socketPath: webxPath, browserSocketPath: browserPath, cwd: "/deterministic/project", authenticateActor: sameUserPiActorAuthenticator });
    await runtime.start();
    cleanup.push(() => runtime.stop());
    expect((await stat(webxPath)).mode & 0o777).toBe(0o600);

    const client = new WebxClient(new UnixSocketTransport(webxPath, nodeNdjsonConnectionFactory));
    await client.bind("owner-runtime");
    let capturedBinding: { bindingId: string; bindingSecret: string } | undefined;
    const captureFactory: NdjsonConnectionFactory = async (path) => {
      const connection = await nodeNdjsonConnectionFactory(path);
      return { close: () => connection.close(), send: async (line, signal) => { const response = await connection.send(line, signal); const parsed = JSON.parse(response) as { bindingId?: string; bindingSecret?: string }; if (parsed.bindingId !== undefined && parsed.bindingSecret !== undefined) capturedBinding = { bindingId: parsed.bindingId, bindingSecret: parsed.bindingSecret }; return response; } };
    };
    const boundClient = new WebxClient(new UnixSocketTransport(webxPath, captureFactory));
    await boundClient.bind("bound-owner");
    if (capturedBinding === undefined) throw new Error("binding was not captured");
    const bindingId = capturedBinding.bindingId;
    const forgedFactory: NdjsonConnectionFactory = async (path) => {
      const connection = await nodeNdjsonConnectionFactory(path);
      return { close: () => connection.close(), send: (line, signal) => { const parsed = JSON.parse(line) as { request: unknown }; return connection.send(JSON.stringify({ binding: { bindingId, bindingSecret: "0".repeat(64) }, request: parsed.request }), signal); } };
    };
    const forged = new WebxClient(new UnixSocketTransport(webxPath, forgedFactory));
    await expect(forged.version()).rejects.toMatchObject<WebxError>({ status: 400 });
    expect((await client.search({ query: "WebX" }, { idempotencyKey: "runtime-search-001" })).hits).toHaveLength(1);
    const publicPaths = (await client.capabilities()).browserPaths;
    expect(publicPaths.map((item) => item.pathId)).toEqual(["agent-browser/chrome", "pinchtab/chrome"]);
    expect(publicPaths.every((item) => item.uploads === false && !item.actions.includes("upload"))).toBe(true);
    await client.createBrowserSession({ pathId: "agent-browser/chrome" }, { idempotencyKey: "runtime-browser-001" });
    expect(browser.registrations).toBe(2);
    expect(browser.methods.filter((method) => method === "agent.register")).toHaveLength(2);

    const facade = new WebxFacadeClient(webxPath);
    const facadeSignal = new AbortController();
    await facade.start({ signal: facadeSignal.signal, ownerId: "facade-owner", cwd: "/deterministic/project" });
    await expect(facade.request("browser.workspace", { action: "show" }, { signal: facadeSignal.signal, idempotencyKey: "facade-workspace-1", ownerId: "facade-owner", cwd: "/deterministic/project" })).resolves.toMatchObject({ summary: "Browser workspace show" });
    await expect(facade.request("browser.tabs", { action: "discard-tab", browserSessionId: "session-runtime", tabId: "tab-runtime" }, { signal: facadeSignal.signal, idempotencyKey: "facade-tabs-0001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("no safe Pi 0.84.1 equivalent");
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", action: { kind: "hover", ref: "e1" } }, { signal: facadeSignal.signal, idempotencyKey: "facade-action-001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toBeInstanceOf(WebxError);
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", action: { kind: "upload", ref: "e1", uploadHandleIds: ["handle-1"] } }, { signal: facadeSignal.signal, idempotencyKey: "facade-upload-0001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("upload is not supported by the frozen daemon action shape");
    const opened = await facade.request("browser.open", { pathId: "agent-browser/chrome" }, { signal: facadeSignal.signal, idempotencyKey: "facade-open-00001", ownerId: "facade-owner", cwd: "/deterministic/project" });
    expect(opened).toMatchObject({ data: { sessionId: "session-runtime" } });
    const visual = await facade.request("browser.observe", { browserSessionId: "session-runtime", view: "visual" }, { signal: facadeSignal.signal, idempotencyKey: "facade-observe-01", ownerId: "facade-owner", cwd: "/deterministic/project" });
    const observation = visual.data as { observationId: string; viewportId: string };
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", action: { kind: "mouse-click", observationId: observation.observationId, viewportId: observation.viewportId, x: 10, y: 20 } }, { signal: facadeSignal.signal, idempotencyKey: "facade-visual-act", ownerId: "facade-owner", cwd: "/deterministic/project" })).resolves.toMatchObject({ summary: "Browser action completed" });
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", action: { kind: "mouse-click", observationId: observation.observationId, viewportId: observation.viewportId, x: 10, y: 20 } }, { signal: facadeSignal.signal, idempotencyKey: "facade-stale-act", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("stale or unknown");
    facade.importObservationBindingForTest("cross-owner", "other-owner", "session-runtime", { address: { sessionId: "session-runtime", tabId: "tab-runtime", pathId: "agent-browser/chrome", hostGeneration: 1, engineGeneration: 1, controlEpoch: 1 }, mediaType: "image/png", width: 1, height: 1, payloadBase64: "", screenshotSha256: "a".repeat(64), screenshotSequence: 1, viewportId: "viewport-runtime", viewportGeneration: 2 });
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", action: { kind: "mouse-click", observationId: "cross-owner", viewportId: "viewport-runtime", x: 1, y: 1 } }, { signal: facadeSignal.signal, idempotencyKey: "facade-cross-owner", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("another owner or session");
    await expect(facade.request("browser.debug", { browserSessionId: "session-runtime", operation: "cookies" }, { signal: facadeSignal.signal, idempotencyKey: "facade-debug-0001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("secret-bearing or unknown debug operation is refused");
    await facade.stop({ ownerId: "facade-owner" });

    await browser.stop();
    await expect(client.capabilities()).rejects.toMatchObject<WebxError>({ status: 502 });
    browser = new FakeBrowserd(browserPath);
    await browser.start();
    expect((await client.capabilities()).browserPaths).toHaveLength(2);
    expect(browser.registrations).toBe(1);

    await runtime.stop();
    expect(browser.unregisters).toBe(1);
    await expect(readFile(webxPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.capabilities()).rejects.toThrow();
  });

  it("refuses actual Unix browser URL requests before Browserd dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webxd-ssrf-"));
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = directory;
    cleanup.push(async () => { process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory; });
    const browserPath = join(directory, "browserd.sock");
    const webxPath = join(directory, "webxd.sock");
    const browser = new FakeBrowserd(browserPath);
    await browser.start();
    cleanup.push(() => browser.stop());
    const answers = new Map<string, readonly string[]>([
      ["127.0.0.1", ["127.0.0.1"]],
      ["10.0.0.8", ["10.0.0.8"]],
      ["169.254.2.3", ["169.254.2.3"]],
      ["169.254.169.254", ["169.254.169.254"]],
      ["::ffff:7f00:1", ["::ffff:127.0.0.1"]],
      ["mixed.example", ["93.184.216.34", "192.168.1.8"]],
      ["redirect.example", ["93.184.216.34"]],
    ]);
    const destinationResolver: DestinationResolver = {
      resolve: async (hostname) => answers.get(hostname) ?? [],
    };
    const runtime = new WebxdRuntime({
      socketPath: webxPath,
      browserSocketPath: browserPath,
      cwd: "/deterministic/security-fixture",
      authenticateActor: sameUserPiActorAuthenticator,
      browserDestinationAuthority: new FailClosedBrowserDestinationAuthority(destinationResolver),
    });
    await runtime.start();
    cleanup.push(() => runtime.stop());
    const client = new WebxClient(new UnixSocketTransport(webxPath, nodeNdjsonConnectionFactory));
    await client.bind("ssrf-owner");

    const blocked = [
      "http://127.0.0.1/",
      "http://10.0.0.8/",
      "http://169.254.2.3/",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[::ffff:7f00:1]/",
      "https://mixed.example/",
      "https://redirect.example/to-private",
    ];
    for (const [index, url] of blocked.entries()) {
      await expect(client.createBrowserSession(
        { pathId: "agent-browser/chrome", url },
        { idempotencyKey: `ssrf-initial-${index}` },
      )).rejects.toMatchObject<WebxError>({ status: 403 });
    }
    expect(browser.methods).not.toContain("session.create");

    const session = await client.createBrowserSession(
      { pathId: "agent-browser/chrome" },
      { idempotencyKey: "ssrf-blank-session" },
    );
    const beforeActions = browser.methods.filter((method) => method === "browser.act").length;
    await expect(client.actBrowser(session.sessionId, { kind: "navigate", url: "http://127.0.0.1/" }, { idempotencyKey: "ssrf-navigate" }))
      .rejects.toMatchObject<WebxError>({ status: 403 });
    await expect(client.actBrowser(session.sessionId, { kind: "tab-new", url: "http://169.254.169.254/" }, { idempotencyKey: "ssrf-new-tab" }))
      .rejects.toMatchObject<WebxError>({ status: 403 });
    expect(browser.methods.filter((method) => method === "browser.act")).toHaveLength(beforeActions);
  });
});
