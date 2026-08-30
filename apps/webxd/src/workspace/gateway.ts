import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  WORKSPACE_PROTOCOL_VERSION, WorkspaceProtocolError, WorkspaceRecordDecoder, encodeWorkspaceRecord,
  parseWorkspaceBind, parseWorkspaceClientCommand,
  type WorkspaceClientCommand, type WorkspaceFrameHeader, type WorkspaceServerHeader, type WorkspaceSnapshot, type WorkspaceStatus,
} from "../../../../packages/workspace-protocol/src/index.js";
import type { BrowserBackendSelection } from "../browser-backend-selection.js";
import { BrowserdWorkspaceBrokerClient, type BrowserdBrokerDiagnostics } from "./browserd-broker-client.js";
import { cleanupWorkspaceDescriptor, prepareWorkspaceDescriptor, publishWorkspaceDescriptor, type PreparedWorkspaceDescriptor, type WorkspaceDescriptor } from "./descriptor.js";
import { sanitizeWorkspaceSnapshot, unavailableWorkspaceSnapshot, workspaceFrameHeader } from "./sanitizer.js";
import type { WorkspaceFrameEvent, WorkspaceStateEvent } from "../../../../packages/browser-protocol/src/index.js";

const DEFAULT_MAX_OUTBOUND_BYTES = 12 * 1024 * 1024;

interface Selection {
  readonly selectionId: string;
  readonly subscriptionId: string;
  readonly browserSessionId: string;
  readonly tabId: string;
}

interface GatewayClient {
  readonly socket: Socket;
  readonly decoder: WorkspaceRecordDecoder;
  chain: Promise<void>;
  queued: number;
  bound: boolean;
  closed: boolean;
  snapshotSubscribed: boolean;
  outboundBytes: number;
  blocked: boolean;
  pendingFrame?: Uint8Array;
  selection?: Selection;
  pendingBrokerFrame?: WorkspaceFrameEvent;
  frameReadRunning: boolean;
  droppedFrames: number;
  bindTimer?: NodeJS.Timeout;
}

export interface WorkspaceGatewayOptions {
  readonly runtimeDirectory: string;
  readonly browserBackend: BrowserBackendSelection;
  readonly browserDescriptorPath?: string;
  readonly browserRuntimeDirectory?: string;
  readonly maxClientConnections?: number;
  readonly bindTimeoutMs?: number;
  readonly maxQueuedRequestsPerClient?: number;
  readonly maxOutboundBytesPerClient?: number;
  readonly heartbeatMs?: number;
}

export interface WorkspaceGatewayDiagnostics {
  readonly clientConnections: number;
  readonly boundClients: number;
  readonly selectedClients: number;
  readonly outboundBytes: number;
  readonly pendingFrames: number;
  readonly droppedFrames: number;
  readonly workspaceRevision: number;
  readonly broker: BrowserdBrokerDiagnostics;
}

export class WorkspaceGateway {
  readonly #clients = new Set<GatewayClient>();
  readonly #maxClients: number;
  readonly #bindTimeoutMs: number;
  readonly #maxQueued: number;
  readonly #maxOutboundBytes: number;
  readonly #heartbeatMs: number;
  readonly #broker?: BrowserdWorkspaceBrokerClient;
  #prepared?: PreparedWorkspaceDescriptor;
  #descriptor?: WorkspaceDescriptor;
  #socketIdentity?: { readonly dev: number; readonly ino: number };
  #server?: Server;
  #started = false;
  #everStopped = false;
  #stopPromise?: Promise<void>;
  #heartbeat?: NodeJS.Timeout;
  #refreshRunning = false;
  #snapshot: WorkspaceSnapshot = unavailableWorkspaceSnapshot("unavailable");
  #lastBrowserRevision = 0;

  constructor(private readonly options: WorkspaceGatewayOptions) {
    this.#maxClients = bounded(options.maxClientConnections ?? 4, 1, 16, "workspace client connection");
    this.#bindTimeoutMs = bounded(options.bindTimeoutMs ?? 5_000, 10, 60_000, "workspace bind timeout");
    this.#maxQueued = bounded(options.maxQueuedRequestsPerClient ?? 8, 1, 64, "workspace queued request");
    this.#maxOutboundBytes = bounded(options.maxOutboundBytesPerClient ?? DEFAULT_MAX_OUTBOUND_BYTES, 4 * 1024 * 1024, 32 * 1024 * 1024, "workspace outbound byte");
    this.#heartbeatMs = bounded(options.heartbeatMs ?? 1_000, 100, 60_000, "workspace heartbeat");
    if (options.browserBackend === "agentcursor") {
      if (options.browserDescriptorPath === undefined || options.browserRuntimeDirectory === undefined) throw new Error("AgentCursor workspace gateway requires browserd descriptor configuration");
      this.#broker = new BrowserdWorkspaceBrokerClient({
        descriptorPath: options.browserDescriptorPath,
        runtimeDirectory: options.browserRuntimeDirectory,
        onStateEvent: (event) => this.onBrowserState(event),
        onFrameEvent: (event) => this.onBrowserFrame(event),
        onRuntimeChanged: (prior, current) => this.onBrowserRuntimeChanged(prior, current),
        onConnectionChanged: (ready) => this.onBrowserConnectionChanged(ready),
      });
    }
  }

  get descriptor(): WorkspaceDescriptor { if (this.#descriptor === undefined) throw new Error("workspace gateway is not started"); return this.#descriptor; }
  get diagnostics(): WorkspaceGatewayDiagnostics {
    let outboundBytes = 0, pendingFrames = 0, droppedFrames = 0, selectedClients = 0, boundClients = 0;
    for (const client of this.#clients) { outboundBytes += client.outboundBytes; pendingFrames += Number(client.pendingFrame !== undefined) + Number(client.pendingBrokerFrame !== undefined); droppedFrames += client.droppedFrames; selectedClients += Number(client.selection !== undefined); boundClients += Number(client.bound); }
    return { clientConnections: this.#clients.size, boundClients, selectedClients, outboundBytes, pendingFrames, droppedFrames, workspaceRevision: this.#snapshot.workspaceRevision, broker: this.#broker?.diagnostics ?? { connected: false, pendingRequests: 0, subscriptions: 0 } };
  }

  async start(): Promise<WorkspaceDescriptor> {
    if (this.#everStopped) throw new Error("a stopped workspace gateway cannot restart");
    if (this.#started) return this.descriptor;
    const prepared = await prepareWorkspaceDescriptor(this.options.runtimeDirectory);
    const server = createServer((socket) => this.accept(socket));
    this.#prepared = prepared; this.#descriptor = prepared.descriptor; this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(prepared.paths.socketPath, resolve); });
      await chmod(prepared.paths.socketPath, 0o600);
      const socket = await lstat(prepared.paths.socketPath);
      if (!socket.isSocket() || (socket.mode & 0o777) !== 0o600) throw new Error("workspace gateway socket is not private");
      this.#socketIdentity = await publishWorkspaceDescriptor(prepared.paths, prepared.descriptor);
      this.#started = true;
      this.#heartbeat = setInterval(() => void this.refreshBrowser(), this.#heartbeatMs);
      this.#heartbeat.unref?.();
      await this.refreshBrowser();
      return prepared.descriptor;
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      await cleanupWorkspaceDescriptor(prepared.paths, prepared.descriptor, this.#socketIdentity, prepared.lease).catch(() => undefined);
      this.#prepared = undefined; this.#descriptor = undefined; this.#server = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#everStopped = true; this.#started = false;
    if (this.#stopPromise !== undefined) return await this.#stopPromise;
    const promise = this.stopInternal(); this.#stopPromise = promise;
    try { await promise; } finally { if (this.#stopPromise === promise) this.#stopPromise = undefined; }
  }

  private async stopInternal(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    for (const client of [...this.#clients]) { try { await this.closeClient(client); } catch (error) { failures.push(error); } }
    const server = this.#server; this.#server = undefined;
    if (server !== undefined) try { await closeServer(server); } catch (error) { failures.push(error); }
    if (this.#broker !== undefined) try { await this.#broker.close(); } catch (error) { failures.push(error); }
    const prepared = this.#prepared; this.#prepared = undefined; this.#descriptor = undefined;
    if (prepared !== undefined) try { await cleanupWorkspaceDescriptor(prepared.paths, prepared.descriptor, this.#socketIdentity, prepared.lease); } catch (error) { failures.push(error); }
    this.#socketIdentity = undefined;
    if (failures.length > 0) throw new AggregateError(failures, "workspace gateway cleanup failed");
  }

  private accept(socket: Socket): void {
    if (this.#clients.size >= this.#maxClients) { socket.destroy(); return; }
    const client: GatewayClient = { socket, decoder: new WorkspaceRecordDecoder(), chain: Promise.resolve(), queued: 0, bound: false, closed: false, snapshotSubscribed: false, outboundBytes: 0, blocked: false, frameReadRunning: false, droppedFrames: 0 };
    this.#clients.add(client);
    client.bindTimer = setTimeout(() => { if (!client.bound) void this.closeClient(client); }, this.#bindTimeoutMs); client.bindTimer.unref?.();
    socket.on("data", (chunk) => {
      let records;
      try { records = client.decoder.push(chunk); } catch { void this.closeClient(client); return; }
      for (const record of records) {
        if (client.queued >= this.#maxQueued) { void this.closeClient(client); return; }
        client.queued++;
        const task = client.chain.then(async () => {
          if (client.closed) return;
          if (record.payload.byteLength !== 0) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace client commands cannot carry a payload.");
          if (!client.bound) await this.bindClient(client, record.header);
          else {
            if (isRecord(record.header) && record.header.kind === "bind") throw new WorkspaceProtocolError("AUTH_FAILED", "Workspace connection cannot rebind.");
            await this.command(client, parseWorkspaceClientCommand(record.header));
          }
        }).catch((error) => { if (!client.closed) this.sendFailure(client, requestId(record.header), error); if (isRecord(record.header) && record.header.kind === "bind") void this.closeClient(client); }).finally(() => { client.queued--; });
        client.chain = task;
      }
    });
    socket.on("drain", () => { client.blocked = false; this.flushPendingFrame(client); });
    socket.once("error", () => void this.closeClient(client));
    socket.once("close", () => void this.closeClient(client));
  }

  private async bindClient(client: GatewayClient, header: unknown): Promise<void> {
    const bind = parseWorkspaceBind(header);
    if (!secretMatches(bind.bindingSecret, this.descriptor.bindingSecret)) throw new WorkspaceProtocolError("AUTH_FAILED", "Workspace binding authentication failed.");
    client.bound = true;
    if (client.bindTimer !== undefined) clearTimeout(client.bindTimer); client.bindTimer = undefined;
    this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "bound", requestId: bind.requestId, webxdRuntimeInstanceId: this.descriptor.webxdRuntimeInstanceId });
    this.sendStatus(client, this.currentStatus());
  }

  private async command(client: GatewayClient, command: WorkspaceClientCommand): Promise<void> {
    if (command.kind === "snapshot.get") { this.sendSuccess(client, command.requestId, { kind: "snapshot", snapshot: this.#snapshot }); return; }
    if (command.kind === "snapshot.subscribe") { client.snapshotSubscribed = true; this.sendSuccess(client, command.requestId, { kind: "ack" }); this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "snapshot", snapshot: this.#snapshot }); return; }
    if (command.kind === "ping") { this.sendSuccess(client, command.requestId, { kind: "pong", generatedAt: new Date().toISOString() }); return; }
    if (command.kind === "frame.clear") { await this.clearSelection(client); this.sendSuccess(client, command.requestId, { kind: "ack" }); return; }
    if (command.kind === "close") { this.sendSuccess(client, command.requestId, { kind: "ack" }); await this.closeClient(client, true); return; }
    if (this.#broker === undefined) throw new WorkspaceProtocolError("UNAVAILABLE", "AgentCursor browser workspace is not active.", true);
    await this.clearSelection(client);
    const selection: Selection = { selectionId: command.selectionId, subscriptionId: randomBytes(18).toString("base64url"), browserSessionId: command.browserSessionId, tabId: command.tabId };
    client.pendingFrame = undefined; client.pendingBrokerFrame = undefined;
    await this.#broker.subscribeFrames(selection.subscriptionId, selection.browserSessionId, selection.tabId, "selected");
    client.selection = selection;
    this.sendSuccess(client, command.requestId, { kind: "selection", selectionId: selection.selectionId, browserSessionId: selection.browserSessionId, tabId: selection.tabId });
  }

  private async clearSelection(client: GatewayClient): Promise<void> {
    const prior = client.selection;
    client.selection = undefined; client.pendingFrame = undefined; client.pendingBrokerFrame = undefined;
    if (prior !== undefined && this.#broker !== undefined) await this.#broker.unsubscribeFrames(prior.subscriptionId, prior.browserSessionId, prior.tabId);
  }

  private onBrowserState(event: WorkspaceStateEvent): void {
    if (event.revision <= this.#lastBrowserRevision) return;
    this.#lastBrowserRevision = event.revision;
    void this.refreshSnapshot();
  }

  private onBrowserFrame(event: WorkspaceFrameEvent): void {
    for (const client of this.#clients) {
      const selection = client.selection;
      if (client.closed || selection === undefined || selection.subscriptionId !== event.subscriptionId || selection.browserSessionId !== event.browserSessionId || selection.tabId !== event.tabId || event.runtimeInstanceId !== this.#broker?.diagnostics.runtimeInstanceId) continue;
      if (client.pendingBrokerFrame !== undefined) client.droppedFrames++;
      client.pendingBrokerFrame = event;
      if (!client.frameReadRunning) void this.readFrames(client);
    }
  }

  private async readFrames(client: GatewayClient): Promise<void> {
    if (this.#broker === undefined || client.frameReadRunning) return;
    client.frameReadRunning = true;
    try {
      while (!client.closed && client.pendingBrokerFrame !== undefined) {
        const event = client.pendingBrokerFrame; client.pendingBrokerFrame = undefined;
        let bytes: Uint8Array;
        try { bytes = await this.#broker.readFrame(event); } catch { continue; }
        const selection = client.selection;
        if (selection === undefined || selection.subscriptionId !== event.subscriptionId || selection.browserSessionId !== event.browserSessionId || selection.tabId !== event.tabId || this.#broker.diagnostics.runtimeInstanceId !== event.runtimeInstanceId) { client.droppedFrames++; continue; }
        if (client.pendingBrokerFrame !== undefined) { client.droppedFrames++; continue; }
        const header = workspaceFrameHeader(event, selection.selectionId);
        if (bytes.byteLength !== header.byteLength) { client.droppedFrames++; continue; }
        this.sendFrame(client, header, bytes);
      }
    } finally { client.frameReadRunning = false; if (!client.closed && client.pendingBrokerFrame !== undefined) void this.readFrames(client); }
  }

  private async refreshBrowser(): Promise<void> {
    if (this.#broker === undefined || this.#refreshRunning) return;
    this.#refreshRunning = true;
    try { await this.#broker.refresh(); await this.#broker.ping(); await this.refreshSnapshot(); }
    catch { this.onBrowserConnectionChanged(false); }
    finally { this.#refreshRunning = false; }
  }

  private async refreshSnapshot(): Promise<void> {
    if (this.#broker === undefined) return;
    try {
      const snapshot = await this.#broker.snapshot();
      const runtime = this.#broker.diagnostics.runtimeInstanceId;
      if (runtime === undefined) return;
      this.#lastBrowserRevision = snapshot.workspaceRevision;
      this.#snapshot = sanitizeWorkspaceSnapshot(snapshot, runtime);
      this.broadcastSnapshot(); this.broadcastStatus(this.currentStatus());
    } catch { this.onBrowserConnectionChanged(false); }
  }

  private onBrowserRuntimeChanged(prior: string | undefined, current: string | undefined): void {
    if (prior !== undefined && prior !== current) {
      this.#snapshot = unavailableWorkspaceSnapshot("replaced", this.#lastBrowserRevision + 1); this.#lastBrowserRevision = 0;
      for (const client of this.#clients) { client.selection = undefined; client.pendingFrame = undefined; client.pendingBrokerFrame = undefined; }
      this.broadcastSnapshot(); this.broadcastStatus({ connection: "reconnecting", browserd: "replaced", message: "Browser service was replaced." });
    }
  }

  private onBrowserConnectionChanged(ready: boolean): void {
    if (ready) { this.broadcastStatus(this.currentStatus()); return; }
    if (this.#snapshot.browserdState !== "replaced") this.#snapshot = unavailableWorkspaceSnapshot("unavailable", this.#lastBrowserRevision);
    for (const client of this.#clients) { client.selection = undefined; client.pendingFrame = undefined; client.pendingBrokerFrame = undefined; }
    this.broadcastSnapshot(); this.broadcastStatus(this.currentStatus());
  }

  private currentStatus(): WorkspaceStatus {
    if (this.options.browserBackend === "legacy") return { connection: "unavailable", browserd: "unavailable", message: "AgentCursor browser workspace is not active." };
    if (this.#snapshot.browserdState === "replaced") return { connection: "reconnecting", browserd: "replaced", message: "Browser service was replaced." };
    if (this.#broker?.diagnostics.connected) return { connection: "ready", browserd: "ready" };
    return { connection: "reconnecting", browserd: "unavailable", message: "Browser workspace is reconnecting." };
  }

  private broadcastSnapshot(): void { for (const client of this.#clients) if (client.bound && client.snapshotSubscribed) this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "snapshot", snapshot: this.#snapshot }); }
  private broadcastStatus(status: WorkspaceStatus): void { for (const client of this.#clients) if (client.bound) this.sendStatus(client, status); }
  private sendStatus(client: GatewayClient, status: WorkspaceStatus): void { this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "status", status }); }
  private sendSuccess(client: GatewayClient, requestIdValue: string, result: Extract<WorkspaceServerHeader, { kind: "response"; ok: true }>["result"]): void { this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "response", requestId: requestIdValue, ok: true, result }); }
  private sendFailure(client: GatewayClient, requestIdValue: string, error: unknown): void {
    const protocol = error instanceof WorkspaceProtocolError ? error : new WorkspaceProtocolError("INTERNAL_ERROR", "Workspace request failed.");
    this.sendHeader(client, { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "response", requestId: requestIdValue, ok: false, error: { code: workspaceErrorCode(protocol.code), message: protocol.message.slice(0, 256), retryable: protocol.retryable } });
  }
  private sendHeader(client: GatewayClient, header: WorkspaceServerHeader): void { this.write(client, encodeWorkspaceRecord(header), false); }
  private sendFrame(client: GatewayClient, header: WorkspaceFrameHeader, payload: Uint8Array): void { this.write(client, encodeWorkspaceRecord(header, payload), true); }

  private write(client: GatewayClient, encoded: Uint8Array, droppable: boolean): void {
    if (client.closed || client.socket.destroyed) return;
    if (droppable && client.blocked) { if (client.pendingFrame !== undefined) client.droppedFrames++; client.pendingFrame = encoded; return; }
    if (client.outboundBytes + encoded.byteLength > this.#maxOutboundBytes) {
      if (droppable) { client.droppedFrames++; client.pendingFrame = encoded.byteLength <= this.#maxOutboundBytes ? encoded : undefined; return; }
      void this.closeClient(client); return;
    }
    client.outboundBytes += encoded.byteLength;
    const writable = client.socket.write(encoded, () => { client.outboundBytes = Math.max(0, client.outboundBytes - encoded.byteLength); });
    if (!writable) client.blocked = true;
  }

  private flushPendingFrame(client: GatewayClient): void {
    const pending = client.pendingFrame; client.pendingFrame = undefined;
    if (pending !== undefined && !client.closed) this.write(client, pending, true);
  }

  private async closeClient(client: GatewayClient, graceful = false): Promise<void> {
    if (client.closed) return;
    client.closed = true;
    if (client.bindTimer !== undefined) clearTimeout(client.bindTimer); client.bindTimer = undefined;
    this.#clients.delete(client);
    const selection = client.selection; client.selection = undefined; client.pendingFrame = undefined; client.pendingBrokerFrame = undefined;
    if (selection !== undefined && this.#broker !== undefined) await this.#broker.unsubscribeFrames(selection.subscriptionId, selection.browserSessionId, selection.tabId).catch(() => undefined);
    if (graceful) client.socket.end(); else client.socket.destroy();
  }
}

function bounded(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} bound is invalid`); return value; }
function secretMatches(actual: string, expected: string): boolean { const a = Buffer.from(actual); const b = Buffer.from(expected); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function requestId(value: unknown): string { return isRecord(value) && typeof value.requestId === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.requestId) ? value.requestId : "request:error"; }
function workspaceErrorCode(code: string): "INVALID_REQUEST" | "AUTH_FAILED" | "NOT_FOUND" | "CONFLICT" | "LIMIT_EXCEEDED" | "UNAVAILABLE" | "INTERNAL_ERROR" { if (code === "AUTH_FAILED" || code === "LIMIT_EXCEEDED" || code === "UNAVAILABLE" || code === "INTERNAL_ERROR") return code; if (code === "OPERATION_CONFLICT" || code === "CONFLICT") return "CONFLICT"; if (code.includes("NOT_FOUND")) return "NOT_FOUND"; return "INVALID_REQUEST"; }
function closeServer(server: Server): Promise<void> { return !server.listening ? Promise.resolve() : new Promise((resolve) => server.close(() => resolve())); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
