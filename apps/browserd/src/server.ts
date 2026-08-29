import { timingSafeEqual } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Check } from "typebox/value";
import {
  BrowserProtocolError, PROTOCOL_VERSION, ServerMessageSchema,
  parseBindRequest, parseBrowserRequest, sanitizeMessage,
  type ActorIdentity, type ErrorCode, type FrameEvent,
} from "@webx/browser-protocol";
import { BrowserRuntime, type BrowserRuntimeOptions } from "@webx/browser-runtime";
import { cleanupDescriptor, prepareDescriptor, type BrowserdDescriptor, type DescriptorPaths } from "./descriptor.js";
import { NdjsonReader, sendJson } from "./transport.js";

interface ConnectionState {
  readonly socket: Socket;
  readonly reader: NdjsonReader;
  readonly pending: Map<string, AbortController>;
  actor?: ActorIdentity;
  chain: Promise<void>;
  closed: boolean;
}

export interface BrowserdServerOptions extends BrowserRuntimeOptions {
  runtimeDirectory?: string;
  runtime?: BrowserRuntime;
}

export class BrowserdServer {
  private readonly runtime: BrowserRuntime;
  private readonly runtimeDirectory: string | undefined;
  private server: Server | undefined;
  private descriptorValue: BrowserdDescriptor | undefined;
  private paths: DescriptorPaths | undefined;
  private readonly connections = new Set<ConnectionState>();

  constructor(options: BrowserdServerOptions = {}) {
    this.runtime = options.runtime ?? new BrowserRuntime(options);
    this.runtimeDirectory = options.runtimeDirectory;
    this.runtime.on("frame", this.onFrame);
  }

  get descriptor(): BrowserdDescriptor {
    if (this.descriptorValue === undefined) throw new Error("browserd is not started.");
    return this.descriptorValue;
  }

  async start(): Promise<BrowserdDescriptor> {
    if (this.server !== undefined) return this.descriptor;
    const prepared = await prepareDescriptor(this.runtimeDirectory);
    this.descriptorValue = prepared.descriptor;
    this.paths = prepared.paths;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.off("listening", listening); reject(error); };
        const listening = (): void => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(prepared.paths.socketPath);
      });
      await chmod(prepared.paths.socketPath, 0o600);
      if (((await stat(prepared.paths.socketPath)).mode & 0o777) !== 0o600) throw new Error("browserd socket must have mode 0600.");
      return prepared.descriptor;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const state of this.connections) this.closeConnection(state);
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.runtime.close();
    if (this.paths !== undefined) await cleanupDescriptor(this.paths);
    this.paths = undefined;
    this.descriptorValue = undefined;
  }

  private accept(socket: Socket): void {
    const state: ConnectionState = { socket, reader: new NdjsonReader(), pending: new Map(), chain: Promise.resolve(), closed: false };
    this.connections.add(state);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of state.reader.push(chunk)) {
          state.chain = state.chain.then(async () => {
            if (state.actor === undefined) await this.handleLine(state, line);
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
    if (state.actor === undefined) {
      try {
        const bind = parseBindRequest(value);
        if (!secretMatches(bind.bindingSecret, this.descriptor.bindingSecret)) throw new BrowserProtocolError("AUTH_FAILED", "Binding authentication failed.");
        state.actor = Object.freeze({ ...bind.actor });
        this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "bound", requestId: bind.requestId, actor: state.actor });
      } catch (error) {
        const requestId = isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined;
        this.sendCaught(state, requestId, error);
        this.closeConnection(state, true);
      }
      return;
    }
    if (isRecord(value) && value.kind === "bind") {
      this.sendError(state, typeof value.requestId === "string" ? value.requestId : undefined, "ALREADY_BOUND", "Connection is already bound.");
      this.closeConnection(state, true);
      return;
    }
    let request;
    try { request = parseBrowserRequest(value); } catch (error) { this.sendCaught(state, isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined, error); return; }
    if (state.pending.has(request.requestId)) { this.sendError(state, request.requestId, "OPERATION_CONFLICT", "Request ID is already pending."); return; }
    if (state.pending.size >= 64) { this.sendError(state, request.requestId, "LIMIT_EXCEEDED", "Connection request limit reached."); return; }
    const controller = new AbortController();
    state.pending.set(request.requestId, controller);
    try {
      const result = await this.runtime.dispatch(state.actor, request, controller.signal);
      this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: request.requestId, operationId: request.operationId, ok: true, result });
    } catch (error) { this.sendCaught(state, request.requestId, error, request.operationId); }
    finally { state.pending.delete(request.requestId); }
  }

  private sendCaught(state: ConnectionState, requestId: string | undefined, error: unknown, operationId?: string): void {
    if (error instanceof BrowserProtocolError) { this.sendError(state, requestId, error.code, error.message, operationId); return; }
    const message = error instanceof Error ? error.message : "Browser request failed.";
    this.sendError(state, requestId, errorCode(message), message, operationId);
  }

  private sendError(state: ConnectionState, requestId: string | undefined, code: ErrorCode, message: string, operationId?: string): void {
    const safeRequestId = requestId && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(requestId) ? requestId : "request:error";
    this.send(state, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: safeRequestId, ...(operationId ? { operationId } : {}), ok: false, error: { code, message: sanitizeMessage(message), retryable: false } });
  }

  private send(state: ConnectionState, message: unknown, droppable = false): void {
    if (state.closed) return;
    if (!Check(ServerMessageSchema, message)) {
      if (isRecord(message) && message.kind === "response" && message.ok === false) { this.closeConnection(state); return; }
      this.sendError(state, isRecord(message) && typeof message.requestId === "string" ? message.requestId : undefined, "CDP_ERROR", "Server produced an invalid response.");
      return;
    }
    try { sendJson(state.socket, message, { droppable }); } catch { this.closeConnection(state); }
  }

  private readonly onFrame = (frame: FrameEvent): void => {
    for (const state of this.connections) {
      if (state.actor === undefined || state.closed) continue;
      if (this.runtime.ownsSession(state.actor, frame.address.browserSessionId)) this.send(state, frame, true);
    }
  };

  private closeConnection(state: ConnectionState, graceful = false): void {
    if (state.closed) return;
    state.closed = true;
    for (const controller of state.pending.values()) controller.abort(new Error("browserd connection closed."));
    state.pending.clear();
    if (graceful) state.socket.end(); else state.socket.destroy();
    this.connections.delete(state);
  }
}

function secretMatches(received: string, expected: string): boolean { const left = Buffer.from(received); const right = Buffer.from(expected); return left.byteLength === right.byteLength && timingSafeEqual(left, right); }
function errorCode(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("navigation")) return "NAVIGATION_DENIED";
  if (lower.includes("deadline")) return "DEADLINE_EXCEEDED";
  if (lower.includes("epoch")) return "CONTROL_EPOCH_STALE";
  if (lower.includes("observation")) return "OBSERVATION_STALE";
  if (lower.includes("handle")) return "HANDLE_STALE";
  if (lower.includes("session not found")) return "SESSION_NOT_FOUND";
  if (lower.includes("tab not found")) return "TAB_NOT_FOUND";
  if (lower.includes("limit") || lower.includes("full")) return "LIMIT_EXCEEDED";
  if (lower.includes("cancel")) return "OPERATION_CANCELLED";
  return "CDP_ERROR";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
