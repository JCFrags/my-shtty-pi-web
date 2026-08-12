import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

export const PATHS = ["agent-browser/chrome", "pinchtab/chrome"];
export const PNG = await readFile(new URL("./public-fixture.png", import.meta.url));
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");
const ACTIONS = ["navigate", "click", "fill", "type", "press", "hover", "scroll", "semantic-drag", "select", "wait", "tab-new", "tab-close", "tab-focus", "back", "forward", "reload", "mouse-move", "mouse-down", "mouse-up", "double-click", "wheel", "drag", "key-press", "key-down", "key-up", "text-input", "download"];

export class QualificationRuntime {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.server = undefined;
    this.bindings = new Map();
    this.sessions = new Map();
    this.artifacts = new Map([
      ["artifact-public", { owner: "public", text: "Deterministic public WebX artifact. Exact recovery page two.", visibility: "public" }],
      ["artifact-private", { owner: "fixture-agent-a", text: "PRIVATE_FIXTURE_BODY", visibility: "private" }],
    ]);
    this.routes = [];
    this.cancelledConnections = 0;
    this.counter = 0;
    this.apiVersion = "1.0.0";
  }

  async start() {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, resolve); });
    await chmod(this.socketPath, 0o600);
  }

  async stop() {
    for (const session of this.sessions.values()) session.state = "closed";
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = undefined;
    this.bindings.clear();
    await rm(this.socketPath, { force: true });
  }

  inventory() {
    return {
      remainingHosts: 0,
      remainingSessions: [...this.sessions.values()].filter((item) => item.state !== "closed").length,
      remainingTabs: [...this.sessions.values()].filter((item) => item.state !== "closed").length,
      remainingProcesses: 0,
      remainingTimers: 0,
      cancelledConnections: this.cancelledConnections,
      routeCount: this.routes.length,
    };
  }

  accept(socket) {
    let buffer = "";
    let responded = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      void this.dispatch(JSON.parse(line)).then((response) => {
        responded = true;
        socket.end(`${JSON.stringify(response)}\n`);
      }).catch((error) => {
        responded = true;
        socket.end(`${JSON.stringify(this.failure(400, "fixture-error", error.message))}\n`);
      });
    });
    socket.on("close", () => { if (!responded && buffer.length > 0) this.cancelledConnections += 1; });
    socket.on("error", () => undefined);
  }

  async dispatch(wire) {
    if (wire?.bind?.ownerId) {
      const bindingId = randomBytes(12).toString("hex");
      const bindingSecret = randomBytes(24).toString("hex");
      this.bindings.set(bindingId, { secret: bindingSecret, owner: wire.bind.ownerId });
      return { bindingId, bindingSecret };
    }
    const binding = this.bindings.get(wire?.binding?.bindingId);
    if (!binding || binding.secret !== wire?.binding?.bindingSecret) return this.failure(403, "binding-denied", "invalid actor binding");
    const request = wire.request;
    this.routes.push({ owner: binding.owner, method: request.method, path: request.path });
    return this.route(binding.owner, request);
  }

  route(owner, request) {
    const path = request.path;
    if (request.method === "GET" && path === "/v1/version") return this.ok({ apiVersion: this.apiVersion, webxVersion: "0.1.0", browserProtocolVersion: "2.0.0" });
    if (request.method === "GET" && path === "/v1/capabilities") return this.ok({ apiVersion: this.apiVersion, capabilities: ["search", "read", "research", "pages", "artifacts", "browser"], browserPaths: PATHS.map((pathId) => ({ pathId, actions: ACTIONS, observations: ["main", "interactive", "visual", "full", "diff"], visual: pathId === PATHS[0], touch: false, uploads: false, downloads: true })) });
    if (request.method === "POST" && path === "/v1/search") return this.ok({ results: [{ title: "WebX public fixture", url: "https://fixture.invalid/public", excerpt: `result:${request.body?.query ?? ""}`, artifactId: "artifact-public" }] });
    if (request.method === "POST" && path === "/v1/read") return this.ok({ title: "Public fixture", url: request.body?.url ?? "https://fixture.invalid/public", excerpt: "Public deterministic content", artifactId: "artifact-public" });
    if (request.method === "POST" && path === "/v1/research") return this.ok({ claims: [{ text: "The fixture route was reached.", artifactId: "artifact-public" }] });
    if (request.method === "POST" && path === "/v1/pages/search") return this.ok({ results: [{ pageId: "page-public", title: "Public fixture", visibility: "public" }] });
    if (request.method === "GET" && path.startsWith("/v1/pages/")) return this.ok({ pageId: path.slice(10), title: "Public fixture", content: "Public deterministic content" });
    if (request.method === "DELETE" && path === "/v1/pages") return this.ok({ forgotten: true });
    if (request.method === "GET" && path.startsWith("/v1/artifacts/")) return this.artifact(owner, path);
    if (request.method === "POST" && path === "/v1/browser/sessions") return this.createSession(owner, request.body);
    if (request.method === "GET" && path === "/v1/browser/sessions") return this.ok({ sessions: this.owned(owner) });
    if (request.method === "POST" && path === "/v1/browser/workspace") return this.workspace(owner, request.body);
    const match = /^\/v1\/browser\/sessions\/([^/?]+)(?:\/(observe|frame|actions|debug|control))?$/.exec(path);
    if (match) return this.sessionRoute(owner, decodeURIComponent(match[1]), match[2], request);
    const closeTab = /^\/v1\/browser\/sessions\/([^/]+)\/tabs\/([^/]+)$/.exec(path);
    if (request.method === "DELETE" && closeTab) return this.close(owner, decodeURIComponent(closeTab[1]));
    const cancel = /^\/v1\/browser\/operations\/([^/]+)\/cancel$/.exec(path);
    if (request.method === "POST" && cancel) return this.ok({ operationId: decodeURIComponent(cancel[1]), state: "cancelled" });
    return this.failure(404, "not-found", `fixture route not found: ${request.method} ${path}`);
  }

  createSession(owner, body = {}) {
    if (!PATHS.includes(body.pathId)) return this.failure(400, "unsupported-path", "unsupported path");
    const sessionId = `session-${++this.counter}`;
    const session = { sessionId, tabId: `tab-${this.counter}`, pathId: body.pathId, ownerPrincipalId: owner, ownerAgentId: owner, state: "ready", controller: "agent", controlEpoch: 1, sequence: 1, viewportGeneration: 1, url: body.url ?? "about:blank", capabilities: { pathId: body.pathId, actions: ACTIONS, observations: ["main", "interactive", "visual", "full", "diff"], visual: body.pathId === PATHS[0], touch: false, uploads: false, downloads: true } };
    this.sessions.set(sessionId, session);
    return this.ok(session);
  }

  sessionRoute(owner, sessionId, action, request) {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerPrincipalId !== owner || session.state === "closed") return this.failure(404, "not-found", "owned browser session was not found");
    if (!action && request.method === "GET") return this.ok(session);
    if (!action && request.method === "DELETE") return this.close(owner, sessionId);
    if (action === "observe") return this.ok({ operationId: `operation-${++this.counter}`, address: this.address(session), title: "Deterministic public browser fixture", url: session.url, content: `view:${request.body?.view ?? "main"}; path:${session.pathId}; public fixture`, truncated: false, artifactId: "artifact-public" });
    if (action === "frame") {
      if (session.pathId !== PATHS[0]) return this.failure(400, "unsupported", "visual frame unsupported on fallback");
      return this.ok({ address: this.address(session), mediaType: "image/png", width: 1440, height: 1000, payloadBase64: PNG.toString("base64"), screenshotSha256: PNG_SHA256, screenshotSequence: session.sequence, viewportId: `viewport-${session.sessionId}`, viewportGeneration: session.viewportGeneration });
    }
    if (action === "actions") {
      if (session.controller === "human") return this.ok({ operationId: `operation-${++this.counter}`, state: "queued", postActionEvidence: { controller: "human", dispatched: false } });
      const kind = request.body?.action?.kind;
      if (kind === "touch") return this.failure(400, "unsupported", "touch is unsupported");
      if (request.body?.action?.visualGuard && request.body.action.visualGuard.viewportGeneration !== session.viewportGeneration) return this.failure(409, "stale-visual", "stale visual guard");
      session.sequence += 1;
      return this.ok({ operationId: `operation-${++this.counter}`, state: "succeeded", postActionEvidence: { kind, sequence: session.sequence } });
    }
    if (action === "debug") return this.ok({ operationId: `operation-${++this.counter}`, operation: request.body?.operation, ok: true, data: { publicFixture: true } });
    if (action === "control") { session.controller = request.body?.controller; session.controlEpoch += 1; return this.ok({ sessionId, tabId: session.tabId, controller: session.controller, controlEpoch: session.controlEpoch }); }
    return this.failure(404, "not-found", "unknown session action");
  }

  workspace(owner, body = {}) {
    if (body.action === "list") return this.ok({ action: "list", data: { sessions: this.owned(owner) } });
    const session = body.sessionId ? this.sessions.get(body.sessionId) : this.owned(owner)[0];
    if (session && session.ownerPrincipalId !== owner) return this.failure(404, "not-found", "workspace selection not found");
    if ((body.action === "takeover" || body.action === "return") && session) { session.controller = body.action === "takeover" ? "human" : "agent"; session.controlEpoch += 1; }
    return this.ok({ action: body.action, data: { sessionId: session?.sessionId, controller: session?.controller ?? "agent", controlEpoch: session?.controlEpoch ?? 1 } });
  }

  artifact(owner, path) {
    const id = decodeURIComponent(path.split("/")[3]);
    const artifact = this.artifacts.get(id);
    if (!artifact || (artifact.visibility !== "public" && artifact.owner !== owner)) return this.failure(404, "not-found", "artifact not found");
    const query = new URL(`http://fixture${path}`).searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("max_bytes") ?? 16384);
    const excerpt = artifact.text.slice(offset, offset + limit);
    const nextOffset = offset + excerpt.length < artifact.text.length ? offset + excerpt.length : undefined;
    return this.ok({ artifactId: id, mediaType: "text/markdown", excerpt, sizeBytes: artifact.text.length, sha256: createHash("sha256").update(artifact.text).digest("hex"), ...(nextOffset === undefined ? {} : { nextOffset }) });
  }

  close(owner, sessionId) { const session = this.sessions.get(sessionId); if (!session || session.ownerPrincipalId !== owner) return this.failure(404, "not-found", "session not found"); session.state = "closed"; return this.ok(undefined, 204); }
  owned(owner) { return [...this.sessions.values()].filter((item) => item.ownerPrincipalId === owner && item.state !== "closed"); }
  address(session) { return { sessionId: session.sessionId, tabId: session.tabId, pathId: session.pathId, hostGeneration: 1, engineGeneration: 1, controlEpoch: session.controlEpoch }; }
  ok(body, status = 200) { return { status, headers: { "content-type": "application/json" }, body }; }
  failure(status, code, message) { return { status, headers: { "content-type": "application/json" }, body: { code, message, retryable: false } }; }
}
