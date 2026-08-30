import { createConnection, type Socket } from "node:net";
import type { NdjsonConnection, NdjsonConnectionFactory } from "./transport.js";

const MAX_LINE_BYTES = 2_097_152;

/** Create one real same-user Unix NDJSON connection for WebX transport use. */
export const nodeNdjsonConnectionFactory: NdjsonConnectionFactory = async (socketPath) => {
  const socket = createConnection({ path: socketPath });
  await connected(socket);
  return new NodeNdjsonConnection(socket);
};

class NodeNdjsonConnection implements NdjsonConnection {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #closed = false;
  #buffer = "";
  #lineBytes = 0;
  #pending?: { resolve(value: string): void; reject(error: Error): void; cleanup(): void };

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => { this.#closed = true; this.fail(error); });
    socket.on("close", () => { this.#closed = true; this.fail(new Error("Unix NDJSON connection closed without a response")); });
  }

  send(line: string, signal?: AbortSignal): Promise<string> {
    if (this.#closed || this.#pending !== undefined) return Promise.reject(new Error("Unix NDJSON connection is not available"));
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return Promise.reject(new Error("Unix NDJSON request line is too large"));
    if (signal?.aborted) return Promise.reject(new DOMException("request was cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const aborted = () => { this.socket.destroy(); this.fail(new DOMException("request was cancelled", "AbortError")); };
      const cleanup = () => signal?.removeEventListener("abort", aborted);
      this.#pending = { resolve, reject, cleanup };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      try { this.socket.write(`${line}\n`); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("Unix NDJSON write failed")); }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.fail(new Error("Unix NDJSON connection closed"));
    this.socket.end();
  }

  private receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    try {
      this.#lineBytes += chunk.byteLength;
      if (this.#lineBytes > MAX_LINE_BYTES) throw new Error("Unix NDJSON response line is too large");
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const value = this.#buffer.slice(0, newline);
      const trailing = this.#buffer.slice(newline + 1);
      if (trailing.length > 0) throw new Error("Unix NDJSON connection returned unsolicited data");
      this.#buffer = "";
      this.#lineBytes = 0;
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending === undefined) throw new Error("Unix NDJSON connection returned an unsolicited response");
      pending.cleanup();
      pending.resolve(value);
    } catch (error) {
      this.socket.destroy();
      this.fail(error instanceof Error ? error : new Error("Unix NDJSON response is invalid"));
    }
  }

  private fail(error: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) { pending.cleanup(); pending.reject(error); }
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    socket.once("error", failed);
    socket.once("connect", () => { socket.off("error", failed); resolve(); });
  });
}
