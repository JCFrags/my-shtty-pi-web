import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserRuntime, LoopbackFixtureAuthorization } from "../../../packages/browser-runtime/src/index.js";
import type { BrowserSession } from "../../../packages/browser-runtime/src/registry/session.js";
import { BrowserdServer } from "../../browserd/src/server.js";
import { BrowserdClientPool, type BrowserdFrameSubscription } from "../src/browserd-client.js";
import { ProxyBoundBrowserDestinationAuthority, type BrowserDestinationAuthority, type BrowserDestinationRequest } from "../src/destination-authority.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "../src/runtime.js";

interface Command { readonly id: number; readonly command: string; readonly [key: string]: unknown }
interface TestAuthority extends BrowserDestinationAuthority { readonly egressBindingId: string }
type Send = (value: unknown) => void;

const role = required("PROCESS_ROUTE_ROLE");
const send: Send = (value) => process.send?.(value);
let stopping = false;
let stopRole: (() => Promise<void>) | undefined;

process.on("message", (message: unknown) => {
  if (!isRecord(message) || typeof message.id !== "number" || typeof message.command !== "string") return;
  void handle(message as Command).then(
    (result) => send({ id: message.id, ok: true, result }),
    (error: unknown) => send({ id: message.id, ok: false, error: safeError(error) }),
  );
});
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

let commandHandler: (command: Command) => Promise<unknown>;

if (role === "fixture") await startFixture();
else if (role === "proxy") await startProxy();
else if (role === "browserd") await startBrowserd();
else if (role === "webxd") await startWebxd();
else throw new Error(`unknown process route role: ${role}`);

async function handle(command: Command): Promise<unknown> {
  if (command.command === "stop") { await stop(); return { stopped: true }; }
  return await commandHandler(command);
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stopRole?.();
}

async function startFixture(): Promise<void> {
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/download") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=forbidden.bin", "content-length": "18", "cache-control": "no-store" });
      response.end("forbidden-download");
      return;
    }
    const label = url.pathname.includes("beta") ? "beta" : url.pathname.includes("second") ? "alpha-second" : "alpha";
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(page(label));
  });
  await listenHttp(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind");
  stopRole = async () => await closeHttp(server);
  commandHandler = async () => ({ origin: `http://127.0.0.1:${address.port}` });
  send({ kind: "ready", role, origin: `http://127.0.0.1:${address.port}` });
}

async function startProxy(): Promise<void> {
  let server: NetServer | undefined;
  let port = 0;
  const listen = async (): Promise<void> => {
    const next = createNetServer((socket) => {
      let request = "";
      socket.setTimeout(1_000, () => socket.destroy());
      socket.on("data", (chunk) => {
        request += chunk.toString("latin1");
        if (request.length > 4_096) { socket.destroy(); return; }
        if (!request.includes("\r\n\r\n")) return;
        if (request.startsWith("GET http://webx-egress.invalid/.well-known/webx-egress-health HTTP/1.1\r\n")) {
          socket.end("HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n");
        } else socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      });
    });
    await listenNet(next, port);
    const address = next.address();
    if (address === null || typeof address === "string") throw new Error("proxy did not bind");
    port = address.port;
    server = next;
  };
  await listen();
  stopRole = async () => { if (server !== undefined) { const current = server; server = undefined; await closeNet(current); } };
  commandHandler = async (command) => {
    if (command.command !== "set-health") throw new Error(`unsupported proxy command: ${command.command}`);
    const healthy = command.healthy === true;
    if (!healthy && server !== undefined) { const current = server; server = undefined; await closeNet(current); }
    if (healthy && server === undefined) await listen();
    return { healthy, port };
  };
  send({ kind: "ready", role, host: "127.0.0.1", port });
}

async function startBrowserd(): Promise<void> {
  const runtimeDirectory = required("PROCESS_ROUTE_BROWSERD_DIR");
  const profileRoot = required("PROCESS_ROUTE_PROFILE_ROOT");
  const origin = required("PROCESS_ROUTE_ORIGIN");
  const proxyPort = integer(required("PROCESS_ROUTE_PROXY_PORT"));
  const chromeExecutable = process.env.BROWSERD_CHROME_BIN ?? "/usr/bin/chromium-browser";
  const egressBindingId = `forward-proxy://127.0.0.1:${proxyPort}`;
  const runtime = new BrowserRuntime({
    navigationAuthorization: new LoopbackFixtureAuthorization(new Set([origin])),
    chrome: { executable: chromeExecutable, profileRoot, windowSize: { width: 900, height: 700 } },
    personaSeedForTest: integer(process.env.PROCESS_ROUTE_PERSONA_SEED ?? "4096"),
    screenshotObservationTtlMs: 60_000,
    domObservationTtlMs: 60_000,
    egressConfigured: true,
    egressBindingId,
  });
  const actionTimings: unknown[] = [];
  const dispatchTimings: Array<{ kind: string; durationMs: number }> = [];
  const attachedSessions = new Set<string>();
  const originalDispatch = runtime.dispatch.bind(runtime);
  (runtime as unknown as { dispatch: typeof originalDispatch }).dispatch = async (...args: Parameters<typeof originalDispatch>) => {
    const started = performance.now();
    try { return await originalDispatch(...args); }
    finally {
      dispatchTimings.push({ kind: args[1].kind, durationMs: performance.now() - started });
      if (dispatchTimings.length > 50_000) dispatchTimings.splice(0, dispatchTimings.length - 50_000);
      attachMotorListeners(runtime, attachedSessions, actionTimings);
    }
  };
  const server = new BrowserdServer({ runtimeDirectory, runtime });
  const descriptor = await server.start();
  stopRole = async () => await server.stop();
  commandHandler = async (command) => {
    if (command.command !== "metrics") throw new Error(`unsupported browserd command: ${command.command}`);
    const sessions = runtimeSessions(runtime);
    const captureCoordinators = sessions.map((session) => ({ browserSessionId: session.browserSessionId, ...session.captureCoordinator.diagnostics }));
    return {
      pid: process.pid,
      heapUsedBytes: process.memoryUsage().heapUsed,
      runtimeInstanceId: descriptor.runtimeInstanceId,
      connections: browserdConnectionCount(server),
      sessions: sessions.length,
      tabs: sessions.reduce((count, session) => count + session.listTabs().length, 0),
      subscriptions: runtime.subscriptionCount,
      operations: runtime.operations.size,
      artifacts: runtime.artifacts.entryCount,
      artifactBytes: runtime.artifacts.totalBytes,
      heldInput: sessions.map((session) => ({ browserSessionId: session.browserSessionId, ...session.motor.heldInputState })),
      chrome: sessions.map((session) => ({ pid: session.host.pid, running: session.host.running, connected: session.host.connected, cdpPendingCount: session.host.cdp.pendingCount, deniedDownloads: session.host.deniedDownloads, profileDirectory: session.host.profileDirectory })),
      droppedFrames: sessions.reduce((count, session) => count + session.frames.droppedFrames, 0),
      captureCoordinators,
      captureCoordinator: aggregateCaptureDiagnostics(captureCoordinators),
      actionTimings: [...actionTimings],
      dispatchTimings: [...dispatchTimings],
    };
  };
  send({ kind: "ready", role, runtimeInstanceId: descriptor.runtimeInstanceId, pid: process.pid, socketPath: descriptor.socketPath });
}

async function startWebxd(): Promise<void> {
  const runtimeDirectory = required("XDG_RUNTIME_DIR");
  const socketPath = required("PROCESS_ROUTE_WEBXD_SOCKET");
  const browserdDirectory = required("PROCESS_ROUTE_BROWSERD_DIR");
  const origin = required("PROCESS_ROUTE_ORIGIN");
  const proxyPort = integer(required("PROCESS_ROUTE_PROXY_PORT"));
  const proxy = new ProxyBoundBrowserDestinationAuthority("127.0.0.1", proxyPort);
  const authority: TestAuthority = {
    egressBindingId: proxy.egressBindingId,
    assertReady: async (signal) => await proxy.assertReady(signal),
    authorize: async (request: BrowserDestinationRequest, signal?: AbortSignal) => {
      const url = new URL(request.url);
      if (url.origin !== origin) throw new Error("test-only process authority refused a foreign origin");
      await proxy.assertReady(signal);
      return { mode: "egress-bound", normalizedUrl: url.href, asciiHostname: url.hostname, port: Number(url.port), resolvedAddresses: ["127.0.0.1"], redirectPolicy: { revalidateEveryHop: true, maxRedirects: 0 }, egressBindingId: proxy.egressBindingId };
    },
  };
  const runtime = new WebxdRuntime({
    socketPath,
    browserSocketPath: join(runtimeDirectory, "unused-legacy.sock"),
    browserBackend: "agentcursor",
    browserDescriptorPath: join(browserdDirectory, "browserd.json"),
    browserRuntimeDirectory: browserdDirectory,
    browserDestinationAuthority: authority,
    cwd: "/deterministic/phase2b-process",
    authenticateActor: sameUserPiActorAuthenticator,
    dropResponseForIdempotencyKeyForTest: process.env.PROCESS_ROUTE_DROP_RESPONSE_KEY,
  });
  await runtime.start();
  const streamPool = new BrowserdClientPool({ descriptorPath: join(browserdDirectory, "browserd.json"), runtimeDirectory: browserdDirectory, idleTimeoutMs: 1_000 });
  let subscription: BrowserdFrameSubscription | undefined;
  let frameCount = 0;
  let latestFrame: unknown;
  let duplicateFrameSequences = 0;
  let nonMonotonicFrameSequences = 0;
  let lastFrameSequence = 0;
  const frameSequences = new Set<number>();
  stopRole = async () => { await subscription?.close().catch(() => undefined); await streamPool.close(); await runtime.stop(); };
  commandHandler = async (command) => {
    if (command.command === "metrics") {
      await streamPool.request(systemActor(), `process-health-${Date.now()}`, { kind: "capabilities.get" }).catch(() => undefined);
      return { pid: process.pid, heapUsedBytes: process.memoryUsage().heapUsed, ...runtime.diagnostics, stream: { connectionCount: streamPool.connectionCount, active: subscription !== undefined, frameCount, duplicateFrameSequences, nonMonotonicFrameSequences, uniqueFrameSequences: frameSequences.size, lastFrameSequence, latestFrame } };
    }
    if (command.command === "subscribe") {
      if (subscription !== undefined) throw new Error("process frame subscription already exists");
      const ownerId = text(command.ownerId, "ownerId");
      const sessionId = text(command.browserSessionId, "browserSessionId");
      const tabId = text(command.tabId, "tabId");
      const actor = sameUserPiActorAuthenticator({ principalId: ownerId, agentId: ownerId });
      const listed = asRecord(await streamPool.request(actor, `process-list-${Date.now()}`, { kind: "session.list" }));
      const sessions = Array.isArray(listed.sessions) ? listed.sessions.map(asRecord) : [];
      const session = sessions.find((item) => item.browserSessionId === sessionId);
      if (session === undefined || !Array.isArray(session.tabs)) throw new Error("process stream session was not found");
      const tab = session.tabs.map(asRecord).find((item) => asRecord(item.address).tabId === tabId);
      if (tab === undefined) throw new Error("process stream tab was not found");
      const address = asRecord(tab.address) as unknown as import("../../../packages/browser-protocol/src/index.js").TabAddress;
      subscription = await streamPool.subscribeFrames(actor, `process-subscribe-${Date.now()}`, address, (event) => {
        frameCount += 1;
        if (frameSequences.has(event.frameSequence)) duplicateFrameSequences += 1;
        if (event.frameSequence <= lastFrameSequence) nonMonotonicFrameSequences += 1;
        frameSequences.add(event.frameSequence);
        if (frameSequences.size > 50_000) frameSequences.delete(frameSequences.values().next().value as number);
        lastFrameSequence = event.frameSequence;
        latestFrame = event;
      });
      return { subscriptionId: subscription.subscriptionId };
    }
    if (command.command === "unsubscribe") {
      await subscription?.close();
      subscription = undefined;
      return { active: false, frameCount };
    }
    throw new Error(`unsupported webxd command: ${command.command}`);
  };
  send({ kind: "ready", role, pid: process.pid, socketPath });
}

function attachMotorListeners(runtime: BrowserRuntime, attached: Set<string>, timings: unknown[]): void {
  for (const session of runtimeSessions(runtime)) {
    if (attached.has(session.browserSessionId)) continue;
    attached.add(session.browserSessionId);
    session.motor.on("actionEnd", (event: unknown) => {
      const record = isRecord(event) ? event : undefined;
      const item = record !== undefined && isRecord(record.timings) ? record.timings : undefined;
      if (item !== undefined) { timings.push({ browserSessionId: session.browserSessionId, tabId: record?.tabId, recordedMonotonicMs: performance.now(), ...item }); if (timings.length > 20_000) timings.splice(0, timings.length - 20_000); }
    });
  }
}

function aggregateCaptureDiagnostics(items: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const sum = (name: string): number => items.reduce((total, item) => total + (typeof item[name] === "number" ? item[name] as number : 0), 0);
  const maximum = (name: string): number => Math.max(0, ...items.map((item) => typeof item[name] === "number" ? item[name] as number : 0));
  const timing = (name: string): Record<string, unknown> => {
    const values = items.map((item) => isRecord(item[name]) ? item[name] as Record<string, unknown> : {});
    const minima = values.filter((value) => typeof value.retainedCount === "number" && value.retainedCount > 0 && typeof value.min === "number").map((value) => value.min as number);
    return {
      count: values.reduce((total, value) => total + (typeof value.count === "number" ? value.count : 0), 0),
      retainedCount: values.reduce((total, value) => total + (typeof value.retainedCount === "number" ? value.retainedCount : 0), 0),
      min: minima.length === 0 ? 0 : Math.min(...minima),
      medianUpperBound: maximumTiming(values, "median"),
      p95UpperBound: maximumTiming(values, "p95"),
      max: maximumTiming(values, "max"),
      meanUpperBound: maximumTiming(values, "mean"),
    };
  };
  return {
    sessionCount: items.length,
    sameSessionMaximumConcurrency: maximum("maxObservedConcurrent"),
    processActiveTransactions: maximum("processActiveTransactions"),
    processMaximumConcurrency: maximum("processMaxObservedConcurrent"),
    agentRequests: sum("agentRequests"),
    workspaceRequests: sum("frameRequests"),
    agentScreenshotAttempts: sum("agentScreenshotAttempts"),
    workspaceScreenshotAttempts: sum("frameScreenshotAttempts"),
    agentScreenshotRetries: sum("agentScreenshotRetries"),
    typedTimeouts: sum("agentScreenshotTimeouts") + sum("frameScreenshotTimeouts"),
    agentTypedTimeouts: sum("agentScreenshotTimeouts"),
    workspaceTypedTimeouts: sum("frameScreenshotTimeouts"),
    recoveredAgentTimeouts: sum("recoveredAgentScreenshotTimeouts"),
    unrecoveredAgentTimeouts: sum("unrecoveredAgentScreenshotTimeouts"),
    unrecoveredAgentFailures: sum("failedAgent"),
    droppedWorkspaceRequests: sum("droppedFrame"),
    coalescedWorkspaceRequests: sum("coalescedFrame"),
    maximumAgentQueueDepth: maximum("maxObservedAgentQueue"),
    maximumWorkspaceQueueDepth: maximum("maxObservedFrameQueue"),
    agentQueueWaitMs: timing("agentQueueWaitMs"),
    workspaceQueueWaitMs: timing("frameQueueWaitMs"),
    agentTransactionMs: timing("agentTransactionMs"),
    workspaceTransactionMs: timing("frameTransactionMs"),
  };
}
function maximumTiming(values: ReadonlyArray<Record<string, unknown>>, name: string): number { return Math.max(0, ...values.map((value) => typeof value[name] === "number" ? value[name] as number : 0)); }
function runtimeSessions(runtime: BrowserRuntime): BrowserSession[] { return [...(runtime as unknown as { sessions: Map<string, BrowserSession> }).sessions.values()]; }
function browserdConnectionCount(server: BrowserdServer): number { return (server as unknown as { connections: Set<unknown> }).connections.size; }
function systemActor() { return sameUserPiActorAuthenticator({ principalId: "process-system", agentId: "process-system" }); }
function page(label: string): string { return `<!doctype html><html><head><title>${label}</title><style>body{margin:0;width:1600px;height:1200px;background:${label === "beta" ? "#fee" : label === "alpha-second" ? "#efe" : "#eef"};font:20px sans-serif}button,input,a{position:absolute;left:80px;width:220px;height:52px;font-size:18px}button{top:100px}input{top:180px}a{top:270px}</style></head><body><h1>${label}</h1><button>${label} count 0</button><input aria-label="${label} text"><a href="/download" download>forbidden download</a><script>let n=0;document.querySelector('button').onclick=e=>e.target.textContent='${label} count '+(++n)</script></body></html>`; }
function required(name: string): string { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
function integer(value: string): number { const parsed = Number(value); if (!Number.isInteger(parsed)) throw new Error(`expected integer: ${value}`); return parsed; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || value === "") throw new Error(`${name} is required`); return value; }
function asRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error("expected object"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeError(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1_000) : String(error).slice(0, 1_000); }
function listenHttp(server: HttpServer, port: number): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
function closeHttp(server: HttpServer): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function listenNet(server: NetServer, port: number): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
function closeNet(server: NetServer): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

void readdir;
