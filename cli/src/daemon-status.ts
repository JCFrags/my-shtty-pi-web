import net from "node:net";
import { DAEMON_SOCKET } from "pixel-store";

export function daemonRequest(request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(DAEMON_SOCKET);
    let buffer = "";
    const timer = setTimeout(() => finish(Object.assign(new Error("daemon status unavailable"), { code: "ETIMEDOUT" })), 2000);
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(value);
    };
    connection.on("error", (error: NodeJS.ErrnoException) => {
      finish(Object.assign(new Error("daemon status unavailable"), { code: error.code }));
    });
    connection.on("end", () => { if (!buffer.includes("\n")) finish(new Error("daemon status incomplete")); });
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 128 * 1024) { finish(new Error("daemon status exceeds limit")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, newline))); } catch { finish(new Error("invalid daemon status")); }
    });
    connection.once("connect", () => connection.write(`${JSON.stringify(request)}\n`));
  });
}
