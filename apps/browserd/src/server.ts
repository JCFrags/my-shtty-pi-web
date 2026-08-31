import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Check } from "typebox/value";
import {
  BrowserProtocolError, PROTOCOL_VERSION, ServerMessageSchema,
  parseBindRequest, parseBrowserRequest, parseWorkspaceBrokerBindRequest, parseWorkspaceBrokerRequest, sanitizeMessage,
  type ActorIdentity, type ErrorCode, type FrameEvent, type WorkspaceBrokerRequest, type WorkspaceStateEvent,
} from "@webx/browser-protocol";
import { BrokerNavigationAuthorization, BrowserRuntime, type BrowserRuntimeOptions } from "@webx/browser-runtime";
import { cleanupDescriptor, prepareDescriptor, publishDescriptor, type BrowserdDescriptor, type DescriptorPaths, type StartupLease } from "./descriptor.js";
import { NdjsonReader, sendJson } from "./transport.js";

interface ConnectionState {
  readonly connectionId: string;
  readonly socket: Socket;
  readonly reader: NdjsonReader;
  readonly pending: Map<string, AbortController>;
  actor?: ActorIdentity;
  role?: "actor" | "workspace";
  chain: Promise<void>;
  bindTimer: NodeJS.Timeout | undefined;
  closed: boolean;
}

export interface BrowserdServerOptions extends BrowserRuntimeOptions {
  runtimeDirectory?: string;
  runtime?: BrowserRuntime;
  maxConnections?: number;
  maxWorkspaceConnections?: number;
  bindTimeoutMs?: number;
  allowTemporaryRuntimeDirectoryForTest?: boolean;
  startupHooksForTest?: { afterOwnership?: () => Promise<void>; afterListen?: () => Promise<void> };
}

export class BrowserdServer {
  private readonly runtime: BrowserRuntime;
  private readonly brokerAuthorization: BrokerNavigationAuthorization | undefined;
  private readonly egressBindingId: string;
  private readonly runtimeDirectory: string | undefined;
  private readonly maxConnections: number;
  private readonly maxWorkspaceConnections: number;
  private readonly bindTimeoutMs: number;
  private readonly allowTemporaryRuntimeDirectoryForTest: boolean;
  private readonly startupHooksForTest: BrowserdServerOptions["startupHooksForTest"];
  private server: Server | undefined;
  private descriptorValue: BrowserdDescriptor | undefined;
  private paths: DescriptorPaths | undefined;
  private lease: StartupLease | undefined;
  private startPromise: Promise<BrowserdDescriptor> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private everStopped = false;
  private stopState: "open" | "stopping" | "stopped" | "cleanup-failed" = "open";
  private readonly connections = new Set<ConnectionState>();

  constructor(options: BrowserdServerOptions = {}) {
    const brokerAuthorization = options.runtime === undefined ? new BrokerNavigationAuthorization() : undefined;
    this.brokerAuthorization = brokerAuthorization;
    this.runtime = options.runtime ?? new BrowserRuntime({ ...options, navigationAuthorization: brokerAuthorization as BrokerNavigationAuthorization, requireEgressForSessions: true });
    const proxy = options.chrome?.egressProxy;
    this.egressBindingId = proxy === undefined ? "unconfigured" : `forward-proxy://${proxy.host === "::1" ? "[::1]" : proxy.host}:${proxy.port}`;
    this.runtimeDirectory = options.runtimeDirectory;
    this.maxConnections = options.maxConnections ?? 128;
    this.maxWorkspaceConnections = options.maxWorkspaceConnections ?? 4;
    this.bindTimeoutMs = options.bindTimeoutMs ?? 5_000;
    this.allowTemporaryRuntimeDirectoryForTest = options.allowTemporaryRuntimeDirectoryForTest ?? false;
    this.startupHooksForTest = options.startupHooksForTest;
    if (!Number.isInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 1_024) throw new BrowserProtocolError("INVALID_REQUEST", "browserd connection limit is invalid.");
    if (!Number.isInteger(this.maxWorkspaceConnections) || this.maxWorkspaceConnections < 1 || this.maxWorkspaceConnections > 16) throw new BrowserProtocolError("INVALID_REQUEST", "browserd workspace connection limit is invalid.");
    if (!Number.isFinite(this.bindTimeoutMs) || this.bindTimeoutMs < 10 || this.bindTimeoutMs > 60_000) throw new BrowserProtocolError("INVALID_REQUEST", "browserd bind timeout is invalid.");
    this.runtime.on("frame", this.onFrame);
    this.runtime.on("workspaceState", this.onWorkspaceState);
  }

  get descriptor(): BrowserdDescriptor {
    if (this.descriptorValue === undefined) throw new Error("browserd is not started.");
    return this.descriptorValue;
  }

  start(): Promise<BrowserdDescriptor> {
    if (this.everStopped) return Promise.reject(new BrowserProtocolError("OPERATION_CONFLICT", "A stopped browserd server object cannot restart."));
    if (this.descriptorValue !== undefined) return Promise.resolve(this.descriptorValue);
    if (this.startPromise !== undefined) return this.startPromise;
    this.stopRequested = false;
    const promise = this.startInternal();
    this.startPromise = promise;
    const clear = (): void => { if (this.startPromise === promise) this.startPromise = undefined; };
    void promise.then(clear, clear);
    return promise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.everStopped = true;
    if (this.stopState === "stopped") return;
    if (this.stopPromise !== undefined) return await this.stopPromise;
    this.stopState = "stopping";
    const promise = this.stopInternal();
    this.stopPromise = promise;
    try { await promise; this.stopState = "stopped"; }
    catch (error) { this.stopState = "cleanup-failed"; throw error; }
    finally { if (this.stopPromise === promise) this.stopPromise = undefined; }
  }

  private async startInternal(): Promise<BrowserdDescriptor> {
    const prepared = await prepareDescriptor(this.runtimeDirectory, { allowTemporaryFallback: this.allowTemporaryRuntimeDirectoryForTest });
    this.brokerAuthorization?.configure({ runtimeInstanceId: prepared.descriptor.runtimeInstanceId, signingSecret: prepared.descriptor.brokerSigningSecret, egressBindingId: this.egressBindingId });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.paths = prepared.paths;
    this.lease = prepared.lease;
    try {
      await this.startupHooksForTest?.afterOwnership?.();
      this.checkStopDuringStart();
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.off("listening", listening); reject(error); };
        const listening = (): void => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(prepared.paths.socketPath);
      });
      await chmod(prepared.paths.socketPath, 0o600);
      if (((await stat(prepared.paths.socketPath)).mode & 0o777) !== 0o600) throw new BrowserProtocolError("INTERNAL_ERROR", "browserd socket must have mode 0600.");
      await this.startupHooksForTest?.afterListen?.();
      this.checkStopDuringStart();
      await publishDescriptor(prepared.paths, prepared.descriptor);
      this.checkStopDuringStart();
      this.descriptorValue = prepared.descriptor;
      return prepared.descriptor;
    } catch (error) {
      if (this.server === server) this.server = undefined;
      await closeNetServer(server);
      await cleanupDescriptor(prepared.paths, prepared.descriptor, prepared.lease);
      if (this.paths === prepared.paths) this.paths = undefined;
      if (this.lease === prepared.lease) this.lease = undefined;
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const failures: unknown[] = [];
    const server = this.server;
    this.server = undefined;
    for (const state of [...this.connections]) this.closeConnection(state);
    if (server !== undefined) { try { await closeNetServer(server); } catch (error) { failures.push(error); } }
    try { await this.runtime.close(); } catch (error) { failures.push(error); }
    const paths = this.paths;
    const descriptor = this.descriptorValue;
    const lease = this.lease;
    this.paths = undefined;
    this.descriptorValue = undefined;
    this.lease = undefined;
    try {
      if (paths !== undefined && descriptor !== undefined && lease !== undefined) await cleanupDescriptor(paths, descriptor, lease);
      else await lease?.release();
    } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "browserd shutdown cleanup failed.");
  }

  private checkStopDuringStart(): void {
    if (this.stopRequested) throw new BrowserProtocolError("OPERATION_CANCELLED", "browserd startup was stopped.");
  }

  private accept(socket: Socket): void {
    if (this.connections.size >= this.maxConnections) { socket.destroy(); return; }
    const state: ConnectionState = { connectionId: randomBytes(18).toString("base64url"), socket, reader: new NdjsonReader(), pending: new Map(), chain: Promise.resolve(), bindTimer: undefined, closed: false };
    state.bindTimer = setTimeout(() => this.closeConnection(state), this.bindTimeoutMs);
    state.bindTimer.unref();
    this.connections.add(state);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of state.reader.push(chunk)) {
          state.chain = state.chain.then(async () => {
            if (state.role === undefined) await this.handleLine(state, line);
            else void this.handleLine(state, line).catch(() => this.closeConnection(state));
          }).catch(() => this.closeConnection(state));
        }
      } catch { this.closeConnection(state); }
    });
    socket.once("error", () => this.closeConnection(state));
    socket.once("close", () => this.closeConnection(state));
  }

  private async handleLine(state: ConnectionState, line: string): Promise<void> {
    if (state.closed) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.sendError(state, undefined, "INVALID_REQUEST", "Request is not valid JSON."); return; }
    if (state.role === undefined) {
      try {
        if (isRecord(value) && value.kind === "workspace.bind") {
          const workspaceConnections = [...this.connections].filter((item) => item.role === "workspace").length;
          if (workspaceConnections >= this.maxWorkspaceConnections) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Workspace broker connection limit reached.", true);
          const bind = parseWorkspaceBrokerBindRequest(value);
          if (!secretMatches(bind.workspaceBrokerSecret, this.descriptor.workspaceBrokerSecret)) throw new BrowserProtocolError("AUTH_FAILED", "Workspace binding authentication failed.");
          state.role = "workspace";
          if (state.bindTimer !== undefined) { clearTimeout(state.bindTimer); state.bindTimer = undefined; }
          this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "workspace.bound", requestId: bind.requestId, runtimeInstanceId: this.descriptor.runtimeInstanceId });
        } else {
          const bind = parseBindRequest(value);
          if (!secretMatches(bind.bindingSecret, this.descriptor.bindingSecret)) throw new BrowserProtocolError("AUTH_FAILED", "Binding authentication failed.");
          state.actor = Object.freeze({ ...bind.actor });
          state.role = "actor";
          if (state.bindTimer !== undefined) { clearTimeout(state.bindTimer); state.bindTimer = undefined; }
          this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "bound", requestId: bind.requestId, actor: state.actor });
        }
      } catch (error) {
        const requestId = isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined;
        this.sendCaught(state, requestId, error);
        this.closeConnection(state, true);
      }
      return;
    }
    if (isRecord(value) && (value.kind === "bind" || value.kind === "workspace.bind")) {
      this.sendError(state, typeof value.requestId === "string" ? value.requestId : undefined, "ALREADY_BOUND", "Connection is already bound.");
      this.closeConnection(state, true);
      return;
    }
    if (state.role === "workspace") {
      let request: WorkspaceBrokerRequest;
      try { request = parseWorkspaceBrokerRequest(value, Date.now(), Buffer.byteLength(line, "utf8")); } catch (error) { this.sendCaught(state, isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined, error); return; }
      await this.handleWorkspaceRequest(state, request);
      return;
    }
    let request;
    try { request = parseBrowserRequest(value); } catch (error) { this.sendCaught(state, isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined, error); return; }
    if (state.pending.has(request.requestId)) { this.sendError(state, request.requestId, "OPERATION_CONFLICT", "Request ID is already pending."); return; }
    if (state.pending.size >= 64) { this.sendError(state, request.requestId, "LIMIT_EXCEEDED", "Connection request limit reached."); return; }
    const actor = state.actor;
    if (actor === undefined) { this.closeConnection(state); return; }
    const controller = new AbortController();
    state.pending.set(request.requestId, controller);
    try {
      const result = await this.runtime.dispatch(actor, request, controller.signal, state.connectionId);
      this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: request.requestId, operationId: request.operationId, ok: true, result });
    } catch (error) { this.sendCaught(state, request.requestId, error, request.operationId); }
    finally { state.pending.delete(request.requestId); }
  }

  private async handleWorkspaceRequest(state: ConnectionState, request: WorkspaceBrokerRequest): Promise<void> {
    if (state.pending.has(request.requestId)) { this.sendError(state, request.requestId, "OPERATION_CONFLICT", "Request ID is already pending."); return; }
    if (state.pending.size >= 16) { this.sendError(state, request.requestId, "LIMIT_EXCEEDED", "Workspace request limit reached."); return; }
    const controller = new AbortController();
    state.pending.set(request.requestId, controller);
    try {
      let result: unknown;
      let cachedDelivery: { readonly subscriptionId: string; readonly frame: FrameEvent } | undefined;
      if (request.kind === "workspace.snapshot.get") result = this.runtime.workspaceSnapshot();
      else if (request.kind === "workspace.events.subscribe") { this.runtime.workspaceSubscribeEvents(state.connectionId); result = { kind: "workspacePong", generatedAt: new Date().toISOString() }; }
      else if (request.kind === "workspace.events.unsubscribe") { this.runtime.workspaceUnsubscribeEvents(state.connectionId); result = { kind: "workspacePong", generatedAt: new Date().toISOString() }; }
      else if (request.kind === "workspace.frames.subscribe") { this.runtime.workspaceSubscribeFrames(state.connectionId, request.subscriptionId, request.browserSessionId, request.tabId, request.interest); result = { kind: "workspaceSubscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: true }; }
      else if (request.kind === "workspace.frames.unsubscribe") { await this.runtime.workspaceUnsubscribeFrames(state.connectionId, request.subscriptionId, request.browserSessionId, request.tabId); result = { kind: "workspaceSubscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: false }; }
      else if (request.kind === "workspace.frames.replace") {
        const frame = this.runtime.workspaceReplaceFrames(state.connectionId, request.prior, request.next);
        result = { kind: "workspaceSubscription", operationId: request.operationId, subscriptionId: request.next.subscriptionId, subscribed: true };
        if (frame !== undefined) cachedDelivery = { subscriptionId: request.next.subscriptionId, frame };
      }
      else if (request.kind === "workspace.frame.read") result = await this.runtime.workspaceReadFrame(state.connectionId, request);
      else if (request.kind === "workspace.control.acquire") result = await this.runtime.workspaceAcquireControl(state.connectionId, request);
      else if (request.kind === "workspace.control.heartbeat") result = this.runtime.workspaceHeartbeatControl(state.connectionId, request);
      else if (request.kind === "workspace.control.release") result = await this.runtime.workspaceReleaseControl(state.connectionId, request);
      else if (request.kind === "workspace.control.status") result = this.runtime.workspaceControlStatus(request.browserSessionId);
      else if (request.kind === "workspace.input.batch") result = await this.runtime.workspaceInputBatch(state.connectionId, request, controller.signal);
      else result = { kind: "workspacePong", generatedAt: new Date().toISOString() };
      this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: request.requestId, operationId: request.operationId, ok: true, result });
      if (cachedDelivery !== undefined) this.sendWorkspaceFrame(state, cachedDelivery.subscriptionId, cachedDelivery.frame);
    } catch (error) { this.sendCaught(state, request.requestId, error, request.operationId); }
    finally { state.pending.delete(request.requestId); }
  }

  private sendCaught(state: ConnectionState, requestId: string | undefined, error: unknown, operationId?: string): void {
    if (error instanceof BrowserProtocolError) { const safe = error.sanitized(); this.sendError(state, requestId, safe.code, safe.message, operationId, safe.retryable, safe.details); return; }
    this.sendError(state, requestId, "INTERNAL_ERROR", "Browser request failed.", operationId);
  }

  private sendError(state: ConnectionState, requestId: string | undefined, code: ErrorCode, message: string, operationId?: string, retryable = false, details?: Readonly<Record<string, string | number | boolean>>): void {
    const safeRequestId = requestId && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(requestId) ? requestId : "request:error";
    this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: safeRequestId, ...(operationId ? { operationId } : {}), ok: false, error: { code, message: sanitizeMessage(message), retryable, ...(details ? { details } : {}) } });
  }

  private send(state: ConnectionState, message: unknown, droppable = false): boolean {
    if (state.closed) return false;
    if (!Check(ServerMessageSchema, message)) {
      if (isRecord(message) && message.kind === "response" && message.ok === false) { this.closeConnection(state); return false; }
      this.sendError(state, isRecord(message) && typeof message.requestId === "string" ? message.requestId : undefined, "INTERNAL_ERROR", "Server produced an invalid response.");
      return false;
    }
    try { return sendJson(state.socket, message, { droppable }); } catch { this.closeConnection(state); return false; }
  }

  private readonly onFrame = (frame: FrameEvent): void => {
    for (const state of this.connections) {
      if (state.closed) continue;
      if (state.role === "actor" && state.actor !== undefined && this.runtime.shouldDeliverFrame(state.connectionId, state.actor, frame)) this.send(state, frame, true);
      if (state.role === "workspace") for (const delivery of this.runtime.workspaceFrameDeliveries(state.connectionId, frame)) this.sendWorkspaceFrame(state, delivery.subscriptionId, delivery.frame);
    }
  };

  private sendWorkspaceFrame(state: ConnectionState, subscriptionId: string, frame: FrameEvent): void {
    if (state.closed || state.role !== "workspace") return;
    const message = { protocolVersion: PROTOCOL_VERSION, kind: "workspace.frame.available", runtimeInstanceId: this.descriptor.runtimeInstanceId, subscriptionId, browserSessionId: frame.address.browserSessionId, tabId: frame.address.tabId, controlEpoch: frame.address.controlEpoch, documentGeneration: frame.documentGeneration, viewportGeneration: frame.viewportGeneration, frameSequence: frame.frameSequence, capturedMonotonicMs: frame.capturedMonotonicMs, publishedMonotonicMs: frame.publishedMonotonicMs, mediaType: frame.mediaType, byteLength: frame.byteLength, artifactId: frame.artifactId, sha256: frame.sha256, imagePixelWidth: frame.imagePixelWidth, imagePixelHeight: frame.imagePixelHeight, cssViewportWidth: frame.viewport.width, cssViewportHeight: frame.viewport.height, devicePixelRatio: frame.viewport.devicePixelRatio };
    if (this.send(state, message, true)) this.runtime.recordWorkspaceFrameDelivered(state.connectionId, subscriptionId, this.descriptor.runtimeInstanceId, frame);
  }

  private readonly onWorkspaceState = (event: WorkspaceStateEvent): void => {
    for (const state of this.connections) if (!state.closed && state.role === "workspace" && this.runtime.shouldDeliverWorkspaceEvent(state.connectionId)) this.send(state, event);
  };

  private closeConnection(state: ConnectionState, graceful = false): void {
    if (state.closed) return;
    state.closed = true;
    if (state.bindTimer !== undefined) { clearTimeout(state.bindTimer); state.bindTimer = undefined; }
    for (const controller of state.pending.values()) controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "browserd connection closed."));
    state.pending.clear();
    this.runtime.releaseConnection(state.connectionId);
    if (graceful) state.socket.end(); else state.socket.destroy();
    this.connections.delete(state);
  }
}

async function closeNetServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function secretMatches(received: string, expected: string): boolean { const left = Buffer.from(received); const right = Buffer.from(expected); return left.byteLength === right.byteLength && timingSafeEqual(left, right); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
