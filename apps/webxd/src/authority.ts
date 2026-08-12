import type {
  ArtifactExcerpt,
  BoundedContent,
  BrowserAction,
  BrowserSessionRequest,
  CapabilityCatalog,
  ReadRequest,
  ResearchRequest,
  SearchHit,
  SearchRequest,
  TransportRequest,
  TransportResponse,
  Visibility,
  WebxProblem,
} from "../../../packages/sdk/src/index.js";
import { BROWSER_PROTOCOL_VERSION, WEBX_API_VERSION } from "../../../packages/sdk/src/index.js";
import type { AuthorityActor, AuthorityClock, AuthorityIdSource, BrowserDaemonPort, IndexedSource } from "./ports.js";
import { BrowserPortError, isBrowserPathId } from "./ports.js";

const DEFAULT_CONTENT_CHARS = 16_384;
const MAX_CONTENT_CHARS = 100_000;
const MAX_ARTIFACT_BYTES = 65_536;
const VISIBILITY_ORDER: Readonly<Record<Visibility, number>> = { public: 0, internal: 1, private: 2, secret: 3 };

interface StoredArtifact {
  readonly artifactId: string;
  readonly ownerPrincipalId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly content: string;
  readonly visibility: Visibility;
}

interface CachedResult {
  readonly fingerprint: string;
  readonly response: TransportResponse;
}

export interface WebxAuthorityOptions {
  readonly browser: BrowserDaemonPort;
  readonly sources: readonly IndexedSource[];
  readonly artifacts: readonly StoredArtifact[];
  readonly clock: AuthorityClock;
  readonly ids: AuthorityIdSource;
}

export class WebxAuthority {
  readonly #idempotency = new Map<string, CachedResult>();
  readonly #browserOwners = new Map<string, { principalId: string; agentId: string }>();

  constructor(private readonly options: WebxAuthorityOptions) {}

  async handle(actor: AuthorityActor, request: TransportRequest): Promise<TransportResponse> {
    try {
      if (request.signal?.aborted) throw problem(499, "cancelled", "request was cancelled", false);
      const idempotencyKey = header(request, "idempotency-key");
      const mutation = request.method === "POST" || request.method === "DELETE";
      if (mutation && idempotencyKey === undefined) {
        throw problem(400, "missing-idempotency-key", "mutation requires an idempotency key", false);
      }
      const cacheKey = idempotencyKey === undefined ? undefined : `${actor.principalId}\0${actor.agentId}\0${idempotencyKey}`;
      const fingerprint = stableStringify({ method: request.method, path: request.path, body: request.body });
      if (cacheKey !== undefined) {
        const cached = this.#idempotency.get(cacheKey);
        if (cached !== undefined) {
          if (cached.fingerprint !== fingerprint) throw problem(409, "idempotency-conflict", "idempotency key was used for a different request", false);
          return cached.response;
        }
      }
      const response = await this.route(actor, request);
      const bounded = enforceSerializedBound(response, request.maxResponseBytes);
      if (cacheKey !== undefined && mutation && bounded.status >= 200 && bounded.status < 300) {
        this.#idempotency.set(cacheKey, { fingerprint, response: bounded });
      }
      return bounded;
    } catch (error) {
      if (isAuthorityFailure(error)) return boundedFailure(error.status, error.body, request.maxResponseBytes);
      if (error instanceof BrowserPortError) return boundedFailure(error.status, { code: error.code, message: error.message, retryable: error.retryable }, request.maxResponseBytes);
      if (request.signal?.aborted) return boundedFailure(499, { code: "cancelled", message: "request was cancelled", retryable: false }, request.maxResponseBytes);
      return boundedFailure(502, { code: "backend-failure", message: safeMessage(error), retryable: true }, request.maxResponseBytes);
    }
  }

  private async route(actor: AuthorityActor, request: TransportRequest): Promise<TransportResponse> {
    const url = new URL(request.path, "http://webx.local");
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && url.pathname === "/v1/version") {
      return ok({ apiVersion: WEBX_API_VERSION, webxVersion: "0.1.0", browserProtocolVersion: BROWSER_PROTOCOL_VERSION });
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      requireScope(actor, "system.read");
      const paths = await this.options.browser.capabilities(request.signal);
      const catalog: CapabilityCatalog = {
        apiVersion: WEBX_API_VERSION,
        capabilities: ["search", "read", "research", "pages", "artifacts", "browser"].map((id) => ({ id: id as CapabilityCatalog["capabilities"][number]["id"], enabled: true, healthy: id !== "browser" || paths.length === 2 })),
        browserPaths: paths,
      };
      return ok(catalog);
    }
    if (request.method === "POST" && url.pathname === "/v1/search") return ok(this.search(actor, body<SearchRequest>(request), "search.write"));
    if (request.method === "POST" && url.pathname === "/v1/read") return ok(this.read(actor, body<ReadRequest>(request)));
    if (request.method === "POST" && url.pathname === "/v1/research") return ok(this.research(actor, body<ResearchRequest>(request)));
    if (request.method === "GET" && segments[1] === "pages" && segments.length === 3) return ok(this.page(actor, segments[2] ?? ""));
    if (request.method === "GET" && segments[1] === "artifacts" && segments[3] === "excerpt") {
      return ok(this.artifact(actor, segments[2] ?? "", numberQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), numberQuery(url, "max_bytes", 16_384, 1, MAX_ARTIFACT_BYTES)));
    }
    if (segments[1] === "browser") return this.browser(actor, request, segments);
    throw problem(404, "not-found", "operation was not found", false);
  }

  private search(actor: AuthorityActor, request: SearchRequest, scope: string): { query: string; hits: SearchHit[]; truncated: boolean } {
    requireScope(actor, scope);
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 2_000) throw problem(400, "invalid-request", "query must contain 1 to 2000 characters", false);
    const limit = integer(request.limit ?? 10, "limit", 1, 50);
    const requestedVisibility = visibility(request.visibility ?? "public");
    const terms = request.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const matches = this.options.sources.filter((source) => canRead(actor, source.ownerPrincipalId, source.visibility) && VISIBILITY_ORDER[source.visibility] <= VISIBILITY_ORDER[requestedVisibility] && terms.every((term) => `${source.title} ${source.content}`.toLocaleLowerCase().includes(term)));
    const hits = matches.slice(0, limit).map((source, index): SearchHit => ({
      hitId: source.hitId, title: source.title, url: source.url,
      snippet: boundText(source.content, 320).text, rank: index + 1,
      visibility: source.visibility, pageId: source.pageId, artifactId: source.artifactId,
    }));
    return { query: request.query, hits, truncated: matches.length > hits.length };
  }

  private read(actor: AuthorityActor, request: ReadRequest): BoundedContent {
    requireScope(actor, "retrieval.read");
    if ((request.url === undefined) === (request.pageId === undefined)) throw problem(400, "invalid-request", "supply exactly one url or pageId", false);
    const source = request.pageId === undefined ? this.options.sources.find((item) => item.url === request.url) : this.options.sources.find((item) => item.pageId === request.pageId);
    if (source === undefined || !canRead(actor, source.ownerPrincipalId, source.visibility)) throw problem(404, "not-found", "page was not found", false);
    const maxChars = integer(request.maxChars ?? DEFAULT_CONTENT_CHARS, "maxChars", 1, MAX_CONTENT_CHARS);
    const bounded = boundText(source.content, maxChars);
    return { title: source.title, url: source.url, untrustedContent: bounded.text, truncated: bounded.truncated, artifactId: source.artifactId, pageId: source.pageId, visibility: source.visibility };
  }

  private research(actor: AuthorityActor, request: ResearchRequest): { question: string; summary: string; sources: SearchHit[]; truncated: boolean; artifactId?: string } {
    requireScope(actor, "research.write");
    if (typeof request.question !== "string" || request.question.trim().length === 0) throw problem(400, "invalid-request", "question is required", false);
    const search = this.search(actor, { query: request.question, limit: integer(request.maxSources ?? 5, "maxSources", 1, 20), visibility: request.visibility ?? "public" }, "research.write");
    const raw = search.hits.map((hit) => `${hit.title}: ${hit.snippet}`).join("\n");
    const bounded = boundText(raw || "No matching local evidence.", integer(request.maxChars ?? 8_000, "maxChars", 1, MAX_CONTENT_CHARS));
    return { question: request.question, summary: bounded.text, sources: search.hits, truncated: bounded.truncated || search.truncated };
  }

  private page(actor: AuthorityActor, pageId: string): BoundedContent {
    requireScope(actor, "pages.read");
    return this.read({ ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) }, { pageId });
  }

  private artifact(actor: AuthorityActor, artifactId: string, offset: number, maxBytes: number): ArtifactExcerpt {
    requireScope(actor, "artifacts.read");
    const artifact = this.options.artifacts.find((item) => item.artifactId === artifactId);
    if (artifact === undefined || !canRead(actor, artifact.ownerPrincipalId, artifact.visibility)) throw problem(404, "not-found", "artifact was not found", false);
    const bytes = new TextEncoder().encode(artifact.content);
    const end = Math.min(bytes.byteLength, offset + maxBytes);
    const excerpt = new TextDecoder().decode(bytes.slice(offset, end));
    return { artifactId, mediaType: artifact.mediaType, sha256: artifact.sha256, sizeBytes: bytes.byteLength, excerpt, offset, ...(end < bytes.byteLength ? { nextOffset: end } : {}), visibility: artifact.visibility, integrityVerified: true };
  }

  private async browser(actor: AuthorityActor, request: TransportRequest, segments: readonly string[]): Promise<TransportResponse> {
    const sessionId = segments[3];
    if (request.method === "POST" && segments.length === 3 && segments[2] === "sessions") {
      requireScope(actor, "browser.write");
      const input = body<BrowserSessionRequest>(request);
      if (!isBrowserPathId(input.pathId)) throw problem(400, "unsupported", "browser path is not supported", false);
      const session = await this.options.browser.createSession(actor, input, operationId(request), request.signal);
      if (session.pathId !== input.pathId) throw problem(502, "wrong-path", "browser daemon changed the selected path", false);
      this.#browserOwners.set(session.sessionId, { principalId: actor.principalId, agentId: actor.agentId });
      return ok(session, 201);
    }
    if (sessionId !== undefined && segments[2] === "sessions") {
      this.assertBrowserOwner(actor, sessionId);
      if (request.method === "GET" && segments.length === 4) { requireScope(actor, "browser.read"); return ok(await this.options.browser.getSession(actor, sessionId, request.signal)); }
      if (request.method === "DELETE" && segments.length === 4) { requireScope(actor, "browser.write"); await this.options.browser.close(actor, sessionId, request.signal); this.#browserOwners.delete(sessionId); return { status: 204, headers: jsonHeaders() }; }
      if (request.method === "POST" && segments[4] === "observe") {
        requireScope(actor, "browser.read");
        const input = body<{ view?: string; maxChars?: number }>(request);
        return ok(await this.options.browser.observe(actor, sessionId, input.view ?? "main", integer(input.maxChars ?? DEFAULT_CONTENT_CHARS, "maxChars", 1, MAX_CONTENT_CHARS), operationId(request), request.signal));
      }
      if (request.method === "POST" && segments[4] === "frame") {
        requireScope(actor, "browser.read");
        return ok(await this.options.browser.captureFrame(actor, sessionId, operationId(request), request.signal));
      }
      if (request.method === "POST" && segments[4] === "actions") {
        requireScope(actor, "browser.write");
        return ok(await this.options.browser.act(actor, sessionId, body<{ action: BrowserAction }>(request).action, operationId(request), request.signal));
      }
      if (request.method === "POST" && segments[4] === "control") {
        requireScope(actor, "browser.control");
        const controller = body<{ controller: unknown }>(request).controller;
        if (controller !== "human" && controller !== "agent") throw problem(400, "invalid-request", "controller must be human or agent", false);
        return ok(await this.options.browser.setControl(actor, sessionId, controller, operationId(request), request.signal));
      }
    }
    if (request.method === "POST" && segments[2] === "operations" && segments[4] === "cancel") {
      requireScope(actor, "browser.write");
      return ok(await this.options.browser.cancel(actor, segments[3] ?? "", request.signal));
    }
    throw problem(404, "not-found", "browser operation was not found", false);
  }

  private assertBrowserOwner(actor: AuthorityActor, sessionId: string): void {
    const owner = this.#browserOwners.get(sessionId);
    if (owner !== undefined && (owner.principalId !== actor.principalId || owner.agentId !== actor.agentId)) throw problem(403, "wrong-owner", "browser session has a different owner", false);
  }
}

function body<T>(request: TransportRequest): T {
  if (typeof request.body !== "object" || request.body === null) throw problem(400, "invalid-request", "JSON object body is required", false);
  return request.body as T;
}
function requireScope(actor: AuthorityActor, scope: string): void { if (!actor.scopes.has(scope)) throw problem(403, "forbidden", `missing scope: ${scope}`, false); }
function canRead(actor: AuthorityActor, ownerPrincipalId: string, visibilityValue: Visibility): boolean { return visibilityValue === "public" || actor.principalId === ownerPrincipalId; }
function visibility(value: unknown): Visibility { if (value === "public" || value === "internal" || value === "private" || value === "secret") return value; throw problem(400, "invalid-request", "invalid visibility", false); }
function integer(value: number, name: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw problem(400, "invalid-request", `${name} must be an integer from ${minimum} to ${maximum}`, false); return value; }
function numberQuery(url: URL, name: string, fallback: number, minimum: number, maximum: number): number { const raw = url.searchParams.get(name); return integer(raw === null ? fallback : Number(raw), name, minimum, maximum); }
function boundText(value: string, maxChars: number): { text: string; truncated: boolean } { const points = [...value]; return points.length <= maxChars ? { text: value, truncated: false } : { text: points.slice(0, maxChars).join(""), truncated: true }; }
function header(request: TransportRequest, name: string): string | undefined { const entry = Object.entries(request.headers ?? {}).find(([key]) => key.toLocaleLowerCase() === name); return entry?.[1]; }
function operationId(request: TransportRequest): string { const value = header(request, "idempotency-key"); if (value === undefined) throw problem(400, "missing-idempotency-key", "idempotency key is required", false); return `op-${value}`; }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`; return JSON.stringify(value) ?? "undefined"; }
function enforceSerializedBound(response: TransportResponse, maxBytes: number): TransportResponse { if (new TextEncoder().encode(JSON.stringify(response.body ?? null)).byteLength > maxBytes) throw problem(413, "response-too-large", "response exceeds the requested transport bound", false); return response; }
function jsonHeaders(): Readonly<Record<string, string>> { return { "content-type": "application/json" }; }
function ok(bodyValue: unknown, status = 200): TransportResponse { return { status, headers: jsonHeaders(), body: bodyValue }; }
function boundedFailure(status: number, bodyValue: WebxProblem, maxBytes: number): TransportResponse {
  const candidates: readonly unknown[] = [bodyValue, { code: bodyValue.code }, { code: "limit" }, undefined];
  const body = candidates.find((candidate) => new TextEncoder().encode(JSON.stringify(candidate ?? null)).byteLength <= maxBytes);
  return { status, headers: jsonHeaders(), body };
}
interface AuthorityFailure { readonly authorityFailure: true; readonly status: number; readonly body: WebxProblem }
function problem(status: number, code: string, message: string, retryable: boolean): AuthorityFailure { return { authorityFailure: true, status, body: { code, message, retryable } }; }
function isAuthorityFailure(value: unknown): value is AuthorityFailure { return typeof value === "object" && value !== null && (value as { authorityFailure?: unknown }).authorityFailure === true; }
function safeMessage(error: unknown): string { return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 300) : "browser or authority backend failed"; }
