#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Coordinator, MockBrowserBackend, RpcError, PROTOCOL_VERSION } from "./core.mjs";

export async function startReferenceServer(options = {}) {
  const runtimeDir = options.runtimeDir ?? (process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "pi-web") : join("/tmp", `pi-web-${process.getuid?.() ?? "user"}`));
  const dataRoot = options.dataRoot ?? (process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "pi-web") : join(process.env.HOME ?? "/tmp", ".local", "share", "pi-web-reference"));
  const socketPath = options.socketPath ?? join(runtimeDir, "browserd.sock");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const workspaceToken = options.workspaceToken ?? randomBytes(32).toString("base64url");
  const coordinator = options.coordinator ?? new Coordinator({ dataRoot, backend: options.backend ?? new MockBrowserBackend() });
  await coordinator.initialize();
  const clients = new Set();
  const eventClients = new Set();
  const onEvent = (event) => {
    const line = `${JSON.stringify(event)}\n`;
    for (const socket of clients) if (!socket.destroyed) socket.write(line);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of eventClients) response.write(payload);
  };
  coordinator.on("event", onEvent);

  const socketServer = createNetServer((socket) => {
    clients.add(socket); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = await dispatchLine(coordinator, line);
        if (response) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise((resolve, reject) => { socketServer.once("error", reject); socketServer.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);

  const httpServer = createHttpServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return json(response, 200, await coordinator.call("system.ping"));
      if (!authorized(request, workspaceToken)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && request.url === "/state") return json(response, 200, await coordinator.call("browser.list", {}));
      if (request.method === "GET" && request.url === "/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "http://localhost" });
        response.write(`event: ready\ndata: ${JSON.stringify({ protocolVersion: PROTOCOL_VERSION })}\n\n`);
        eventClients.add(response); request.on("close", () => eventClients.delete(response)); return;
      }
      if (request.method === "POST" && request.url === "/rpc") {
        const body = await readBody(request, 4 * 1024 * 1024); return json(response, 200, await dispatchRpc(coordinator, JSON.parse(body)));
      }
      json(response, 404, { error: "not found" });
    } catch (error) { json(response, 500, { error: error.message }); }
  });
  const address = await new Promise((resolve, reject) => {
    httpServer.once("error", reject); httpServer.listen(options.httpPort ?? 0, "127.0.0.1", () => resolve(httpServer.address()));
  });
  const httpEndpoint = `http://127.0.0.1:${address.port}`;
  const descriptor = { pid: process.pid, protocolVersion: PROTOCOL_VERSION, socketPath, workspaceEndpoint: httpEndpoint, workspaceToken, eventEndpoint: `${httpEndpoint}/events`, startedAt: new Date().toISOString(), implementation: "node-reference" };
  await writeFile(join(runtimeDir, "browserd.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });

  const sweeper = setInterval(() => coordinator.sweepDisconnected(), 5_000); sweeper.unref();
  const close = async () => {
    clearInterval(sweeper); coordinator.off("event", onEvent);
    for (const socket of clients) socket.destroy(); for (const response of eventClients) response.end();
    await Promise.all([new Promise((resolve) => socketServer.close(resolve)), new Promise((resolve) => httpServer.close(resolve))]);
    await rm(socketPath, { force: true });
  };
  return { coordinator, descriptor, close };
}

async function dispatchLine(coordinator, line) {
  try { return await dispatchRpc(coordinator, JSON.parse(line)); }
  catch (error) { return rpcFailure(null, error instanceof SyntaxError ? new RpcError(-32700, "parse error") : error); }
}
async function dispatchRpc(coordinator, request) {
  if (!request || request.jsonrpc !== "2.0" || request.id === undefined || typeof request.method !== "string") return rpcFailure(request?.id ?? null, new RpcError(-32600, "invalid JSON-RPC request"));
  try { return { jsonrpc: "2.0", id: request.id, result: await coordinator.call(request.method, request.params ?? {}) }; }
  catch (error) { return rpcFailure(request.id, error); }
}
function rpcFailure(id, error) { return { jsonrpc: "2.0", id, error: { code: error instanceof RpcError ? error.code : -32603, message: error.message ?? "internal error", ...(error.data === undefined ? {} : { data: error.data }) } }; }
function authorized(request, token) { return request.headers.authorization === `Bearer ${token}`; }
function json(response, status, value) { response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://localhost" }); response.end(`${JSON.stringify(value)}\n`); }
async function readBody(request, maxBytes) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new Error("request body too large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startReferenceServer();
  console.log(JSON.stringify(server.descriptor));
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
