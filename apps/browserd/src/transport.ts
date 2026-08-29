import type { Socket } from "node:net";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "@webx/browser-protocol";

export class NdjsonReader {
  private buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes = MAX_REQUEST_BYTES) {}

  push(chunk: Buffer): string[] {
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk], this.buffer.byteLength + chunk.byteLength);
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxBytes) throw new Error("Request frame exceeds the byte limit.");
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      lines.push(line.toString("utf8"));
    }
    if (this.buffer.byteLength > this.maxBytes) throw new Error("Request frame exceeds the byte limit.");
    return lines;
  }
}

export function sendJson(socket: Socket, value: unknown, options: { droppable?: boolean } = {}): boolean {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Response frame exceeds the byte limit.");
  if (options.droppable && socket.writableLength > MAX_RESPONSE_BYTES) return false;
  if (socket.writableLength > MAX_RESPONSE_BYTES * 2) throw new Error("Connection output buffer exceeds the byte limit.");
  socket.write(bytes);
  return true;
}
