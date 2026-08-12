import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { createAdversarialManifest } from "./adversarial.mjs";
import { AUTH_CANARY, bodies, compressedLargeBody, createManifest, largeBody } from "./content.mjs";

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1"]);
const json = (value) => `${JSON.stringify(value)}\n`;

function assertLocalHost(host) {
  if (!LOCAL_HOSTS.has(host) || isIP(host) === 0) {
    throw new Error(`Fixture origin refuses non-loopback listener: ${host}`);
  }
}

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-webx-fixture": "1",
    ...headers,
  });
  response.end(body);
}

function sendVersioned(request, response, etag, body) {
  if (request.headers["if-none-match"] === etag) {
    return send(response, 304, "text/html; charset=utf-8", "", { etag });
  }
  return send(response, 200, "text/html; charset=utf-8", body, { etag });
}

export function createFixtureOrigin(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  assertLocalHost(host);

  const manifest = createManifest();
  const adversarialManifest = createAdversarialManifest();
  let protectedPackets = 0;
  const sockets = new Set();
  const timers = new Set();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (request.method !== "GET" && !(request.method === "POST" && path === "/protected/reset")) {
      return send(response, 405, "application/json", json({ error: "method_not_allowed" }), { allow: "GET" });
    }
    if (path === "/health") return send(response, 200, "application/json", json({ status: "ok", fixtureVersion: manifest.fixtureVersion }));
    if (path === "/manifest.json") return send(response, 200, "application/json", json(manifest));
    if (path === "/html/static") return sendVersioned(request, response, '"webx-static-v1"', bodies.static);
    if (path === "/html/changed/v1") return sendVersioned(request, response, '"webx-changed-v1"', bodies.changedV1);
    if (path === "/html/changed/v2") return sendVersioned(request, response, '"webx-changed-v2"', bodies.changedV2);
    if (path === "/spa") return send(response, 200, "text/html; charset=utf-8", bodies.spa);
    if (path === "/subresources/app.js") return send(response, 200, "text/javascript; charset=utf-8", bodies.spaScript);
    if (path === "/subresources/style.css") return send(response, 200, "text/css; charset=utf-8", bodies.style);
    if (path === "/redirect/static") return send(response, 302, "text/plain; charset=utf-8", "redirect\n", { location: "/html/static" });
    if (path === "/html/malformed") return send(response, 200, "text/html; charset=utf-8", bodies.malformed);
    if (path === "/bounds/large") return send(response, 200, "application/octet-stream", largeBody);
    if (path === "/bounds/compressed") return send(response, 200, "application/octet-stream", compressedLargeBody, { "content-encoding": "gzip", "x-uncompressed-size": String(largeBody.length) });
    if (path === "/robots.txt") return send(response, 200, "text/plain; charset=utf-8", bodies.robots);
    if (path === "/auth/basic") {
      if (request.headers.authorization !== `Basic ${Buffer.from(`fixture:${AUTH_CANARY}`).toString("base64")}`) {
        return send(response, 401, "application/json", json({ error: "synthetic_auth_required", canaryId: "synthetic-basic-v1" }), { "www-authenticate": 'Basic realm="webx-fixture"' });
      }
      return send(response, 200, "application/json", json({ authenticated: true, principal: "synthetic-fixture" }));
    }
    if (path === "/crawl/") return send(response, 200, "text/html; charset=utf-8", "<h1>Crawl root</h1><a href=\"/crawl/a\">A</a><a href=\"/crawl/b\">B</a>\n");
    if (path === "/crawl/a") return send(response, 200, "text/html; charset=utf-8", "<h1>A</h1><a href=\"/crawl/b\">B</a><a href=\"/crawl/\">root</a>\n");
    if (path === "/crawl/b") return send(response, 200, "text/html; charset=utf-8", "<h1>B</h1><a href=\"/crawl/a\">A</a><a href=\"/crawl/b#duplicate\">B duplicate</a>\n");
    if (path === "/crawl/private") return send(response, 200, "text/html; charset=utf-8", "<h1>Robots denied synthetic page</h1>\n");
    if (path === "/feeds/rss.xml") return send(response, 200, "application/rss+xml; charset=utf-8", bodies.rss);
    if (path === "/feeds/atom.xml") return send(response, 200, "application/atom+xml; charset=utf-8", bodies.atom);
    if (path === "/api/items") return send(response, 200, "application/json", bodies.api);
    if (path === "/security/manifest.json") return send(response, 200, "application/json", json(adversarialManifest));
    if (path === "/security/browser-subresources") return send(response, 200, "text/html; charset=utf-8", bodies.browserSecurity);
    if (path === "/security/redirect/start") return send(response, 302, "text/plain; charset=utf-8", "security redirect\n", { location: "/security/redirect/private" });
    if (path === "/security/redirect/private") return send(response, 302, "text/plain; charset=utf-8", "protected redirect\n", { location: "/protected/resource" });
    if (path === "/protected/counter") return send(response, 200, "application/json", json({ packets: protectedPackets }));
    if (path === "/protected/reset" && request.method === "POST") {
      protectedPackets = 0;
      return send(response, 200, "application/json", json({ packets: protectedPackets }));
    }
    if (path === "/protected/resource") {
      protectedPackets += 1;
      return send(response, 200, "application/json", json({ protected: true, packet: protectedPackets }));
    }
    if (path === "/failure/status/503") return send(response, 503, "text/plain; charset=utf-8", "deterministic unavailable\n", { "retry-after": "7" });
    if (path === "/failure/disconnect") return request.socket.destroy();
    if (path === "/failure/slow") {
      const delayText = url.searchParams.get("ms") ?? "100";
      if (!/^\d{1,4}$/.test(delayText)) return send(response, 400, "application/json", json({ error: "invalid_delay" }));
      const delayMs = Math.min(Number(delayText), 2000);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) send(response, 200, "text/plain; charset=utf-8", `delayed ${delayMs}ms\n`);
      }, delayMs);
      timers.add(timer);
      return;
    }
    return send(response, 404, "application/json", json({ error: "fixture_route_not_found", path }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    manifest,
    adversarialManifest,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string" || !LOCAL_HOSTS.has(address.address)) {
        await this.stop();
        throw new Error("Fixture origin did not bind to a loopback IP address");
      }
      return { host: address.address, port: address.port, origin: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}` };
    },
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
