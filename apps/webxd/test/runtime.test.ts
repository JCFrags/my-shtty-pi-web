import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { NdjsonConnectionFactory } from "../../../packages/sdk/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebxClient, WebxError, WebxFacadeClient, UnixSocketTransport, nodeNdjsonConnectionFactory } from "../../../packages/sdk/src/index.js";
import { FailClosedBrowserDestinationAuthority, type DestinationResolver } from "../src/destination-authority.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "../src/runtime.js";

const framePayload = "cG5n";
const frameDigest = createHash("sha256").update(Buffer.from(framePayload, "base64")).digest("hex");
const paths = [
  { pathId: "agent-browser/chrome", actions: ["navigate", "mouse-move", "click", "double-click", "wheel", "drag", "key-press", "text-input", "tab-new", "tab-close", "tab-focus"], observations: ["main", "visual"], visual: true, touch: false, uploads: false, downloads: false },
];

class FakeBrowserd {
  server?: Server;
  readonly clients = new Set<Socket>();
  readonly methods: string[] = [];
  registrations = 0;
  unregisters = 0;
  readonly activeOperations = new Map<string, { socket: Socket; id: number }>();
  readonly cancelledOperations = new Set<string>();

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
          if (request.method === "browser.act" && (request.params.action as { kind?: string } | undefined)?.kind === "wait") {
            this.activeOperations.set(String(request.params.operationId), { socket, id: request.id });
            continue;
          }
          if (request.method === "operation.cancel") {
            const operationId = String(request.params.operationId);
            const active = this.activeOperations.get(operationId);
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { operationId, state: active ? "running" : this.cancelledOperations.has(operationId) ? "cancelled" : "failed" } })}\n`);
            if (active) {
              this.activeOperations.delete(operationId);
              this.cancelledOperations.add(operationId);
              active.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: active.id, error: { code: -32010, message: "operation cancelled" } })}\n`);
            }
            continue;
          }
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
    if (method === "agent.heartbeat") return { ok: true };
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
    if (method === "workspace.getFrame") return { viewportId: "viewport-runtime", viewportGeneration: 2, sequence: 7, screenshotSha256: frameDigest, controlEpoch: 1, mediaType: "image/png", width: 640, height: 480, payload: framePayload, coordinateSpace: "css-viewport" };
    if (method === "workspace.compareSetControl") return { controlEpoch: params.control === "human" ? 2 : 3 };
    if (method === "workspace.input") return { accepted: true, bindingSequence: 7, operationId: params.operationId };
    if (method === "workspace.releaseViewportLease") return { released: true };
    if (method === "browser.observe") return { operationId: params.operationId, view: params.view, title: "Runtime", url: "https://fixture.invalid", content: "visual", truncated: false, metadata: {} };
    if (method === "browser.act") return { operationId: params.operationId, ok: true };
    if (method === "tab.close") return { closed: true };
    throw new Error(`unexpected fake browser method: ${method}`);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
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
    await expect(forged.version()).rejects.toMatchObject({ status: 400 });
    expect((await client.search({ query: "WebX" }, { idempotencyKey: "runtime-search-001" })).hits).toHaveLength(1);
    const publicPaths = (await client.capabilities()).browserPaths;
    expect(publicPaths.map((item) => item.pathId)).toEqual(["agent-browser/chrome"]);
    expect(publicPaths.every((item) => item.uploads === false && !item.actions.includes("upload"))).toBe(true);
    await client.createBrowserSession({ pathId: "agent-browser/chrome" }, { idempotencyKey: "runtime-browser-001" });
    expect(browser.registrations).toBe(2);
    expect(browser.methods.filter((method) => method === "agent.register")).toHaveLength(2);

    const exportRoot = join(directory, "exports");
    const facade = new WebxFacadeClient(webxPath, exportRoot);
    const facadeSignal = new AbortController();
    await facade.start({ signal: facadeSignal.signal, ownerId: "facade-owner", cwd: "/deterministic/project" });
    const facadeOptions = { signal: facadeSignal.signal, idempotencyKey: "facade-search-1", ownerId: "facade-owner", cwd: "/deterministic/project" };
    await expect(facade.request("web.search", { query: "WebX" }, facadeOptions)).resolves.toMatchObject({ data: { output: "links" } });
    for (const legacy of [{ operation: "links" }, { effort: "fast" }, { freshness: "day" }, { limit: 5 }, { crawlPages: 1 }, { crawlDepth: 1 }]) {
      await expect(facade.request("web.search", { query: "WebX", ...legacy }, facadeOptions)).rejects.toThrow("is not supported");
    }
    const directRead = await facade.request("web.read", { url: "https://fixture.invalid/webx", maxChars: 8 }, { ...facadeOptions, idempotencyKey: "facade-read-001" });
    const directMetadata = (directRead.data as { metadata: { contentId: string } }).metadata;
    await expect(facade.request("web.readBatch", { items: [{ url: "https://fixture.invalid/webx" }, { url: "https://fixture.invalid/webx", maxChars: 20 }] }, { ...facadeOptions, idempotencyKey: "facade-batch-001" })).resolves.toMatchObject({ data: { metadata: { requested: 2, succeeded: 2 }, results: [{ index: 0, ok: true }, { index: 1, ok: true }] } });
    for (const [index, field] of ["maxPages", "maxDepth", "sameDomain", "save", "unknown"].entries()) {
      await expect(facade.request("web.readBatch", { items: [{ url: "https://fixture.invalid/webx", [field]: field === "save" ? { path: "x.md" } : 1 }] }, { ...facadeOptions, idempotencyKey: `facade-batch-invalid-${index}` })).rejects.toThrow("is not supported");
    }
    await expect(facade.request("web.content", { contentId: directMetadata.contentId, offset: 8, limit: 20 }, { ...facadeOptions, idempotencyKey: "facade-content-001" })).resolves.toMatchObject({ summary: "Stored content", data: { metadata: { mode: "exact", offset: 8 } } });
    await expect(facade.request("web.content", { contentId: directMetadata.contentId, offset: 0, query: "routes" }, { ...facadeOptions, idempotencyKey: "facade-content-invalid" })).rejects.toThrow("mutually exclusive");
    const saved = await facade.request("web.read", { url: "https://fixture.invalid/webx", save: { path: "fixtures/webx.md" } }, { ...facadeOptions, idempotencyKey: "facade-save-001" });
    expect(saved).toMatchObject({ summary: "Web content saved as Markdown", trust: "local", data: { saved: true, relativePath: "fixtures/webx.md", complete: true } });
    expect(await readFile(join(exportRoot, "fixtures", "webx.md"), "utf8")).toContain("WebX routes search, read");
    await expect(facade.request("web.read", { url: "https://fixture.invalid/webx", save: { path: "fixtures/webx.md" } }, { ...facadeOptions, idempotencyKey: "facade-save-002" })).rejects.toThrow("already exists");
    await expect(facade.request("web.read", { url: "https://fixture.invalid/webx", maxPages: 2, save: { path: "fixtures/crawl.md" } }, { ...facadeOptions, idempotencyKey: "facade-save-003" })).rejects.toThrow("maxPages is not supported");
    await expect(facade.request("browser.tabs", { action: "discard-tab", browserSessionId: "session-runtime", tabId: "tab-runtime" }, { signal: facadeSignal.signal, idempotencyKey: "facade-tabs-0001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("no safe Pi 0.84.1 equivalent");
    const opened = await facade.request("browser.open", {}, { signal: facadeSignal.signal, idempotencyKey: "facade-open-00001", ownerId: "facade-owner", cwd: "/deterministic/project" });
    expect(opened).toMatchObject({ data: { browserSessionId: "session-runtime", tabs: [{ tabId: "tab-runtime" }] } });
    const visual = await facade.request("browser.observe", { browserSessionId: "session-runtime", tabId: "tab-runtime" }, { signal: facadeSignal.signal, idempotencyKey: "facade-observe-01", ownerId: "facade-owner", cwd: "/deterministic/project" });
    const observation = visual.data as { observationId: string };
    expect(visual.artifactPayload).toMatchObject({ dataBase64: framePayload, mediaType: "image/png", complete: true, mode: "image" });
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", tabId: "tab-runtime", action: { kind: "click", observationId: observation.observationId, x: 10, y: 20 } }, { signal: facadeSignal.signal, idempotencyKey: "facade-visual-act", ownerId: "facade-owner", cwd: "/deterministic/project" })).resolves.toMatchObject({ summary: "Browser action completed" });
    await expect(facade.request("browser.act", { browserSessionId: "session-runtime", tabId: "tab-runtime", action: { kind: "click", observationId: observation.observationId, x: 10, y: 20 } }, { signal: facadeSignal.signal, idempotencyKey: "facade-stale-act", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toBeInstanceOf(WebxError);
    await expect(facade.request("browser.debug", { browserSessionId: "session-runtime", operation: "cookies" }, { signal: facadeSignal.signal, idempotencyKey: "facade-debug-0001", ownerId: "facade-owner", cwd: "/deterministic/project" })).rejects.toThrow("secret-bearing or unknown debug operation is refused");
    await facade.stop({ ownerId: "facade-owner" });

    await browser.stop();
    await expect(client.capabilities()).resolves.toMatchObject({
      capabilities: [
        { id: "search", healthy: true },
        { id: "read", healthy: true },
        { id: "browser", healthy: false },
      ],
      browserPaths: [],
    });
    browser = new FakeBrowserd(browserPath);
    await browser.start();
    expect((await client.capabilities()).browserPaths).toHaveLength(1);
    expect(browser.registrations).toBe(1);

    await runtime.stop();
    expect(browser.unregisters).toBe(1);
    await expect(readFile(webxPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.capabilities()).rejects.toThrow();
  });

  it("routes bounded Range bytes and cancellation through the actual Unix runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webxd-range-"));
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = directory;
    cleanup.push(async () => { process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory; });
    const webxPath = join(directory, "webxd.sock");
    const runtime = new WebxdRuntime({
      socketPath: webxPath,
      browserSocketPath: join(directory, "unused-browserd.sock"),
      readerUrl: "http://127.0.0.1:8787",
      cwd: "/deterministic/range-fixture",
      authenticateActor: sameUserPiActorAuthenticator,
    });
    await runtime.start();
    cleanup.push(() => runtime.stop());
    const client = new WebxClient(new UnixSocketTransport(webxPath, nodeNdjsonConnectionFactory));
    await client.bind("range-owner");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      requestedUrl: "https://data.example/archive.warc.gz",
      finalUrl: "https://data.example/archive.warc.gz",
      statusCode: 206,
      mediaType: "application/warc",
      contentRange: "bytes 10-14/100",
      rangeStart: 10,
      rangeEnd: 14,
      totalBytes: 100,
      bodyBase64: "YWJjZGU=",
      bodyBytes: 5,
      sha256: "36bbe50ed96841d10443bcb670d6554f0a34b761be67ec9c4a8ad2c0c44ca42c",
      redirectChain: ["https://data.example/archive.warc.gz"],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const ranged = await client.readRange(
      { url: "https://data.example/archive.warc.gz", offset: 10, length: 5 },
      { idempotencyKey: "runtime-range-001" },
    );
    const excerpt = await client.getArtifactBytes(ranged.artifactId, 0, 5);
    expect(excerpt).toMatchObject({ bodyBase64: "YWJjZGU=", sizeBytes: 5, integrityVerified: true });

    const started = Promise.withResolvers<undefined>();
    const readerCancelled = Promise.withResolvers<undefined>();
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      started.resolve(undefined);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          readerCancelled.resolve(undefined);
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = client.readRange(
      { url: "https://data.example/archive.warc.gz", offset: 0, length: 5 },
      { idempotencyKey: "runtime-range-cancel", signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await readerCancelled.promise;
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
      )).rejects.toMatchObject({ status: 403 });
    }
    expect(browser.methods).not.toContain("session.create");

    const session = await client.createBrowserSession(
      { pathId: "agent-browser/chrome" },
      { idempotencyKey: "ssrf-blank-session" },
    );
    const beforeActions = browser.methods.filter((method) => method === "browser.act").length;
    const tabId = session.tabs[0]?.tabId;
    if (tabId === undefined) throw new Error("browser fixture did not return a tab");
    await expect(client.actBrowser(session.browserSessionId, tabId, { kind: "navigate", url: "http://127.0.0.1/" }, { idempotencyKey: "ssrf-navigate" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(client.createBrowserTab(session.browserSessionId, "http://169.254.169.254/", { idempotencyKey: "ssrf-new-tab" }))
      .rejects.toMatchObject({ status: 403 });
    expect(browser.methods.filter((method) => method === "browser.act")).toHaveLength(beforeActions);
  });
});
