#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class JsonRpcUnixClient {
  constructor(socketPath) { this.socketPath = socketPath; this.socket = undefined; this.pending = new Map(); this.buffer = ""; this.eventListeners = new Set(); }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.socket = createConnection(this.socketPath); this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.#consume(chunk));
    this.socket.on("error", (error) => this.#rejectAll(error));
    this.socket.on("close", () => this.#rejectAll(new Error("pi-browserd connection closed")));
    await new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); });
  }
  async call(method, params = {}) {
    await this.connect(); const id = randomUUID();
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return promise;
  }
  onEvent(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  close() { this.socket?.destroy(); }
  #consume(chunk) { this.buffer += chunk; while (true) { const newline = this.buffer.indexOf("\n"); if (newline < 0) break; const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); if (message.id !== undefined) { const pending = this.pending.get(message.id); if (!pending) continue; this.pending.delete(message.id); message.error ? pending.reject(Object.assign(new Error(message.error.message), message.error)) : pending.resolve(message.result); } else if (message.method) for (const listener of this.eventListeners) listener(message); } }
  #rejectAll(error) { for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); }
}

export async function discoverDescriptor(runtimeDir = process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, "pi-web")) {
  if (!runtimeDir) throw new Error("XDG_RUNTIME_DIR is not set");
  return JSON.parse(await readFile(join(runtimeDir, "browserd.json"), "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [method = "system.ping", params = "{}"] = process.argv.slice(2);
  const descriptor = await discoverDescriptor(); const client = new JsonRpcUnixClient(descriptor.socketPath);
  try { console.log(JSON.stringify(await client.call(method, JSON.parse(params)), null, 2)); }
  finally { client.close(); }
}
