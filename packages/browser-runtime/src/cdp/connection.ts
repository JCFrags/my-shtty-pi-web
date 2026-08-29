import { EventEmitter } from "node:events";
import { BrowserProtocolError } from "@webx/browser-protocol";

export interface CdpEvent {
  method: string;
  params: Readonly<Record<string, unknown>>;
  sessionId?: string;
}

interface Pending {
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  readonly removeAbort: () => void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CdpDisconnectedError extends BrowserProtocolError {
  constructor(message = "The CDP connection is unavailable.") { super("CDP_DISCONNECTED", message, true); this.name = "CdpDisconnectedError"; }
}

export class CdpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private readonly socket: WebSocket, private readonly maxPending = 1024) {
    super();
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.disconnect(new CdpDisconnectedError()));
    socket.addEventListener("error", () => this.disconnect(new CdpDisconnectedError()));
  }

  static async connect(url: string, options: { timeoutMs?: number; signal?: AbortSignal; maxPending?: number; webSocketFactory?: (url: string) => WebSocket } = {}): Promise<CdpConnection> {
    options.signal?.throwIfAborted();
    const socket = (options.webSocketFactory ?? ((value: string) => new WebSocket(value)))(url);
    const timeoutMs = options.timeoutMs ?? 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", errored);
          options.signal?.removeEventListener("abort", aborted);
        };
        const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error); };
        const opened = (): void => {
          if (options.signal?.aborted) { aborted(); return; }
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const aborted = (): void => {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
          fail(abortError(options.signal, "CDP connect cancelled."));
        };
        const errored = (): void => fail(new BrowserProtocolError("CDP_DISCONNECTED", "CDP connection failed.", true));
        const timer = setTimeout(() => fail(new BrowserProtocolError("CDP_DISCONNECTED", "CDP connection timed out.", true)), timeoutMs);
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", errored, { once: true });
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      throw error;
    }
    if (options.signal?.aborted) {
      socket.close();
      throw abortError(options.signal, "CDP connect cancelled.");
    }
    return new CdpConnection(socket, options.maxPending);
  }

  get connected(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  get pendingCount(): number { return this.pending.size; }

  async send<T = Record<string, unknown>>(method: string, params: Readonly<Record<string, unknown>> = {}, sessionId?: string, options: { timeoutMs?: number; signal?: AbortSignal; onDispatch?: () => void } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (!this.connected) throw new CdpDisconnectedError();
    if (this.pending.size >= this.maxPending) throw new BrowserProtocolError("LIMIT_EXCEEDED", "The CDP pending-command limit was reached.", true);
    const id = this.allocateId();
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: unknown): void => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.removeAbort();
        }
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const abort = (): void => finish(abortError(options.signal, `CDP command cancelled: ${method}`));
      const removeAbort = (): void => options.signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => finish(new BrowserProtocolError("CDP_ERROR", `CDP command timed out: ${method}`, true)), options.timeoutMs ?? 10_000);
      this.pending.set(id, { method, timer, removeAbort, resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      try {
        if (options.signal?.aborted) { abort(); return; }
        options.onDispatch?.();
        this.socket.send(JSON.stringify(message));
      } catch {
        finish(new CdpDisconnectedError());
      }
    });
  }

  async waitForEvent(method: string, predicate: (event: CdpEvent) => boolean, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CdpEvent> {
    options.signal?.throwIfAborted();
    return await new Promise<CdpEvent>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => { clearTimeout(timer); this.off("event", listener); options.signal?.removeEventListener("abort", abort); };
      const finish = (error: Error | undefined, event?: CdpEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error); else resolve(event as CdpEvent);
      };
      const listener = (event: CdpEvent): void => { if (event.method === method && predicate(event)) finish(undefined, event); };
      const abort = (): void => finish(abortError(options.signal, `CDP event cancelled: ${method}`));
      const timer = setTimeout(() => finish(new BrowserProtocolError("CDP_ERROR", `CDP event timed out: ${method}`, true)), options.timeoutMs ?? 10_000);
      this.on("event", listener);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
    this.disconnect(new CdpDisconnectedError("The CDP connection was closed."));
  }

  private allocateId(): number {
    for (let count = 0; count < this.maxPending + 1; count++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 2_147_483_647 ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new BrowserProtocolError("LIMIT_EXCEEDED", "No bounded CDP command ID is available.", true);
  }

  private receive(raw: string): void {
    if (raw.length > 16 * 1024 * 1024) { this.disconnect(new BrowserProtocolError("CDP_ERROR", "CDP message exceeded the byte limit.")); return; }
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      if (isRecord(message.error)) pending.reject(new BrowserProtocolError("CDP_ERROR", `CDP command failed: ${pending.method}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      this.emit("event", {
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
        ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
      } satisfies CdpEvent);
    }
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    this.emit("disconnect", error);
  }
}

function abortError(signal: AbortSignal | undefined, message: string): Error {
  return signal?.reason instanceof Error ? signal.reason : new BrowserProtocolError("OPERATION_CANCELLED", message);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
