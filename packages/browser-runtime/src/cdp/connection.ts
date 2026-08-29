import { EventEmitter } from "node:events";

export interface CdpEvent {
  method: string;
  params: Readonly<Record<string, unknown>>;
  sessionId?: string;
}

interface Pending {
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CdpDisconnectedError extends Error {
  constructor(message = "The CDP connection is unavailable.") { super(message); this.name = "CdpDisconnectedError"; }
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

  static async connect(url: string, options: { timeoutMs?: number; signal?: AbortSignal; maxPending?: number } = {}): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    const timeoutMs = options.timeoutMs ?? 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => { cleanup(); reject(error); };
        const opened = (): void => { cleanup(); resolve(); };
        const aborted = (): void => fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("CDP connect cancelled"));
        const timer = setTimeout(() => fail(new Error("CDP connect timeout")), timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", errored);
          options.signal?.removeEventListener("abort", aborted);
        };
        const errored = (): void => fail(new Error("CDP connect failed"));
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", errored, { once: true });
        options.signal?.addEventListener("abort", aborted, { once: true });
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpConnection(socket, options.maxPending);
  }

  get connected(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  get pendingCount(): number { return this.pending.size; }

  async send<T = Record<string, unknown>>(method: string, params: Readonly<Record<string, unknown>> = {}, sessionId?: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.connected) throw new CdpDisconnectedError();
    if (this.pending.size >= this.maxPending) throw new Error("The CDP pending-command limit was reached.");
    const id = this.allocateId();
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 10_000;
      const abort = (): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        options.signal?.removeEventListener("abort", abort);
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`CDP command cancelled: ${method}`));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method, timer,
        resolve: (value) => { options.signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { options.signal?.removeEventListener("abort", abort); reject(error); },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { this.socket.send(JSON.stringify(message)); } catch (error) { abort(); }
    });
  }

  async waitForEvent(method: string, predicate: (event: CdpEvent) => boolean, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CdpEvent> {
    return await new Promise<CdpEvent>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); this.off("event", listener); options.signal?.removeEventListener("abort", abort); };
      const listener = (event: CdpEvent): void => { if (event.method === method && predicate(event)) { cleanup(); resolve(event); } };
      const abort = (): void => { cleanup(); reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`CDP event cancelled: ${method}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP event timeout: ${method}`)); }, options.timeoutMs ?? 10_000);
      this.on("event", listener);
      options.signal?.addEventListener("abort", abort, { once: true });
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
    throw new Error("No bounded CDP command ID is available.");
  }

  private receive(raw: string): void {
    if (raw.length > 16 * 1024 * 1024) { this.disconnect(new Error("CDP message exceeded the byte limit.")); return; }
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) pending.reject(new Error(`CDP command failed: ${pending.method}`));
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
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit("disconnect", error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
