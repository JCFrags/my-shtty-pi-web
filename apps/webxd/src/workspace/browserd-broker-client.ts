import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION, parseServerMessage,
  type ServerMessage, type WorkspaceFrameEvent, type WorkspaceSnapshot, type WorkspaceStateEvent,
} from "../../../../packages/browser-protocol/src/index.js";
import { BrowserdClientError, readSecureDescriptor, type BrowserdDescriptor } from "../browserd-client.js";

const MAX_PENDING = 16;
const MAX_OUTBOUND_BYTES = 2 * MAX_REQUEST_BYTES;
const READ_CHUNK_BYTES = 768 * 1024;

interface PendingRequest {
  readonly operationId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface BrowserdBrokerDiagnostics {
  readonly runtimeInstanceId?: string;
  readonly connected: boolean;
  readonly pendingRequests: number;
  readonly subscriptions: number;
}

export interface BrowserdWorkspaceBrokerClientOptions {
  readonly descriptorPath: string;
  readonly runtimeDirectory: string;
  readonly requestTimeoutMs?: number;
  readonly onStateEvent?: (event: WorkspaceStateEvent) => void;
  readonly onFrameEvent?: (event: WorkspaceFrameEvent) => void;
  readonly onRuntimeChanged?: (prior: string | undefined, current: string | undefined) => void;
  readonly onConnectionChanged?: (connected: boolean) => void;
}

export class BrowserdWorkspaceBrokerClient {
  readonly #descriptorPath: string;
  readonly #runtimeDirectory: string;
  readonly #requestTimeoutMs: number;
  #connection?: WorkspaceBrokerConnection;
  #connecting?: Promise<WorkspaceBrokerConnection>;
  #runtimeInstanceId?: string;
  #closed = false;
  readonly #subscriptions = new Map<string, { browserSessionId: string; tabId: string }>();

  constructor(private readonly options: BrowserdWorkspaceBrokerClientOptions) {
    this.#descriptorPath = options.descriptorPath;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get diagnostics(): BrowserdBrokerDiagnostics {
    return { ...(this.#runtimeInstanceId === undefined ? {} : { runtimeInstanceId: this.#runtimeInstanceId }), connected: this.#connection?.closed === false, pendingRequests: this.#connection?.pendingCount ?? 0, subscriptions: this.#subscriptions.size };
  }

  async refresh(): Promise<void> { await this.connection(); }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const result = await this.call("workspace.snapshot.get", {});
    if (!isRecord(result) || result.kind !== "workspaceSnapshot") throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace returned an invalid snapshot", false, this.#runtimeInstanceId);
    return result as unknown as WorkspaceSnapshot;
  }

  async ping(): Promise<void> { await this.call("workspace.ping", {}); }

  async subscribeFrames(subscriptionId: string, browserSessionId: string, tabId: string, interest: "idle" | "selected" = "selected"): Promise<void> {
    const prior = this.#subscriptions.get(subscriptionId);
    if (prior !== undefined) {
      if (prior.browserSessionId !== browserSessionId || prior.tabId !== tabId) throw new BrowserdClientError("OPERATION_CONFLICT", "workspace subscription identity conflicts", false, this.#runtimeInstanceId);
      return;
    }
    await this.call("workspace.frames.subscribe", { subscriptionId, browserSessionId, tabId, interest });
    this.#subscriptions.set(subscriptionId, { browserSessionId, tabId });
  }

  async unsubscribeFrames(subscriptionId: string, browserSessionId: string, tabId: string): Promise<void> {
    const prior = this.#subscriptions.get(subscriptionId);
    if (prior === undefined) return;
    await this.call("workspace.frames.unsubscribe", { subscriptionId, browserSessionId, tabId });
    this.#subscriptions.delete(subscriptionId);
  }

  async replaceFrames(prior: { readonly subscriptionId: string; readonly browserSessionId: string; readonly tabId: string } | undefined, next: { readonly subscriptionId: string; readonly browserSessionId: string; readonly tabId: string; readonly interest: "idle" | "selected" }): Promise<void> {
    const knownPrior = prior === undefined ? undefined : this.#subscriptions.get(prior.subscriptionId);
    if (prior !== undefined && (knownPrior === undefined || knownPrior.browserSessionId !== prior.browserSessionId || knownPrior.tabId !== prior.tabId)) throw new BrowserdClientError("OPERATION_CONFLICT", "prior workspace selection is no longer current", false, this.#runtimeInstanceId);
    const existing = this.#subscriptions.get(next.subscriptionId);
    if (existing !== undefined && (prior !== undefined || existing.browserSessionId !== next.browserSessionId || existing.tabId !== next.tabId)) throw new BrowserdClientError("OPERATION_CONFLICT", "workspace subscription identity conflicts", false, this.#runtimeInstanceId);
    await this.call("workspace.frames.replace", { ...(prior === undefined ? {} : { prior: { subscriptionId: prior.subscriptionId, browserSessionId: prior.browserSessionId, tabId: prior.tabId } }), next });
    if (prior !== undefined) this.#subscriptions.delete(prior.subscriptionId);
    this.#subscriptions.set(next.subscriptionId, { browserSessionId: next.browserSessionId, tabId: next.tabId });
  }

  async readFrame(event: WorkspaceFrameEvent): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let totalBytes: number | undefined;
    while (totalBytes === undefined || offset < totalBytes) {
      const result = await this.call("workspace.frame.read", {
        subscriptionId: event.subscriptionId,
        browserSessionId: event.browserSessionId,
        tabId: event.tabId,
        frameSequence: event.frameSequence,
        artifactId: event.artifactId,
        offset,
        maxBytes: READ_CHUNK_BYTES,
      });
      if (!isWorkspaceFrameArtifact(result, event, offset)) throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace returned an invalid frame chunk", false, this.#runtimeInstanceId);
      const chunk = Buffer.from(result.base64, "base64");
      if (chunk.byteLength !== result.byteLength || chunk.byteLength === 0) throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace frame chunk length changed", false, this.#runtimeInstanceId);
      if (totalBytes === undefined) totalBytes = result.totalBytes;
      if (result.totalBytes !== totalBytes || totalBytes !== event.byteLength || offset + chunk.byteLength > totalBytes) throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace frame total length changed", false, this.#runtimeInstanceId);
      chunks.push(chunk);
      offset += chunk.byteLength;
      if (result.eof !== (offset === totalBytes)) throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace frame termination changed", false, this.#runtimeInstanceId);
    }
    const output = new Uint8Array(totalBytes ?? 0);
    let cursor = 0;
    for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.byteLength; }
    if (output.byteLength !== event.byteLength || createHash("sha256").update(output).digest("hex") !== event.sha256) throw new BrowserdClientError("INTERNAL_ERROR", "browser workspace frame integrity check failed", false, this.#runtimeInstanceId);
    return output;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const opening = this.#connecting;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#subscriptions.clear();
    await connection?.close();
    if (opening !== undefined) await opening.then(async (item) => await item.close(), () => undefined);
    this.options.onConnectionChanged?.(false);
  }

  private async call(kind: string, payload: Record<string, unknown>): Promise<unknown> {
    const connection = await this.connection();
    const operationId = nextId("workspaceOperation");
    return await connection.call({ protocolVersion: PROTOCOL_VERSION, kind, requestId: nextId("workspaceRequest"), operationId, deadline: new Date(Date.now() + this.#requestTimeoutMs).toISOString(), ...payload }, operationId);
  }

  private async connection(): Promise<WorkspaceBrokerConnection> {
    if (this.#closed) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser workspace client is closed", true, this.#runtimeInstanceId);
    const descriptor = await readSecureDescriptor(this.#descriptorPath, this.#runtimeDirectory);
    const current = this.#connection;
    if (current !== undefined && !current.closed && current.runtimeInstanceId === descriptor.runtimeInstanceId) return current;
    if (current !== undefined) { this.#connection = undefined; await current.close(); }
    const opening = this.#connecting;
    if (opening !== undefined) {
      const connected = await opening;
      if (!connected.closed && connected.runtimeInstanceId === descriptor.runtimeInstanceId) return connected;
      await connected.close();
    }
    const promise = this.open(descriptor);
    this.#connecting = promise;
    try { return await promise; }
    finally { if (this.#connecting === promise) this.#connecting = undefined; }
  }

  private async open(descriptor: BrowserdDescriptor): Promise<WorkspaceBrokerConnection> {
    const connection = await WorkspaceBrokerConnection.connect(descriptor, this.#requestTimeoutMs, {
      state: (event) => this.options.onStateEvent?.(event),
      frame: (event) => this.options.onFrameEvent?.(event),
      closed: (item) => {
        if (this.#connection === item) { this.#connection = undefined; this.#subscriptions.clear(); this.options.onConnectionChanged?.(false); }
      },
    });
    try {
      const operationId = nextId("workspaceOperation");
      await connection.call({ protocolVersion: PROTOCOL_VERSION, kind: "workspace.events.subscribe", requestId: nextId("workspaceRequest"), operationId, deadline: new Date(Date.now() + this.#requestTimeoutMs).toISOString() }, operationId);
    } catch (error) { await connection.close(); throw error; }
    if (this.#closed) { await connection.close(); throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser workspace client is closed", true); }
    const prior = this.#runtimeInstanceId;
    this.#runtimeInstanceId = descriptor.runtimeInstanceId;
    this.#connection = connection;
    this.#subscriptions.clear();
    if (prior !== descriptor.runtimeInstanceId) this.options.onRuntimeChanged?.(prior, descriptor.runtimeInstanceId);
    this.options.onConnectionChanged?.(true);
    return connection;
  }
}

class WorkspaceBrokerConnection {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #lineBytes = 0;
  #outboundBytes = 0;
  #closed = false;

  private constructor(readonly runtimeInstanceId: string, private readonly socket: Socket, private readonly requestTimeoutMs: number, private readonly callbacks: { state(event: WorkspaceStateEvent): void; frame(event: WorkspaceFrameEvent): void; closed(item: WorkspaceBrokerConnection): void }) {}

  static async connect(descriptor: BrowserdDescriptor, requestTimeoutMs: number, callbacks: { state(event: WorkspaceStateEvent): void; frame(event: WorkspaceFrameEvent): void; closed(item: WorkspaceBrokerConnection): void }): Promise<WorkspaceBrokerConnection> {
    const socket = createConnection({ path: descriptor.socketPath });
    await connected(socket).catch((error) => { socket.destroy(); throw error; });
    const connection = new WorkspaceBrokerConnection(descriptor.runtimeInstanceId, socket, requestTimeoutMs, callbacks);
    socket.on("data", (chunk) => connection.receive(chunk));
    socket.once("error", () => void connection.close());
    socket.once("close", () => void connection.close());
    const requestId = nextId("workspaceBind");
    const bound = await connection.exchange({ protocolVersion: PROTOCOL_VERSION, kind: "workspace.bind", requestId, workspaceBrokerSecret: descriptor.workspaceBrokerSecret }, requestId, "bind");
    if (!isRecord(bound) || bound.kind !== "workspace.bound" || bound.runtimeInstanceId !== descriptor.runtimeInstanceId) { await connection.close(); throw new BrowserdClientError("AUTH_FAILED", "browser workspace binding failed", false, descriptor.runtimeInstanceId); }
    return connection;
  }

  get closed(): boolean { return this.#closed; }
  get pendingCount(): number { return this.#pending.size; }

  async call(message: Record<string, unknown>, operationId: string): Promise<unknown> {
    if (this.#closed) throw new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser workspace connection is closed", true, this.runtimeInstanceId);
    if (this.#pending.size >= MAX_PENDING) throw new BrowserdClientError("LIMIT_EXCEEDED", "browser workspace request capacity is full", true, this.runtimeInstanceId);
    return await this.exchange(message, String(message.requestId), operationId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BrowserdClientError("CAPABILITY_UNAVAILABLE", "browser workspace connection closed", true, this.runtimeInstanceId)); }
    this.#pending.clear();
    this.callbacks.closed(this);
  }

  private exchange(message: Record<string, unknown>, requestId: string, operationId: string): Promise<unknown> {
    const encoded = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_REQUEST_BYTES || this.#outboundBytes + bytes > MAX_OUTBOUND_BYTES) return Promise.reject(new BrowserdClientError("LIMIT_EXCEEDED", "browser workspace outbound capacity is full", true, this.runtimeInstanceId));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        reject(new BrowserdClientError("DEADLINE_EXCEEDED", "browser workspace request timed out", true, this.runtimeInstanceId));
        void this.close();
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { operationId, resolve, reject, timer });
      try {
        this.#outboundBytes += bytes;
        this.socket.write(encoded, () => { this.#outboundBytes = Math.max(0, this.#outboundBytes - bytes); });
      } catch (error) {
        this.#outboundBytes = Math.max(0, this.#outboundBytes - bytes);
        this.#pending.delete(requestId); clearTimeout(timer); reject(error instanceof Error ? error : new Error("browser workspace write failed"));
      }
    });
  }

  private receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    let start = 0;
    try {
      for (let index = 0; index < chunk.byteLength; index++) {
        if (chunk[index] !== 0x0a) continue;
        this.decode(chunk.subarray(start, index), true);
        const line = this.#buffer;
        this.#buffer = ""; this.#lineBytes = 0; start = index + 1;
        if (line.trim() !== "") this.handleLine(line);
      }
      this.decode(chunk.subarray(start), false);
    } catch { void this.close(); }
  }

  private decode(bytes: Uint8Array, finish: boolean): void {
    this.#lineBytes += bytes.byteLength;
    if (this.#lineBytes > MAX_RESPONSE_BYTES) throw new Error("browser workspace response exceeded bound");
    this.#buffer += this.#decoder.decode(bytes, { stream: !finish });
    if (finish) this.#buffer += this.#decoder.decode();
  }

  private handleLine(line: string): void {
    let message: ServerMessage;
    try { message = parseServerMessage(JSON.parse(line) as unknown); } catch { void this.close(); return; }
    if (message.kind === "workspace.state.changed") { this.callbacks.state(message); return; }
    if (message.kind === "workspace.frame.available") { this.callbacks.frame(message); return; }
    if (message.kind !== "workspace.bound" && message.kind !== "response") { void this.close(); return; }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    if (message.kind === "response" && message.operationId !== pending.operationId) { void this.close(); return; }
    this.#pending.delete(message.requestId); clearTimeout(pending.timer);
    if (message.kind === "workspace.bound") pending.resolve(message);
    else if (message.ok) pending.resolve(message.result);
    else pending.reject(new BrowserdClientError(message.error.code, message.error.message, message.error.retryable, this.runtimeInstanceId));
  }
}

interface WorkspaceFrameArtifact {
  kind: "workspaceFrameArtifact"; artifactId: string; browserSessionId: string; tabId: string; subscriptionId: string; frameSequence: number; mediaType: string; byteLength: number; sha256: string; offset: number; totalBytes: number; eof: boolean; base64: string;
}
function isWorkspaceFrameArtifact(value: unknown, event: WorkspaceFrameEvent, offset: number): value is WorkspaceFrameArtifact {
  return isRecord(value) && value.kind === "workspaceFrameArtifact" && value.artifactId === event.artifactId && value.browserSessionId === event.browserSessionId && value.tabId === event.tabId && value.subscriptionId === event.subscriptionId && value.frameSequence === event.frameSequence && value.mediaType === event.mediaType && value.sha256 === event.sha256 && value.offset === offset && Number.isSafeInteger(value.byteLength) && Number.isSafeInteger(value.totalBytes) && typeof value.eof === "boolean" && typeof value.base64 === "string";
}
function nextId(prefix: string): string { return `${prefix}:${randomBytes(18).toString("base64url")}`; }
function connected(socket: Socket): Promise<void> { return new Promise((resolve, reject) => { const failed = (error: Error) => reject(error); socket.once("error", failed); socket.once("connect", () => { socket.off("error", failed); resolve(); }); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
