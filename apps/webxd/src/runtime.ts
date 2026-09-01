import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import process, { pid } from "node:process";
import type { TransportRequest, TransportResponse } from "../../../packages/sdk/src/index.js";
import { WebxAuthority } from "./authority.js";
import { AgentCursorBrowserPort } from "./agentcursor-browser-port.js";
import { BrowserDaemonRpcPort, type BrowserRpcConnection, type BrowserRpcConnectionFactory } from "./browser-daemon-port.js";
import { BrowserdClientPool } from "./browserd-client.js";
import type { BrowserBackendSelection } from "./browser-backend-selection.js";
import { FailClosedBrowserDestinationAuthority, type BrowserDestinationAuthority } from "./destination-authority.js";
import { PUBLIC_SOURCES } from "./fixtures.js";
import type { AuthorityActor, IndexedSource } from "./ports.js";
import { WorkspaceGateway } from "./workspace/gateway.js";

const MAX_REQUEST_BYTES = 1_048_576;
// A complete 4 MiB image expands to about 5.34 MiB as base64 inside the JSON response.
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const AUTHORITY_SCOPES = new Set(["system.read", "search.write", "retrieval.read", "artifacts.read", "browser.read", "browser.write", "browser.control", "browser.debug"]);

export interface WebxActorAuthenticator {
  authenticate(identity: { readonly principalId: string; readonly agentId: string }): AuthorityActor;
}

interface RuntimeWireRequest {
  readonly binding: { readonly bindingId: string; readonly bindingSecret: string };
  readonly request: TransportRequest;
}
interface ActorBinding { readonly secret: string; readonly actor: AuthorityActor; readonly client: Socket }

export interface WebxdRuntimeOptions {
  readonly socketPath: string;
  readonly browserSocketPath: string;
  readonly browserBackend?: BrowserBackendSelection;
  readonly browserDescriptorPath?: string;
  readonly browserRuntimeDirectory?: string;
  readonly workspaceRuntimeDirectory?: string;
  readonly cwd?: string;
  readonly sources?: readonly IndexedSource[];
  readonly browserConnectionFactory?: BrowserRpcConnectionFactory;
  readonly browserDestinationAuthority?: BrowserDestinationAuthority;
  readonly searxUrl?: string;
  readonly readerUrl?: string;
  readonly crawlUrl?: string;
  readonly cacheDirectory?: string;
  readonly contentDirectory?: string;
  readonly authenticateActor?: WebxActorAuthenticator["authenticate"];
  readonly maxClientConnections?: number;
  readonly bindTimeoutMs?: number;
  readonly maxLiveBindings?: number;
  readonly maxQueuedRequestsPerClient?: number;
  readonly maxOutboundBytesPerClient?: number;
  /** Test-only fault injection. Production entry points never set this option. */
  readonly dropResponseForIdempotencyKeyForTest?: string;
  /** Test-only cleanup fault injection. Production entry points never set this option. */
  readonly cleanupStageForTest?: (stage: WebxdCleanupStage, attempt: number) => void | Promise<void>;
}

export type WebxdCleanupStage = "clients" | "server" | "bindings" | "workspace" | "browser" | "socket";
type SocketIdentity = { readonly dev: number; readonly ino: number };
type CleanupState = Record<WebxdCleanupStage, boolean>;

/** Runnable same-user Unix API for the complete local WebX authority. */
export class WebxdRuntime {
  readonly #browser: import("./ports.js").BrowserDaemonPort;
  readonly #authority: WebxAuthority;
  readonly #workspace?: WorkspaceGateway;
  readonly #clients = new Set<Socket>();
  readonly #bindings = new Map<string, ActorBinding>();
  readonly #controllers = new Set<AbortController>();
  readonly #requestTasks = new Set<Promise<void>>();
  readonly #maxClientConnections: number;
  readonly #bindTimeoutMs: number;
  readonly #maxLiveBindings: number;
  readonly #maxQueuedRequestsPerClient: number;
  readonly #maxOutboundBytesPerClient: number;
  #server?: Server;
  #started = false;
  #everStopped = false;
  #stopState: "open" | "stopping" | "stopped" | "cleanup-failed" = "open";
  #stopPromise?: Promise<void>;
  #stopAttempt = 0;
  #socketIdentity?: SocketIdentity;
  readonly #socketOwnerId = randomBytes(32).toString("base64url");
  #cleanupState: CleanupState = { clients: false, server: false, bindings: false, workspace: false, browser: false, socket: false };
  #testResponseDropped = false;

  constructor(private readonly options: WebxdRuntimeOptions) {
    this.#maxClientConnections = boundedInteger(options.maxClientConnections ?? 64, 1, 1024, "client connection");
    this.#bindTimeoutMs = boundedInteger(options.bindTimeoutMs ?? 5_000, 10, 60_000, "bind timeout");
    this.#maxLiveBindings = boundedInteger(options.maxLiveBindings ?? 64, 1, 1024, "live binding");
    this.#maxQueuedRequestsPerClient = boundedInteger(options.maxQueuedRequestsPerClient ?? 64, 1, 1024, "queued request");
    this.#maxOutboundBytesPerClient = boundedInteger(options.maxOutboundBytesPerClient ?? 12 * 1024 * 1024, MAX_RESPONSE_BYTES, 32 * 1024 * 1024, "outbound byte");
    const backend = options.browserBackend ?? "legacy";
    if (backend === "legacy") {
      this.#browser = new BrowserDaemonRpcPort(
        options.browserConnectionFactory ?? createBrowserRpcConnectionFactory(options.browserSocketPath, options.cwd ?? "."),
        options.browserDestinationAuthority,
      );
    } else {
      if (options.browserConnectionFactory !== undefined) throw new Error("legacy browser connection factory cannot be used with the agentcursor backend");
      if (options.browserDescriptorPath === undefined || options.browserRuntimeDirectory === undefined) throw new Error("agentcursor backend requires the browserd descriptor and runtime directory");
      this.#browser = new AgentCursorBrowserPort(new BrowserdClientPool({ descriptorPath: options.browserDescriptorPath, runtimeDirectory: options.browserRuntimeDirectory }), options.browserDestinationAuthority ?? new FailClosedBrowserDestinationAuthority());
    }
    if (options.workspaceRuntimeDirectory !== undefined) {
      this.#workspace = new WorkspaceGateway({
        runtimeDirectory: options.workspaceRuntimeDirectory,
        browserBackend: backend,
        ...(backend === "agentcursor" ? { browserDescriptorPath: options.browserDescriptorPath, browserRuntimeDirectory: options.browserRuntimeDirectory } : {}),
      });
    }
    this.#authority = new WebxAuthority({
      browser: this.#browser,
      sources: options.sources ?? PUBLIC_SOURCES,
      clock: { now: () => new Date().toISOString() },
      ids: { next: (prefix) => `${prefix}-${Date.now().toString(36)}` },
      searxUrl: options.searxUrl,
      readerUrl: options.readerUrl,
      crawlUrl: options.crawlUrl,
      cacheDirectory: options.cacheDirectory,
      contentDirectory: options.contentDirectory,
    });
  }

  get diagnostics(): {
    readonly clientConnections: number;
    readonly liveBindings: number;
    readonly idempotency: WebxAuthority["idempotencyStats"];
    readonly browser?: AgentCursorBrowserPort["diagnostics"];
    readonly workspace?: WorkspaceGateway["diagnostics"];
    readonly testResponseDropped: boolean;
  } {
    return {
      clientConnections: this.#clients.size,
      liveBindings: this.#bindings.size,
      idempotency: this.#authority.idempotencyStats,
      ...(this.#browser instanceof AgentCursorBrowserPort ? { browser: this.#browser.diagnostics } : {}),
      ...(this.#workspace === undefined ? {} : { workspace: this.#workspace.diagnostics }),
      testResponseDropped: this.#testResponseDropped,
    };
  }

  async start(): Promise<void> {
    if (this.#everStopped) throw new Error("A stopped WebX runtime object cannot restart");
    if (this.#started) return;
    assertSameUserRuntimeDirectory(this.options.socketPath);
    await prepareSocket(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.options.socketPath, resolve);
    });
    await chmod(this.options.socketPath, 0o600);
    const info = await lstat(this.options.socketPath);
    if (!info.isSocket()) throw new Error("WebX endpoint is not a Unix socket");
    this.#socketIdentity = { dev: info.dev, ino: info.ino };
    this.#cleanupState = { clients: false, server: false, bindings: false, workspace: false, browser: false, socket: false };
    this.#server = server;
    try {
      await publishSocketOwner(this.options.socketPath, this.#socketOwnerId);
      await this.#workspace?.start();
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      this.#server = undefined;
      await unlinkOwnedSocket(this.options.socketPath, this.#socketIdentity, this.#socketOwnerId).catch(() => undefined);
      this.#socketIdentity = undefined;
      throw error;
    }
    this.#started = true;
  }

  async stop(): Promise<void> {
    this.#everStopped = true;
    this.#started = false;
    if (this.#stopState === "stopped") return;
    if (this.#stopPromise !== undefined) return await this.#stopPromise;
    this.#stopState = "stopping";
    const promise = this.stopInternal();
    this.#stopPromise = promise;
    try { await promise; this.#stopState = "stopped"; }
    catch (error) { this.#stopState = "cleanup-failed"; throw error; }
    finally { if (this.#stopPromise === promise) this.#stopPromise = undefined; }
  }

  private async stopInternal(): Promise<void> {
    const attempt = ++this.#stopAttempt;
    const failures: unknown[] = [];
    await this.cleanupStage("clients", attempt, async () => {
      const clients = [...this.#clients];
      const closed = clients.map(async (client) => {
        if (client.destroyed) return;
        await new Promise<void>((resolve) => { client.once("close", resolve); client.destroy(); });
      });
      for (const controller of this.#controllers) controller.abort(new Error("WebX runtime is stopping"));
      await Promise.all(closed);
      await Promise.allSettled([...this.#requestTasks]);
      this.#clients.clear();
      this.#controllers.clear();
      this.#requestTasks.clear();
    }, failures);
    await this.cleanupStage("server", attempt, async () => {
      const server = this.#server;
      if (server !== undefined) await closeServer(server);
      this.#server = undefined;
    }, failures);
    await this.cleanupStage("bindings", attempt, async () => { this.#bindings.clear(); }, failures);
    await this.cleanupStage("workspace", attempt, async () => { await this.#workspace?.stop(); }, failures);
    await this.cleanupStage("browser", attempt, async () => { await this.#browser.shutdown(); }, failures);
    await this.cleanupStage("socket", attempt, async () => { await unlinkOwnedSocket(this.options.socketPath, this.#socketIdentity, this.#socketOwnerId); }, failures);
    if (failures.length > 0) throw new AggregateError(failures, "WebX runtime shutdown cleanup failed.");
  }

  private async cleanupStage(stage: WebxdCleanupStage, attempt: number, action: () => Promise<void>, failures: unknown[]): Promise<void> {
    if (this.#cleanupState[stage]) return;
    try {
      await this.options.cleanupStageForTest?.(stage, attempt);
      await action();
      this.#cleanupState[stage] = true;
    } catch (error) { failures.push(error); }
  }

  private accept(socket: Socket): void {
    if (this.#clients.size >= this.#maxClientConnections) { socket.end(`${JSON.stringify(failure(503, "connection-capacity", "WebX client connection capacity is full"))}\n`); return; }
    this.#clients.add(socket);
    const decoder = new BoundedNdjsonDecoder(MAX_REQUEST_BYTES);
    let chain = Promise.resolve();
    let queuedRequests = 0;
    let outboundBytes = 0;
    let bindingId: string | undefined;
    let closed = false;
    const controllers = new Set<AbortController>();
    const writeResponse = (value: unknown): boolean => {
      if (closed || socket.destroyed) return false;
      const encoded = `${JSON.stringify(value)}\n`;
      const bytes = Buffer.byteLength(encoded, "utf8");
      if (bytes > MAX_RESPONSE_BYTES || outboundBytes + bytes > this.#maxOutboundBytesPerClient) { socket.destroy(); return false; }
      outboundBytes += bytes;
      socket.write(encoded, () => { outboundBytes = Math.max(0, outboundBytes - bytes); });
      return true;
    };
    const bindTimer = setTimeout(() => { if (bindingId === undefined) { writeResponse(failure(408, "binding-timeout", "WebX client did not bind in time")); socket.destroy(); } }, this.#bindTimeoutMs);
    bindTimer.unref?.();
    socket.on("data", (chunk) => {
      let lines: readonly string[];
      try { lines = decoder.push(chunk); }
      catch { writeResponse(failure(413, "request-too-large", "Unix request is invalid or exceeds the runtime bound")); socket.destroy(); return; }
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        if (queuedRequests >= this.#maxQueuedRequestsPerClient) { writeResponse(failure(429, "request-capacity", "WebX client request capacity is full")); socket.destroy(); return; }
        queuedRequests += 1;
        const task = chain.then(async () => {
          if (closed) return;
          const controller = new AbortController();
          controllers.add(controller);
          this.#controllers.add(controller);
          try {
            const parsed = JSON.parse(line) as unknown;
            if (isBindRequest(parsed)) {
              if (bindingId !== undefined) throw new Error("client connection is already bound");
              const binding = this.issueBinding(parsed.bind.ownerId, socket);
              bindingId = binding.bindingId;
              clearTimeout(bindTimer);
              writeResponse(binding);
              return;
            }
            const wire = parseWireRequest(parsed);
            const response = await this.#authority.handle(this.authenticate(wire, socket), { ...wire.request, signal: controller.signal });
            if (this.shouldDropTestResponse(wire.request)) { socket.destroy(); return; }
            writeResponse(response);
          } catch (error) {
            writeResponse(failure(400, "invalid-wire-request", safeError(error)));
          } finally {
            controllers.delete(controller);
            this.#controllers.delete(controller);
          }
        }).finally(() => { queuedRequests -= 1; });
        this.#requestTasks.add(task);
        void task.then(() => this.#requestTasks.delete(task), () => this.#requestTasks.delete(task));
        chain = task;
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (closed) return;
      closed = true;
      clearTimeout(bindTimer);
      this.#clients.delete(socket);
      if (bindingId !== undefined && this.#bindings.get(bindingId)?.client === socket) this.#bindings.delete(bindingId);
      for (const controller of controllers) controller.abort();
      for (const controller of controllers) this.#controllers.delete(controller);
    });
  }

  private issueBinding(ownerId: string, client: Socket): { bindingId: string; bindingSecret: string } {
    if (!ACTOR_ID.test(ownerId)) throw new TypeError("binding ownerId is invalid");
    if (this.#bindings.size >= this.#maxLiveBindings) throw new Error("runtime actor binding capacity is full");
    const authenticate = this.options.authenticateActor;
    if (authenticate === undefined) throw new Error("same-user Pi actor authenticator is not configured");
    const bindingId = randomBytes(16).toString("hex");
    const bindingSecret = randomBytes(32).toString("hex");
    this.#bindings.set(bindingId, { secret: bindingSecret, actor: authenticate({ principalId: ownerId, agentId: ownerId }), client });
    return { bindingId, bindingSecret };
  }

  private authenticate(wire: RuntimeWireRequest, client: Socket): AuthorityActor {
    const binding = this.#bindings.get(wire.binding.bindingId);
    if (binding === undefined || binding.client !== client || !constantTimeEqual(binding.secret, wire.binding.bindingSecret)) throw new Error("runtime actor binding is invalid");
    return binding.actor;
  }

  private shouldDropTestResponse(request: TransportRequest): boolean {
    const key = this.options.dropResponseForIdempotencyKeyForTest;
    if (key === undefined || this.#testResponseDropped) return false;
    const actual = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "idempotency-key")?.[1];
    if (actual !== key) return false;
    this.#testResponseDropped = true;
    return true;
  }
}

export function createBrowserRpcConnectionFactory(browserSocketPath: string, cwd: string): BrowserRpcConnectionFactory {
  return async (actor) => {
    const connection = new PersistentBrowserConnection(browserSocketPath, actor, cwd);
    await connection.ready();
    return connection;
  };
}

class PersistentBrowserConnection implements BrowserRpcConnection {
  #socket?: Socket;
  #decoder?: BoundedNdjsonDecoder;
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #closed = false;
  #connecting?: Promise<void>;
  #heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly socketPath: string, private readonly actor: AuthorityActor, private readonly cwd: string) {}

  ready(): Promise<void> { return this.ensureConnected(); }

  call(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const execute = async () => {
      await this.ensureConnected();
      try {
        return await this.exchange(method, params, signal);
      } catch (error) {
        if (this.#socket === undefined && method !== "agent.register" && method !== "agent.unregister" && !signal?.aborted) {
          await this.ensureConnected();
          return this.exchange(method, params, signal);
        }
        throw error;
      }
    };
    return execute();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#socket !== undefined) await this.call("agent.unregister", {}).catch(() => undefined);
    this.#closed = true;
    this.#socket?.end();
    this.#socket = undefined;
    this.rejectPending(new Error("browser connection closed"));
  }

  private ensureConnected(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("browser connection is closed"));
    if (this.#socket !== undefined) return Promise.resolve();
    this.#connecting ??= this.connectAndRegister().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  private async connectAndRegister(): Promise<void> {
    const socket = createConnection({ path: this.socketPath });
    try {
      await connected(socket);
      this.#socket = socket;
      this.#decoder = new BoundedNdjsonDecoder(MAX_RESPONSE_BYTES);
      socket.on("data", (chunk) => this.receive(chunk));
      socket.on("error", (error) => this.disconnected(socket, error));
      socket.on("close", () => this.disconnected(socket, new Error("browser daemon connection closed")));
      const clientId = `webxd-${this.actor.agentId}`;
      await this.exchange("agent.register", {
        agentId: this.actor.agentId,
        clientId,
        piSessionId: this.actor.principalId,
        cwd: this.cwd,
        pid,
        mode: "rpc",
      });
      this.#heartbeat = setInterval(() => {
        if (this.#socket !== socket) return;
        void this.exchange("agent.heartbeat", { agentId: this.actor.agentId, clientId }).catch(() => undefined);
      }, 2_000);
      (this.#heartbeat as unknown as { unref(): void }).unref();
    } catch (error) {
      if (this.#socket === socket) this.#socket = undefined;
      socket.destroy();
      throw error;
    }
  }

  private exchange(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const socket = this.#socket;
    if (socket === undefined) return Promise.reject(new Error("browser daemon is unavailable"));
    if (signal?.aborted) return Promise.reject(new DOMException("request was cancelled", "AbortError"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const aborted = () => { this.#pending.delete(id); reject(new DOMException("request was cancelled", "AbortError")); };
      signal?.addEventListener("abort", aborted, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", aborted); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", aborted); reject(error); },
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private receive(chunk: Uint8Array): void {
    let lines: readonly string[];
    try { lines = this.#decoder?.push(chunk) ?? []; }
    catch (error) { this.#socket?.destroy(error instanceof Error ? error : undefined); this.rejectPending(new Error("browser daemon returned invalid or oversized UTF-8 NDJSON")); return; }
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const response = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
        if (!Number.isSafeInteger(response.id)) continue;
        const pending = this.#pending.get(response.id as number);
        if (pending === undefined) continue;
        this.#pending.delete(response.id as number);
        if (response.error !== undefined) pending.reject(new Error(`browser RPC ${String(response.error.code)}: ${String(response.error.message)}`));
        else pending.resolve(response.result);
      } catch (error) {
        this.#socket?.destroy(error instanceof Error ? error : undefined);
      }
    }
  }

  private disconnected(socket: Socket, error: Error): void {
    if (this.#socket !== socket) return;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#socket = undefined;
    this.#decoder = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

class BoundedNdjsonDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #frameBytes = 0;
  #expectedContinuations = 0;
  #incompleteBytes = 0;

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Uint8Array): readonly string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.decode(chunk.subarray(start, index));
      if (this.#expectedContinuations !== 0) throw new Error("incomplete UTF-8 frame");
      this.#buffer += this.#decoder.decode();
      lines.push(this.#buffer);
      this.#buffer = "";
      this.#frameBytes = 0;
      this.#expectedContinuations = 0;
      this.#incompleteBytes = 0;
      start = index + 1;
    }
    this.decode(chunk.subarray(start));
    return lines;
  }

  private decode(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#frameBytes += bytes.byteLength;
    if (this.#frameBytes > this.maxFrameBytes) throw new Error("NDJSON frame exceeds bound");
    for (const byte of bytes) {
      if (this.#expectedContinuations > 0) {
        if (byte < 0x80 || byte > 0xbf) throw new Error("invalid UTF-8 continuation");
        this.#expectedContinuations -= 1;
        this.#incompleteBytes += 1;
        if (this.#expectedContinuations === 0) this.#incompleteBytes = 0;
      } else if (byte <= 0x7f) this.#incompleteBytes = 0;
      else if (byte >= 0xc2 && byte <= 0xdf) { this.#expectedContinuations = 1; this.#incompleteBytes = 1; }
      else if (byte >= 0xe0 && byte <= 0xef) { this.#expectedContinuations = 2; this.#incompleteBytes = 1; }
      else if (byte >= 0xf0 && byte <= 0xf4) { this.#expectedContinuations = 3; this.#incompleteBytes = 1; }
      else throw new Error("invalid UTF-8 leading byte");
      if (this.#incompleteBytes > 4) throw new Error("incomplete UTF-8 exceeds bound");
    }
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
  }
}

function parseWireRequest(parsed: unknown): RuntimeWireRequest {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("wire request must be an object");
  const value = parsed as { binding?: unknown; request?: unknown };
  if (typeof value.binding !== "object" || value.binding === null || Array.isArray(value.binding)) throw new TypeError("wire binding is required");
  const binding = value.binding as Record<string, unknown>;
  if (typeof binding.bindingId !== "string" || typeof binding.bindingSecret !== "string") throw new TypeError("wire binding is invalid");
  if (typeof value.request !== "object" || value.request === null || Array.isArray(value.request)) throw new TypeError("transport request is required");
  const request = value.request as TransportRequest;
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") throw new TypeError("transport method is invalid");
  if (typeof request.path !== "string" || !request.path.startsWith("/v1/")) throw new TypeError("transport path is invalid");
  if (!Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 32 || request.maxResponseBytes > MAX_RESPONSE_BYTES) throw new TypeError("transport response bound is invalid");
  return { binding: { bindingId: binding.bindingId, bindingSecret: binding.bindingSecret }, request };
}
function isBindRequest(value: unknown): value is { bind: { ownerId: string } } { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { bind?: unknown }).bind === "object" && (value as { bind: { ownerId?: unknown } }).bind !== null && typeof (value as { bind: { ownerId?: unknown } }).bind.ownerId === "string"; }
function constantTimeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index); return difference === 0; }

function assertSameUserRuntimeDirectory(path: string): void {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory === undefined || (path !== runtimeDirectory && !path.startsWith(`${runtimeDirectory}/`))) throw new Error("WebX socket must be inside XDG_RUNTIME_DIR for same-user authentication");
}
export function sameUserPiActorAuthenticator(identity: { readonly principalId: string; readonly agentId: string }): AuthorityActor {
  return { principalId: identity.principalId, agentId: identity.agentId, scopes: AUTHORITY_SCOPES };
}
function failure(status: number, code: string, message: string): TransportResponse { return { status, headers: { "content-type": "application/json" }, body: { code, message, retryable: false } }; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "invalid Unix request"; }
function connected(socket: Socket): Promise<void> { return new Promise((resolve, reject) => { const failed = (error: Error) => reject(error); socket.once("error", failed); socket.once("connect", () => { socket.off("error", failed); resolve(); }); }); }
async function prepareSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket()) throw new Error(`refusing to replace non-socket path: ${path}`);
    const probe = createConnection({ path });
    try { await connected(probe); probe.end(); throw new Error(`WebX is already listening at ${path}`); }
    catch (error) { probe.destroy(); if (error instanceof Error && error.message.startsWith("WebX is already")) throw error; await unlink(path); }
  } catch (error) { if (!isMissing(error)) throw error; }
}
function closeServer(server: Server): Promise<void> { if (!server.listening) return Promise.resolve(); return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
async function publishSocketOwner(path: string, ownerId: string): Promise<void> {
  const marker = `${path}.owner`;
  const temporary = `${marker}.${pid}.${ownerId}`;
  await writeFile(temporary, `${ownerId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await rename(temporary, marker); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function readSocketOwner(path: string): Promise<string | undefined> {
  try { return (await readFile(`${path}.owner`, "utf8")).trim(); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}
async function unlinkOwnedSocket(path: string, expected: SocketIdentity | undefined, ownerId: string): Promise<void> {
  if (expected === undefined || await readSocketOwner(path) !== ownerId) return;
  const current = await lstat(path).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
  if (current === undefined) {
    if (await readSocketOwner(path) === ownerId) await unlink(`${path}.owner`).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    return;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) return;
  if (!current.isSocket()) throw new Error("Owned WebX endpoint changed type during cleanup");
  if (await readSocketOwner(path) !== ownerId) return;
  await unlink(path).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  if (await readSocketOwner(path) === ownerId) await unlink(`${path}.owner`).catch((error: unknown) => { if (!isMissing(error)) throw error; });
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"; }
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} bound is invalid`); return value; }
