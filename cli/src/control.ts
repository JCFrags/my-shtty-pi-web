import { randomUUID } from "node:crypto";
import net from "node:net";

const MAX_CONTROL_HEADER_BYTES = 256 * 1024;
const MAX_CONTROL_BINARY_BYTES = 2 * 1024 * 1024;

export function control(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = net.connect(socketPath);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("control request timed out"));
    }, timeoutMs);
    let buffer = Buffer.alloc(0);
    let header: {
      id?: string | null;
      ok: boolean;
      data?: unknown;
      error?: string;
      binaryBytes?: number;
    } | null = null;
    let binaryStart = 0;
    const fail = (error: unknown) => {
      clearTimeout(timer);
      connection.destroy();
      reject(error);
    };
    connection.on("error", fail);
    connection.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!header) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.byteLength > MAX_CONTROL_HEADER_BYTES) fail(new Error("control response header is too large"));
          return;
        }
        if (newline > MAX_CONTROL_HEADER_BYTES) {
          fail(new Error("control response header is too large"));
          return;
        }
        try {
          header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } catch (error) {
          fail(error);
          return;
        }
        binaryStart = newline + 1;
        if (!header!.ok) {
          fail(new Error(header!.error ?? "control request failed"));
          return;
        }
        if (header!.id !== id) {
          fail(new Error("response id mismatch"));
          return;
        }
      }
      const response = header;
      if (!response) return;
      const binaryBytes = response.binaryBytes ?? 0;
      if (!Number.isSafeInteger(binaryBytes) || binaryBytes < 0 || binaryBytes > MAX_CONTROL_BINARY_BYTES) {
        fail(new Error("control response image is too large"));
        return;
      }
      if (buffer.byteLength - binaryStart < binaryBytes) return;
      clearTimeout(timer);
      connection.destroy();
      if (binaryBytes > 0 && response.data && typeof response.data === "object") {
        const data = response.data as Record<string, unknown>;
        const visual = data.visual && typeof data.visual === "object"
          ? data.visual as Record<string, unknown>
          : {};
        resolve({
          ...data,
          visual: { ...visual, data: buffer.subarray(binaryStart, binaryStart + binaryBytes) },
        });
      } else {
        resolve(response.data);
      }
    });
    connection.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}
