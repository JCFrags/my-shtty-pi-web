#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const host = process.env.PI_WEB_STREAM_VIEWER_HOST || "127.0.0.1";
const port = Number(process.env.PI_WEB_STREAM_VIEWER_PORT || 4180);
const server = createServer((request, response) => {
  const pathname = new URL(request.url || "/", `http://${host}:${port}`).pathname;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  response.writeHead(200, {
    "content-type": extname(file) === ".js" ? "text/javascript" : "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  createReadStream(file)
    .on("error", () => response.writeHead(404).end("not found"))
    .pipe(response);
});
server.listen(port, host, () => {
  const stream = process.argv[2] || "ws://127.0.0.1:9223";
  console.log(`http://${host}:${port}/?ws=${encodeURIComponent(stream)}`);
});
