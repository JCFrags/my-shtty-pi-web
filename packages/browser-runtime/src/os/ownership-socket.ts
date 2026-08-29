import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BrowserProtocolError } from "@webx/browser-protocol";

export interface OwnershipSocketOptions {
  platform?: NodeJS.Platform;
  waitTimeoutMs?: number;
  retryIntervalMs?: number;
}

export interface OwnershipSocketLease {
  readonly abstractName: string;
  readonly keyPath: string;
  release(): Promise<void>;
}

/**
 * Acquire a Linux abstract AF_UNIX socket. The kernel owns its lifetime.
 * The socket is an ownership primitive only. It is not a request transport.
 */
export async function acquireOwnershipSocket(root: string, purpose: string, options: OwnershipSocketOptions = {}): Promise<OwnershipSocketLease> {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Kernel ownership sockets require Linux.");
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(purpose)) throw new BrowserProtocolError("INTERNAL_ERROR", "Invalid ownership purpose.");
  const canonicalRoot = await realpath(root);
  const keyPath = join(canonicalRoot, `.browserd-${purpose}-ownership-key`);
  const key = await readOrCreatePrivateKey(keyPath);
  const uid = process.getuid?.();
  if (uid === undefined) throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Kernel ownership sockets require a Unix user ID.");
  const digest = createHash("sha256").update(`${uid}\0${canonicalRoot}\0${purpose}\0${key}`).digest("hex");
  const wireName = `\0webx-${purpose}-${digest}`;
  const displayName = `@webx-${purpose}-${digest}`;
  const deadline = Date.now() + (options.waitTimeoutMs ?? 0);
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 20);

  while (true) {
    try {
      const server = await bindOwnershipServer(wireName);
      let released = false;
      return {
        abstractName: displayName,
        keyPath,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          await closeServer(server);
        },
      };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      if (Date.now() >= deadline) throw new BrowserProtocolError("OPERATION_CONFLICT", "Kernel ownership is already held.", true);
      await sleep(retryIntervalMs);
    }
  }
}

async function bindOwnershipServer(path: string): Promise<Server> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  server.unref();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onListening = (): void => { cleanup(); resolvePromise(); };
      const cleanup = (): void => { server.off("error", onError); server.off("listening", onListening); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ path });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await closeServer(server).catch(() => undefined);
    throw error;
  }
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function readOrCreatePrivateKey(path: string): Promise<string> {
  const candidate = randomBytes(32).toString("base64url");
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${candidate}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await link(temporary, path);
    return candidate;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Ownership key must be a private regular file.");
  }
  const key = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Ownership key is invalid.");
  return key;
}

function isAddressInUse(error: unknown): boolean { return isRecord(error) && error.code === "EADDRINUSE"; }
function isAlreadyExists(error: unknown): boolean { return isRecord(error) && error.code === "EEXIST"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
