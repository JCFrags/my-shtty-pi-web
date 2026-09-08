import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "electron";
import { DAEMON_SOCKET, RUNTIME_IDENTITY, runtimeMatches } from "pixel-store";
import { createSession } from "./session/session";
import type { SessionHandle } from "./session/session";

const IDLE_EXIT_MS = 15_000;
const MAX_REQUEST_BYTES = 256 * 1024;

export function buildStamp(): string { return RUNTIME_IDENTITY.build ?? "unknown"; }

export async function runDaemon(cdpPort: number | null): Promise<void> {
  if (fs.existsSync(DAEMON_SOCKET)) {
    process.stderr.write("daemon socket is occupied or stale; inspect it before explicit recovery\n");
    app.exit(3);
    return;
  }
  fs.mkdirSync(path.dirname(DAEMON_SOCKET), { recursive: true, mode: 0o700 });
  const sessions = new Map<string, SessionHandle>();
  let seq = 0;
  let closing = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const inventory = () => [...sessions.values()].map((session) => session.metadata()).sort((a, b) => a.key.localeCompare(b.key));
  const status = () => ({ identity: RUNTIME_IDENTITY, sessions: inventory(), complete: true });
  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (sessions.size === 0) app.quit(); }, IDLE_EXIT_MS);
  };
  scheduleIdleExit();
  const stopEverything = () => {
    closing = true;
    for (const open of [...sessions.values()]) { try { open.close(); } catch {} }
    app.quit();
  };
  process.on("SIGINT", stopEverything);
  process.on("SIGTERM", stopEverything);
  const server = net.createServer((connection) => {
    let key: string | null = null;
    let session: SessionHandle | null = null;
    const reply = (value: unknown) => { try { connection.write(`${JSON.stringify(value)}\n`); } catch {} };
    let buffer = "";
    connection.setTimeout(5000, () => { if (!session) connection.destroy(); });
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) { connection.destroy(); return; }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: Record<string, any>;
        try { message = JSON.parse(line); } catch { connection.destroy(); return; }
        if (!message || typeof message !== "object") { connection.destroy(); return; }
        if (message.cmd === "hello" || message.cmd === "status") {
          reply({ ok: true, ...status() }); connection.end(); return;
        }
        if (message.cmd === "shutdown") {
          if (closing || JSON.stringify(message.expected) !== JSON.stringify(status())) {
            reply({ ok: false, error: "daemon identity or session inventory changed; request fresh status and approval" });
            connection.end(); return;
          }
          closing = true;
          reply({ ok: true, sessions: sessions.size }); connection.end();
          setTimeout(stopEverything, 50); return;
        }
        if (message.cmd === "open" && !session) {
          if (closing || !runtimeMatches(message.identity) || message.expectedInstance !== RUNTIME_IDENTITY.instanceId) {
            reply({ ok: false, error: "runtime mismatch; explicit replacement approval is required" });
            connection.end(); return;
          }
          if (typeof message.tty !== "string" || !message.tty.startsWith("/dev/")) {
            reply({ ok: false, error: "no tty" }); connection.end(); return;
          }
          if (idleTimer) clearTimeout(idleTimer);
          key = `${process.pid}-${++seq}`;
          const sessionKey = key;
          try {
            session = createSession({
              tty: message.tty, key: sessionKey, argv: message.argv ?? [], env: message.env ?? {}, cwd: message.cwd ?? process.cwd(), cdpPort,
              onClose: (code) => {
                sessions.delete(sessionKey); reply({ event: "closed", code }); connection.end(); scheduleIdleExit();
              },
            });
          } catch {
            reply({ ok: false, error: "session creation failed" }); connection.end(); scheduleIdleExit(); return;
          }
          sessions.set(sessionKey, session);
          reply({ ok: true, session: sessionKey, pid: process.pid });
        } else if (message.cmd === "resize") session?.nudgeResize();
        else if (message.cmd === "close") session?.close();
        else { reply({ ok: false, error: "unsupported daemon request" }); connection.end(); }
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (key && sessions.has(key)) {
        const orphan = sessions.get(key)!; sessions.delete(key); orphan.close(); scheduleIdleExit();
      }
    });
  });
  let ownedSocket: number | undefined;
  server.on("error", () => { process.stderr.write("daemon socket could not be acquired\n"); app.exit(1); });
  server.listen(DAEMON_SOCKET, () => {
    ownedSocket = fs.lstatSync(DAEMON_SOCKET).ino;
    fs.chmodSync(DAEMON_SOCKET, 0o600);
  });
  app.on("will-quit", () => {
    server.close();
    try { if (ownedSocket !== undefined && fs.lstatSync(DAEMON_SOCKET).ino === ownedSocket) fs.unlinkSync(DAEMON_SOCKET); } catch {}
  });
}
