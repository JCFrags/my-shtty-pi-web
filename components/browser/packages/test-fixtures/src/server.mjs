import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));
const defaultUploadRoot = resolve(process.env.PI_WEB_FIXTURE_UPLOADS || join(process.cwd(), ".fixture-uploads"));
const defaultHost = process.env.PI_WEB_FIXTURE_HOST || "127.0.0.1";
const defaultPort = Number(process.env.PI_WEB_FIXTURE_PORT || 4173);
const downloadBytes = Buffer.from("Pi Web complete fixture download\n", "utf8");
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "ascii");

export function createFixtureServer({ uploadRoot = defaultUploadRoot } = {}) {
  const uploads = resolve(uploadRoot);
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const sessions = new Map();
  const requests = new Map();
  let sessionSequence = 0;
  let requestSequence = 0;
  let uploadSequence = 0;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${defaultHost}:${defaultPort}`}`);
      if (url.pathname === "/health") return json(response, 200, { ok: true });
      if (url.pathname === "/api/login" && request.method === "POST") return login(request, response);
      if (url.pathname === "/api/logout" && request.method === "POST") return logout(request, response);
      if (url.pathname === "/api/me") return me(request, response);
      if (url.pathname === "/api/clients") return clients(request, response);
      if (url.pathname === "/api/download") return download(response);
      if (url.pathname === "/api/upload" && request.method === "POST") return upload(request, response);
      if (url.pathname === "/api/delay") return delayed(request, response, url);
      if (url.pathname === "/api/never") return never(request, response);
      if (url.pathname === "/api/request-status") return requestStatus(response, url);
      if (url.pathname === "/api/dialog") return json(response, 200, { message: "Open a confirmation dialog" });
      if (url.pathname === "/artifacts/text") return text(response, 200, "Deterministic viewer text artifact.\n");
      if (url.pathname === "/artifacts/oversized") return text(response, 200, "0123456789abcdef".repeat(8192));
      if (url.pathname === "/artifacts/pdf") return bytes(response, 200, pdfBytes, "application/pdf");
      if (url.pathname === "/artifacts/image") return serveFile(response, join(root, "viewer", "fixture.svg"));
      if (url.pathname === "/llms.txt") return text(response, 200, "# Pi Web fixture\n\nThis deterministic loopback site exercises browser qualification.\n", "text/plain; charset=utf-8");
      if (url.pathname === "/docs.md") return text(response, 200, "# Fixture documentation\n\nThe Markdown fallback returns main content without browser execution.\n", "text/markdown; charset=utf-8");
      if (url.pathname === "/qualification-journey") return journeyMarker(response, url);

      const route = routeToFile(url.pathname);
      if (!route) return text(response, 404, "not found");
      return serveFile(response, route);
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  async function login(request, response) {
    const payload = JSON.parse((await body(request)).toString("utf8") || "{}");
    if (payload.username !== "pi" || payload.password !== "browser") return json(response, 401, { ok: false });
    const session = `fixture-session-${++sessionSequence}`;
    sessions.set(session, { username: "pi", createdAt: "2026-01-01T00:00:00.000Z" });
    response.setHeader("set-cookie", `pi_fixture_session=${session}; HttpOnly; SameSite=Lax; Path=/`);
    return json(response, 200, { ok: true, username: "pi" });
  }

  function logout(request, response) {
    const session = cookie(request, "pi_fixture_session");
    if (session) sessions.delete(session);
    response.setHeader("set-cookie", "pi_fixture_session=; Max-Age=0; Path=/");
    return json(response, 200, { ok: true });
  }

  function me(request, response) {
    const user = sessions.get(cookie(request, "pi_fixture_session"));
    return user ? json(response, 200, user) : json(response, 401, { error: "authentication required" });
  }

  function clients(request, response) {
    if (!sessions.has(cookie(request, "pi_fixture_session"))) return json(response, 401, { error: "authentication required" });
    return json(response, 200, { connected: 48, accessPoints: 3, gatewayHealth: "Excellent", clients: [
      { name: "Desktop-PC", ip: "192.0.2.10", state: "online" },
      { name: "Laptop", ip: "192.0.2.11", state: "online" },
    ] });
  }

  async function upload(request, response) {
    const sequence = ++uploadSequence;
    const storedName = `upload-${String(sequence).padStart(4, "0")}.bin`;
    const path = join(uploads, storedName);
    const hash = createHash("sha256");
    request.on("data", (chunk) => hash.update(chunk));
    await pipeline(request, createWriteStream(path, { mode: 0o600 }));
    return json(response, 201, {
      ok: true,
      uploadId: `fixture-upload-${String(sequence).padStart(4, "0")}`,
      size: statSync(path).size,
      sha256: hash.digest("hex"),
    });
  }

  function delayed(request, response, url) {
    const delayMs = Math.min(5000, Math.max(0, Number(url.searchParams.get("ms") || 250)));
    const id = registerRequest(response);
    setTimeout(() => {
      const state = requests.get(id);
      if (!state?.disconnected && !response.destroyed) {
        state.completed = true;
        json(response, 200, { requestId: id, completed: true });
      }
    }, delayMs).unref();
  }

  function never(request, response) {
    const id = registerRequest(response);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-fixture-request-id": id });
    response.write(`{"requestId":${JSON.stringify(id)},"pending":true`);
  }

  function registerRequest(response) {
    const id = `fixture-request-${String(++requestSequence).padStart(4, "0")}`;
    const state = { requestId: id, completed: false, disconnected: false, disconnectCount: 0 };
    requests.set(id, state);
    response.once("close", () => {
      if (!state.completed) {
        state.disconnected = true;
        state.disconnectCount += 1;
      }
    });
    return id;
  }

  function requestStatus(response, url) {
    const state = requests.get(url.searchParams.get("id"));
    return state ? json(response, 200, state) : json(response, 404, { error: "request not found" });
  }
}

function routeToFile(pathname) {
  const aliases = {
    "/": "static-site/index.html", "/static": "static-site/index.html", "/spa": "spa/index.html",
    "/canvas": "canvas-app/index.html", "/visual-controls": "visual-controls/index.html",
    "/iframe": "iframe-app/index.html", "/iframe/child": "iframe-app/child.html",
    "/auth": "auth-app/index.html", "/transfers": "uploads-downloads/index.html",
    "/viewer": "viewer/index.html", "/workspace-states": "workspace-states/index.html",
  };
  const relative = aliases[pathname] || pathname.replace(/^\//, "");
  const candidate = normalize(join(root, relative));
  if (!candidate.startsWith(`${root}/`) || !existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  return candidate;
}

async function body(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function journeyMarker(response, url) {
  const caseId = url.searchParams.get("case");
  const state = url.searchParams.get("state");
  if (!["J1", "J2", "J5"].includes(caseId) || !/^[a-z-]{1,40}$/u.test(state || "")) return text(response, 400, "invalid public journey marker");
  const marker = `PI-WEB-JOURNEY:${caseId}:${state}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title><style>html,body{margin:0;background:#f4f7fb;color:#10213b;font:28px sans-serif}.marker{box-sizing:border-box;width:100vw;min-height:180px;padding:28px;background:#d9ebff;border:8px solid #175ea8}.action{margin:24px;padding:24px;border:4px solid #175ea8;background:#fff;font:24px sans-serif}</style></head><body><main class="marker" id="journey-marker"><strong>${marker}</strong><p>Deterministic public qualification evidence.</p></main><button class="action" id="journey-action" onclick="this.textContent='ACTION-COMPLETE:${caseId}'">TEST ACTION ${caseId}</button></body></html>`;
  return text(response, 200, html, "text/html; charset=utf-8");
}

function download(response) {
  return bytes(response, 200, downloadBytes, "text/plain; charset=utf-8", {
    "content-disposition": "attachment; filename=pi-web-complete-fixture.txt",
    "x-content-sha256": createHash("sha256").update(downloadBytes).digest("hex"),
  });
}

function cookie(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function serveFile(response, path) {
  response.writeHead(200, { "content-type": mediaType(path), "cache-control": "no-store" });
  createReadStream(path).pipe(response);
}

function mediaType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream";
}

function json(response, status, value) { return bytes(response, status, Buffer.from(JSON.stringify(value)), "application/json"); }
function text(response, status, value, type = "text/plain; charset=utf-8") { return bytes(response, status, Buffer.from(value), type); }
function bytes(response, status, data, type, headers = {}) {
  response.writeHead(status, { "content-type": type, "content-length": data.length, "cache-control": "no-store", ...headers });
  response.end(data);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createFixtureServer();
  server.listen(defaultPort, defaultHost, () => console.log(JSON.stringify({ ok: true, url: `http://${defaultHost}:${defaultPort}` })));
}
