import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ActorIdentity,
  type BrowserRequest,
  type FrameEvent,
  type ServerMessage,
  type TabAddress,
} from "../../../packages/browser-protocol/src/index.js";
import type { AuthorityActor } from "./ports.js";

const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

export interface BrowserdDescriptor {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly runtimeInstanceId: string;
  readonly pid: number;
  readonly processStartTicks: string;
  readonly socketPath: string;
  readonly bindingSecret: string;
  readonly brokerSigningSecret: string;
  readonly workspaceBrokerSecret: string;
  readonly startedAt: string;
}

export type BrowserdRequestFields = BrowserRequest extends infer Request ? Request extends BrowserRequest ? Omit<Request, "protocolVersion" | "requestId" | "operationId" | "deadline"> : never : never;

export interface BrowserdPinnedResult { readonly runtimeInstanceId: string; readonly result: unknown }

export interface BrowserdFrameSubscription {
  readonly subscriptionId: string;
  close(signal?: AbortSignal): Promise<void>;
}

export interface BrowserdClientPoolOptions {
  readonly descriptorPath: string;
  readonly runtimeDirectory: string;
  readonly maxActorConnections?: number;
  readonly maxPendingPerConnection?: number;
  readonly idleTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxOutboundBytesPerConnection?: number;
  readonly maxSubscriptionsPerConnection?: number;
}

export class BrowserdClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly runtimeInstanceId?: string,
  ) { super(message); this.name = "BrowserdClientError"; }
}

interface PoolEntry { readonly connection: BoundBrowserdConnection; lastUsedMs: number }
type SubscriptionState = "open" | "unsubscribing" | "closed" | "cleanup-failed";
interface LocalFrameSubscription {
  readonly addressKey: string;
  readonly listener: (event: FrameEvent) => void;
  pending?: FrameEvent;
  scheduled: boolean;
  state: SubscriptionState;
  closePromise?: Promise<void>;
}

export class BrowserdClientPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #connecting = new Map<string, Promise<PoolEntry>>();
  readonly #maxActorConnections: number;
  readonly #maxPendingPerConnection: number;
  readonly #idleTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxOutboundBytesPerConnection: number;
  readonly #maxSubscriptionsPerConnection: number;
  readonly #runtimeDirectory: string;
  readonly #descriptorPath: string;
  #runtimeInstanceId?: string;
  #closed = false;

  constructor(options: BrowserdClientPoolOptions) {
    this.#runtimeDirectory = resolve(options.runtimeDirectory);
    this.#descriptorPath = resolve(options.descriptorPath);
    this.#maxActorConnections = options.maxActorConnections ?? 64;
    this.#maxPendingPerConnection = options.maxPendingPerConnection ?? 64;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxOutboundBytesPerConnection = options.maxOutboundBytesPerConnection ?? 2 * MAX_REQUEST_BYTES;
    this.#maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection ?? 16;
    if (!Number.isSafeInteger(this.#maxOutboundBytesPerConnection) || this.#maxOutboundBytesPerConnection < MAX_REQUEST_BYTES) throw new Error("browserd outbound byte bound is invalid");
    if (!Number.isSafeInteger(this.#maxSubscriptionsPerConnection) || this.#maxSubscriptionsPerConnection < 1 || this.#maxSubscriptionsPerConnection > 256) throw new Error("browserd subscription bound is invalid");
    if (dirname(this.#descriptorPath) !== this.#runtimeDirectory) throw new Error("browserd descriptor must be inside its expected runtime directory");
  }

  get runtimeInstanceId(): string | undefined { return this.#runtimeInstanceId; }
  get connectionCount(): number { return this.#entries.size; }

  async descriptor(): Promise<BrowserdDescriptor> {
    const descriptor = await readSecureDescriptor(this.#descriptorPath, this.#runtimeDirectory);
    this.acceptRuntime(descriptor.runtimeInstanceId);
    return descriptor;
  }

  async request(actor: AuthorityActor, operationId: string, fields: BrowserdRequestFields, signal?: AbortSignal): Promise<unknown> {
    return (await this.requestPinned(actor, operationId, fields, signal)).result;
  }

  async requestPinned(actor: AuthorityActor, operationId: string, fields: BrowserdRequestFields, signal?: AbortSignal): Promise<BrowserdPinnedResult> {
    return await this.requestWithDescriptor(actor, operationId, async () => fields, signal);
  }

  async requestWithDescriptor(actor: AuthorityActor, operationId: string, fields: (descriptor: BrowserdDescriptor) => Promise<BrowserdRequestFields>, signal?: AbortSignal): Promise<BrowserdPinnedResult> {
    if (this.#closed) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service client is closed", true);
    if (signal?.aborted) throw new DOMException("browser request was cancelled", "AbortError");
    this.pruneIdle();
    const descriptor = await readSecureDescriptor(this.#descriptorPath, this.#runtimeDirectory);
    this.acceptRuntime(descriptor.runtimeInstanceId);
    const entry = await this.connection(actor, descriptor);
    const requestFields = await fields(descriptor);
    if (signal?.aborted) throw new DOMException("browser request was cancelled", "AbortError");
    entry.lastUsedMs = Date.now();
    const request = this.makeRequest(operationId, requestFields);
    try { return { runtimeInstanceId: entry.connection.runtimeInstanceId, result: await entry.connection.call(request, signal) }; }
    finally { entry.lastUsedMs = Date.now(); }
  }

  async subscribeFrames(
    actor: AuthorityActor,
    operationId: string,
    address: TabAddress,
    listener: (event: FrameEvent) => void,
    signal?: AbortSignal,
  ): Promise<BrowserdFrameSubscription> {
    if (this.#closed) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service client is closed", true);
    this.pruneIdle();
    const descriptor = await readSecureDescriptor(this.#descriptorPath, this.#runtimeDirectory);
    this.acceptRuntime(descriptor.runtimeInstanceId);
    const entry = await this.connection(actor, descriptor);
    entry.lastUsedMs = Date.now();
    const subscriptionId = nextOpaqueId();
    entry.connection.registerSubscription(subscriptionId, frameAddressKey(address), listener);
    try {
      await entry.connection.call(this.makeRequest(operationId, { kind: "frames.subscribe", address, subscriptionId }), signal);
    } catch (error) {
      entry.connection.failSubscriptionTeardown(subscriptionId);
      await entry.connection.close(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "frame subscription could not be confirmed; actor connection was closed", true, entry.connection.runtimeInstanceId));
      throw error;
    } finally {
      entry.lastUsedMs = Date.now();
    }
    let state: SubscriptionState = "open";
    let closePromise: Promise<void> | undefined;
    return {
      subscriptionId,
      close: (closeSignal) => {
        if (state === "closed") return Promise.resolve();
        if (closePromise !== undefined) return closePromise;
        state = "unsubscribing";
        entry.connection.beginSubscriptionTeardown(subscriptionId);
        closePromise = (async () => {
          if (entry.connection.closed) { state = "closed"; return; }
          try {
            await entry.connection.call(this.makeRequest(nextId("unsubscribeOperation"), { kind: "frames.unsubscribe", address, subscriptionId }), closeSignal);
            entry.connection.removeSubscription(subscriptionId);
            state = "closed";
          } catch (error) {
            state = "cleanup-failed";
            entry.connection.failSubscriptionTeardown(subscriptionId);
            await entry.connection.close(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "frame unsubscribe could not be confirmed; actor connection was closed", true, entry.connection.runtimeInstanceId));
            throw error;
          } finally {
            entry.lastUsedMs = Date.now();
          }
        })();
        return closePromise;
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    const connecting = [...this.#connecting.values()];
    this.#entries.clear();
    this.#connecting.clear();
    const opening = await Promise.allSettled(connecting);
    for (const result of opening) if (result.status === "fulfilled") entries.push(result.value);
    await Promise.allSettled(entries.map(async ({ connection }) => await connection.close()));
  }

  private makeRequest(operationId: string, fields: BrowserdRequestFields): BrowserRequest {
    return {
      ...fields,
      protocolVersion: PROTOCOL_VERSION,
      requestId: nextId("request"),
      operationId: checkedId(operationId, "operation ID"),
      deadline: new Date(Date.now() + this.#requestTimeoutMs).toISOString(),
    } as BrowserRequest;
  }

  private async connection(actor: AuthorityActor, descriptor: BrowserdDescriptor): Promise<PoolEntry> {
    const key = actorKey(actor);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.connection.runtimeInstanceId === descriptor.runtimeInstanceId && !existing.connection.closed) return existing;
    if (existing !== undefined) { this.#entries.delete(key); await existing.connection.close(); }
    const opening = this.#connecting.get(key);
    if (opening !== undefined) {
      const entry = await opening;
      if (entry.connection.runtimeInstanceId === descriptor.runtimeInstanceId && !entry.connection.closed) return entry;
      await entry.connection.close();
    }
    if (this.#entries.size + this.#connecting.size >= this.#maxActorConnections) throw new BrowserdClientError("LIMIT_EXCEEDED", "browser actor connection capacity is full", true, descriptor.runtimeInstanceId);
    const promise = this.openConnection(key, actor, descriptor);
    this.#connecting.set(key, promise);
    try { return await promise; }
    finally { if (this.#connecting.get(key) === promise) this.#connecting.delete(key); }
  }

  private async openConnection(key: string, actor: AuthorityActor, descriptor: BrowserdDescriptor): Promise<PoolEntry> {
    const connection = await BoundBrowserdConnection.connect(descriptor, actor, this.#maxPendingPerConnection, this.#requestTimeoutMs, this.#maxOutboundBytesPerConnection, this.#maxSubscriptionsPerConnection);
    if (this.#closed || this.#runtimeInstanceId !== descriptor.runtimeInstanceId) {
      await connection.close();
      throw new BrowserdClientError("BROWSER_INSTANCE_REPLACED", "browser service instance was replaced", true, this.#runtimeInstanceId);
    }
    const entry = { connection, lastUsedMs: Date.now() };
    this.#entries.set(key, entry);
    connection.onActivity = () => { const current = this.#entries.get(key); if (current?.connection === connection) current.lastUsedMs = Date.now(); };
    connection.onClosed = () => { if (this.#entries.get(key)?.connection === connection) this.#entries.delete(key); };
    return entry;
  }

  private acceptRuntime(runtimeInstanceId: string): void {
    const prior = this.#runtimeInstanceId;
    if (prior === undefined) { this.#runtimeInstanceId = runtimeInstanceId; return; }
    if (prior === runtimeInstanceId) return;
    this.#runtimeInstanceId = runtimeInstanceId;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const { connection } of entries) void connection.close(new BrowserdClientError("BROWSER_INSTANCE_REPLACED", "browser service instance was replaced", true, runtimeInstanceId));
  }

  private pruneIdle(): void {
    const cutoff = Date.now() - this.#idleTimeoutMs;
    for (const [key, entry] of this.#entries) if (entry.lastUsedMs <= cutoff && entry.connection.pendingCount === 0 && entry.connection.subscriptionCount === 0 && entry.connection.subscriptionTeardownCount === 0) { this.#entries.delete(key); void entry.connection.close(); }
  }
}

class BoundBrowserdConnection {
  readonly #pending = new Map<string, { readonly operationId: string; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  readonly #subscriptions = new Map<string, LocalFrameSubscription>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #frameBytes = 0;
  #incompleteUtf8Bytes = 0;
  #expectedUtf8Continuations = 0;
  #outboundBytes = 0;
  #closed = false;
  onActivity?: () => void;
  onClosed?: () => void;

  private constructor(
    readonly runtimeInstanceId: string,
    private readonly socket: Socket,
    private readonly actor: ActorIdentity,
    private readonly maxPending: number,
    private readonly requestTimeoutMs: number,
    private readonly maxOutboundBytes: number,
    private readonly maxSubscriptions: number,
  ) {}

  static async connect(descriptor: BrowserdDescriptor, actor: AuthorityActor, maxPending: number, requestTimeoutMs: number, maxOutboundBytes: number, maxSubscriptions: number): Promise<BoundBrowserdConnection> {
    const socket = createConnection({ path: descriptor.socketPath });
    let connection: BoundBrowserdConnection | undefined;
    try {
      await connected(socket);
      connection = new BoundBrowserdConnection(descriptor.runtimeInstanceId, socket, { principalId: actor.principalId, agentSessionId: actor.agentId }, maxPending, requestTimeoutMs, maxOutboundBytes, maxSubscriptions);
      socket.on("data", (chunk) => connection?.receive(chunk));
      socket.on("error", () => connection?.close(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection failed", true, descriptor.runtimeInstanceId)));
      socket.on("close", () => connection?.close(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection closed", true, descriptor.runtimeInstanceId)));
      const requestId = nextId("bind");
      const bound = await connection.exchange({ protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId, bindingSecret: descriptor.bindingSecret, actor: connection.actor }, requestId, "bind", undefined);
      if (!isRecord(bound) || bound.kind !== "bound" || !sameActor(bound.actor, connection.actor)) throw new BrowserdClientError("AUTH_FAILED", "browser service returned an invalid actor binding");
      return connection;
    } catch (error) {
      socket.destroy();
      if (error instanceof BrowserdClientError) throw error;
      throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection failed", true, descriptor.runtimeInstanceId);
    }
  }

  get closed(): boolean { return this.#closed; }
  get pendingCount(): number { return this.#pending.size; }
  get subscriptionCount(): number { return [...this.#subscriptions.values()].filter((item) => item.state !== "closed").length; }
  get subscriptionTeardownCount(): number { return [...this.#subscriptions.values()].filter((item) => item.state === "unsubscribing").length; }

  async call(request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection is closed", true, this.runtimeInstanceId);
    if (this.#pending.size >= this.maxPending) throw new BrowserdClientError("LIMIT_EXCEEDED", "browser connection request capacity is full", true, this.runtimeInstanceId);
    return await this.exchange(request, request.requestId, request.operationId, signal);
  }

  registerSubscription(subscriptionId: string, addressKey: string, listener: (event: FrameEvent) => void): void {
    if (this.#subscriptions.has(subscriptionId)) throw new BrowserdClientError("OPERATION_CONFLICT", "frame subscription already exists");
    if (this.#subscriptions.size >= this.maxSubscriptions) throw new BrowserdClientError("LIMIT_EXCEEDED", "frame subscription capacity is full", true, this.runtimeInstanceId);
    this.#subscriptions.set(subscriptionId, { addressKey, listener, scheduled: false, state: "open" });
  }
  removeSubscription(subscriptionId: string): void { const item = this.#subscriptions.get(subscriptionId); if (item !== undefined) item.state = "closed"; this.#subscriptions.delete(subscriptionId); }
  beginSubscriptionTeardown(subscriptionId: string): void { const item = this.#subscriptions.get(subscriptionId); if (item !== undefined && item.state === "open") item.state = "unsubscribing"; }
  failSubscriptionTeardown(subscriptionId: string): void { const item = this.#subscriptions.get(subscriptionId); if (item !== undefined) item.state = "cleanup-failed"; }

  async close(reason = new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection closed", true, this.runtimeInstanceId)): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(reason); }
    this.#pending.clear();
    this.#subscriptions.clear();
    this.onClosed?.();
  }

  private exchange(message: unknown, requestId: string, operationId: string, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service connection is closed", true, this.runtimeInstanceId));
    if (signal?.aborted) return Promise.reject(new DOMException("browser request was cancelled", "AbortError"));
    if (this.#pending.size >= this.maxPending) return Promise.reject(new BrowserdClientError("LIMIT_EXCEEDED", "browser connection request capacity is full", true, this.runtimeInstanceId));
    const encoded = `${JSON.stringify(message)}\n`;
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    if (encodedBytes > MAX_REQUEST_BYTES || this.#outboundBytes + encodedBytes > this.maxOutboundBytes) return Promise.reject(new BrowserdClientError("LIMIT_EXCEEDED", "browser connection outbound byte capacity is full", true, this.runtimeInstanceId));
    return new Promise((resolve, reject) => {
      let admitted = false;
      const abort = () => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        reject(new DOMException("browser request was cancelled", "AbortError"));
        if (admitted && operationId !== "bind") this.sendCancellation(operationId);
      };
      const expire = () => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        reject(new BrowserdClientError("DEADLINE_EXCEEDED", "browser service response deadline was exceeded", true, this.runtimeInstanceId));
        if (admitted && operationId !== "bind") this.sendCancellation(operationId);
      };
      const timer = setTimeout(expire, this.requestTimeoutMs);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, { operationId, resolve, reject, cleanup });
      if (signal?.aborted) { abort(); return; }
      try {
        this.#outboundBytes += encodedBytes;
        this.socket.write(encoded, () => { this.#outboundBytes = Math.max(0, this.#outboundBytes - encodedBytes); });
        admitted = true;
      } catch (error) {
        this.#outboundBytes = Math.max(0, this.#outboundBytes - encodedBytes);
        this.#pending.delete(requestId); cleanup(); reject(error instanceof Error ? error : new Error("browser service socket write failed"));
      }
    });
  }

  private sendCancellation(targetOperationId: string): void {
    if (this.#closed) return;
    const requestId = nextId("cancelRequest");
    const operationId = nextId("cancelOperation");
    const message: BrowserRequest = { protocolVersion: PROTOCOL_VERSION, kind: "operation.cancel", requestId, operationId, deadline: new Date(Date.now() + 5_000).toISOString(), targetOperationId };
    void this.exchange(message, requestId, operationId).catch(() => undefined);
  }

  private receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    let start = 0;
    try {
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        this.decodeFrameBytes(chunk.subarray(start, index));
        if (this.#expectedUtf8Continuations !== 0) throw new Error("incomplete UTF-8 sequence at frame boundary");
        this.#buffer += this.#decoder.decode();
        const line = this.#buffer;
        this.#buffer = "";
        this.#frameBytes = 0;
        this.#incompleteUtf8Bytes = 0;
        this.#expectedUtf8Continuations = 0;
        start = index + 1;
        if (line.trim() !== "") this.handleLine(line);
        if (this.#closed) return;
      }
      this.decodeFrameBytes(chunk.subarray(start));
    } catch {
      void this.close(new BrowserdClientError("INTERNAL_ERROR", "browser service returned invalid or oversized UTF-8 NDJSON"));
    }
  }

  private decodeFrameBytes(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#frameBytes += bytes.byteLength;
    if (this.#frameBytes > MAX_RESPONSE_BYTES) throw new Error("response frame exceeded bound");
    for (const byte of bytes) this.trackUtf8Byte(byte);
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
  }

  private trackUtf8Byte(byte: number): void {
    if (this.#expectedUtf8Continuations > 0) {
      if (byte < 0x80 || byte > 0xbf) throw new Error("invalid UTF-8 continuation");
      this.#expectedUtf8Continuations -= 1;
      this.#incompleteUtf8Bytes += 1;
      if (this.#expectedUtf8Continuations === 0) this.#incompleteUtf8Bytes = 0;
    } else if (byte <= 0x7f) this.#incompleteUtf8Bytes = 0;
    else if (byte >= 0xc2 && byte <= 0xdf) { this.#expectedUtf8Continuations = 1; this.#incompleteUtf8Bytes = 1; }
    else if (byte >= 0xe0 && byte <= 0xef) { this.#expectedUtf8Continuations = 2; this.#incompleteUtf8Bytes = 1; }
    else if (byte >= 0xf0 && byte <= 0xf4) { this.#expectedUtf8Continuations = 3; this.#incompleteUtf8Bytes = 1; }
    else throw new Error("invalid UTF-8 leading byte");
    if (this.#incompleteUtf8Bytes > 4) throw new Error("incomplete UTF-8 sequence exceeded bound");
  }

  private handleLine(line: string): void {
    let message: ServerMessage;
    try { message = parseServerMessage(JSON.parse(line) as unknown); }
    catch { void this.close(new BrowserdClientError("INTERNAL_ERROR", "browser service returned an invalid message")); return; }
    if (message.kind === "frame.available") { this.dispatchFrame(message); return; }
    if (message.kind !== "bound" && message.kind !== "response") { void this.close(new BrowserdClientError("INTERNAL_ERROR", "browser service crossed its bound connection role")); return; }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    if (message.kind !== "bound" && message.operationId !== pending.operationId) {
      const error = new BrowserdClientError("INTERNAL_ERROR", "browser service response operation identity changed");
      this.#pending.delete(message.requestId); pending.cleanup(); pending.reject(error);
      void this.close(error);
      return;
    }
    this.#pending.delete(message.requestId); pending.cleanup();
    if (message.kind === "bound") { pending.resolve(message); return; }
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new BrowserdClientError(message.error.code, message.error.message, message.error.retryable, this.runtimeInstanceId));
  }

  private dispatchFrame(event: FrameEvent): void {
    const key = frameAddressKey(event.address);
    let matched = false;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.addressKey !== key || subscription.state === "closed") continue;
      matched = true;
      subscription.pending = event;
      if (subscription.scheduled) continue;
      subscription.scheduled = true;
      queueMicrotask(() => this.deliverFrame(subscription));
    }
    if (matched) this.onActivity?.();
  }

  private deliverFrame(subscription: LocalFrameSubscription): void {
    if (this.#closed || ![...this.#subscriptions.values()].includes(subscription)) return;
    const event = subscription.pending;
    subscription.pending = undefined;
    subscription.scheduled = false;
    if (event === undefined) return;
    try { subscription.listener(event); } catch { /* A local listener cannot break the shared transport. */ }
    if (subscription.pending !== undefined && !subscription.scheduled) {
      subscription.scheduled = true;
      queueMicrotask(() => this.deliverFrame(subscription));
    }
  }
}

export async function readSecureDescriptor(descriptorPath: string, runtimeDirectory: string): Promise<BrowserdDescriptor> {
  try { return await readSecureDescriptorUnchecked(descriptorPath, runtimeDirectory); }
  catch (error) {
    if (error instanceof BrowserdClientError) throw error;
    throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service descriptor is unavailable", true);
  }
}

async function readSecureDescriptorUnchecked(descriptorPath: string, runtimeDirectory: string): Promise<BrowserdDescriptor> {
  const expectedDirectory = resolve(runtimeDirectory);
  if (resolve(dirname(descriptorPath)) !== expectedDirectory) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service descriptor location is invalid");
  const directoryInfo = await stat(expectedDirectory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service runtime directory is not private");
  if (await realpath(expectedDirectory) !== expectedDirectory) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service runtime directory is not canonical");
  const descriptorInfo = await lstat(descriptorPath);
  if (!descriptorInfo.isFile() || descriptorInfo.isSymbolicLink() || (descriptorInfo.mode & 0o777) !== 0o600) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service descriptor is not a private regular file");
  let value: unknown;
  try { value = JSON.parse(await readFile(descriptorPath, "utf8")); } catch { throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service descriptor is invalid"); }
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.runtimeInstanceId !== "string" || !ID.test(value.runtimeInstanceId) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.processStartTicks !== "string" || !/^\d+$/u.test(value.processStartTicks) || typeof value.socketPath !== "string" || typeof value.bindingSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.bindingSecret) || typeof value.brokerSigningSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.brokerSigningSecret) || typeof value.workspaceBrokerSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.workspaceBrokerSecret) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service descriptor is invalid");
  const socketPath = resolve(value.socketPath);
  if (dirname(socketPath) !== expectedDirectory || await realpath(dirname(socketPath)) !== expectedDirectory) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service socket location is invalid");
  const socketInfo = await lstat(socketPath);
  if (!socketInfo.isSocket() || (socketInfo.mode & 0o777) !== 0o600) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service socket is not private");
  const processStartTicks = await readProcessStartTicks(value.pid as number).catch(() => undefined);
  if (processStartTicks !== value.processStartTicks) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser service process identity is stale", true);
  return { protocolVersion: PROTOCOL_VERSION, runtimeInstanceId: value.runtimeInstanceId, pid: value.pid as number, processStartTicks: value.processStartTicks, socketPath, bindingSecret: value.bindingSecret, brokerSigningSecret: value.brokerSigningSecret, workspaceBrokerSecret: value.workspaceBrokerSecret, startedAt: value.startedAt };
}

async function readProcessStartTicks(pid: number): Promise<string> { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const end = text.lastIndexOf(")"); const ticks = text.slice(end + 2).split(" ")[19]; if (ticks === undefined || !/^\d+$/u.test(ticks)) throw new Error("invalid process identity"); return ticks; }
function actorKey(actor: AuthorityActor): string { return `${actor.principalId}\u0000${actor.agentId}`; }
function frameAddressKey(address: TabAddress): string { return `${address.browserSessionId}\u0000${address.tabId}\u0000${address.targetId}\u0000${address.controlEpoch}`; }
function nextId(prefix: string): string { return `${prefix}:${randomBytes(18).toString("base64url")}`; }
function nextOpaqueId(): string { return randomBytes(18).toString("base64url"); }
function checkedId(value: string, name: string): string { if (!ID.test(value)) throw new BrowserdClientError("INVALID_REQUEST", `${name} is invalid`); return value; }
function connected(socket: Socket): Promise<void> { return new Promise((resolvePromise, reject) => { const failed = (error: Error) => reject(error); socket.once("error", failed); socket.once("connect", () => { socket.off("error", failed); resolvePromise(); }); }); }
function sameActor(value: unknown, expected: ActorIdentity): boolean { return isRecord(value) && value.principalId === expected.principalId && value.agentSessionId === expected.agentSessionId; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
