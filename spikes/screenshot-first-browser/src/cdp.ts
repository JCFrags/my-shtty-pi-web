import { EventEmitter } from "node:events";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CdpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    super();
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.disconnect(new Error("CDP socket closed")));
    socket.addEventListener("error", () => this.disconnect(new Error("CDP socket error")));
  }

  static async connect(url: string, timeoutMs = 5_000): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${url}`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  get connected(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.connected) throw new Error("CDP is disconnected");
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  async waitForEvent(
    method: string,
    predicate: (event: CdpEvent) => boolean,
    timeoutMs = 10_000,
  ): Promise<CdpEvent> {
    return await new Promise<CdpEvent>((resolve, reject) => {
      const listener = (event: CdpEvent) => {
        if (event.method === method && predicate(event)) {
          clearTimeout(timer);
          this.off("event", listener);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        this.off("event", listener);
        reject(new Error(`CDP event timeout: ${method}`));
      }, timeoutMs);
      this.on("event", listener);
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.disconnect(new Error("CDP connection closed"));
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: string; code?: number };
        pending.reject(new Error(`CDP ${error.code ?? "error"}: ${error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params as Record<string, unknown> | undefined) ?? {},
        ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
      };
      this.emit("event", event);
    }
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }
}
