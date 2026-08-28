import { randomBytes } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import process, { pid } from "node:process";
import type { TransportRequest, TransportResponse } from "../../../packages/sdk/src/index.js";
import { WebxAuthority } from "./authority.js";
import { BrowserDaemonRpcPort, type BrowserRpcConnection, type BrowserRpcConnectionFactory } from "./browser-daemon-port.js";
import type { BrowserDestinationAuthority } from "./destination-authority.js";
import { PUBLIC_SOURCES } from "./fixtures.js";
import type { AuthorityActor, IndexedSource } from "./ports.js";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 4_194_304;
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const AUTHORITY_SCOPES = new Set(["system.read", "search.write", "retrieval.read", "artifacts.read", "browser.read", "browser.write", "browser.control", "browser.debug"]);

export interface WebxActorAuthenticator {
  authenticate(identity: { readonly principalId: string; readonly agentId: string }): AuthorityActor;
}

interface RuntimeWireRequest {
  readonly binding: { readonly bindingId: string; readonly bindingSecret: string };
  readonly request: TransportRequest;
}
interface ActorBinding { readonly secret: string; readonly actor: AuthorityActor }

export interface WebxdRuntimeOptions {
  readonly socketPath: string;
  readonly browserSocketPath: string;
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
}

/** Runnable same-user Unix API for the complete local WebX authority. */
export class WebxdRuntime {
  readonly #browser: BrowserDaemonRpcPort;
  readonly #authority: WebxAuthority;
  readonly #clients = new Set<Socket>();
  readonly #bindings = new Map<string, ActorBinding>();
  #server?: Server;
  #started = false;

  constructor(private readonly options: WebxdRuntimeOptions) {
    this.#browser = new BrowserDaemonRpcPort(
      options.browserConnectionFactory ?? createBrowserRpcConnectionFactory(options.browserSocketPath, options.cwd ?? "."),
      options.browserDestinationAuthority,
    );
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

  async start(): Promise<void> {
    if (this.#started) return;
    assertSameUserRuntimeDirectory(this.options.socketPath);
    await prepareSocket(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.options.socketPath, resolve);
    });
    await chmod(this.options.socketPath, 0o600);
    this.#server = server;
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const client of this.#clients) client.destroy();
    this.#clients.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) await closeServer(server);
    this.#bindings.clear();
    await this.#browser.shutdown();
    await unlink(this.options.socketPath).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }

  private accept(socket: Socket): void {
    this.#clients.add(socket);
    let buffer = "";
    let chain = Promise.resolve();
    const controllers = new Set<AbortController>();
    socket.on("data", (chunk) => {
      buffer += new TextDecoder().decode(chunk, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_REQUEST_BYTES) {
        socket.write(`${JSON.stringify(failure(413, "request-too-large", "Unix request exceeds the runtime bound"))}\n`);
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        chain = chain.then(async () => {
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const parsed = JSON.parse(line) as unknown;
            if (isBindRequest(parsed)) {
              const binding = this.issueBinding(parsed.bind.ownerId);
              socket.write(`${JSON.stringify(binding)}\n`);
              return;
            }
            const wire = parseWireRequest(parsed);
            const response = await this.#authority.handle(this.authenticate(wire), { ...wire.request, signal: controller.signal });
            socket.write(`${JSON.stringify(response)}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify(failure(400, "invalid-wire-request", safeError(error)))}\n`);
          } finally {
            controllers.delete(controller);
          }
        });
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#clients.delete(socket);
      for (const controller of controllers) controller.abort();
    });
  }

  private issueBinding(ownerId: string): { bindingId: string; bindingSecret: string } {
    if (!ACTOR_ID.test(ownerId)) throw new TypeError("binding ownerId is invalid");
    const authenticate = this.options.authenticateActor;
    if (authenticate === undefined) throw new Error("same-user Pi actor authenticator is not configured");
    const bindingId = randomBytes(16).toString("hex");
    const bindingSecret = randomBytes(32).toString("hex");
    this.#bindings.set(bindingId, { secret: bindingSecret, actor: authenticate({ principalId: ownerId, agentId: ownerId }) });
    return { bindingId, bindingSecret };
  }

  private authenticate(wire: RuntimeWireRequest): AuthorityActor {
    const binding = this.#bindings.get(wire.binding.bindingId);
    if (binding === undefined || !constantTimeEqual(binding.secret, wire.binding.bindingSecret)) throw new Error("runtime actor binding is invalid");
    return binding.actor;
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
  #buffer = "";
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
      this.#buffer = "";
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
    this.#buffer += new TextDecoder().decode(chunk, { stream: true });
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_RESPONSE_BYTES) {
      this.#socket?.destroy();
      this.rejectPending(new Error("browser daemon response exceeds the runtime bound"));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
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
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
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
function closeServer(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"; }
