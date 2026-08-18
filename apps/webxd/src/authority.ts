import { createHash } from "node:crypto";
import type {
  ArtifactExcerpt,
  BoundedContent,
  BrowserAction,
  BrowserDebugRequest,
  BrowserSessionRequest,
  BrowserWorkspaceRequest,
  CapabilityCatalog,
  PageForgetRequest,
  PageLibrarySearchRequest,
  PageLibrarySearchResponse,
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

interface RawSearchHit { readonly url?: unknown; readonly title?: unknown; readonly content?: unknown; readonly score?: unknown; readonly publishedDate?: unknown; readonly engines?: unknown }
interface ParsedSearchQuery { readonly query: string; readonly domains: readonly string[]; readonly phrases: readonly string[]; readonly terms: readonly string[]; readonly requiredTokens: readonly string[] }

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
  readonly searxUrl?: string;
  readonly readerUrl?: string;
}

export class WebxAuthority {
  readonly #idempotency = new Map<string, CachedResult>();
  readonly #browserOwners = new Map<string, { principalId: string; agentId: string }>();
  readonly #forgottenPages = new Set<string>();
  readonly #liveSources = new Map<string, IndexedSource>();
  readonly #liveArtifacts = new Map<string, StoredArtifact>();
  readonly #liveReadMetadata = new Map<string, Readonly<Record<string, unknown>>>();

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
    if (request.method === "POST" && url.pathname === "/v1/search") return ok(await this.search(actor, body<SearchRequest>(request), "search.write", request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read") return ok(await this.read(actor, body<ReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/research") return ok(await this.research(actor, body<ResearchRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/pages/search") return ok(this.searchPages(actor, body<PageLibrarySearchRequest>(request)));
    if (request.method === "DELETE" && url.pathname === "/v1/pages") return ok(this.forgetPage(actor, body<PageForgetRequest>(request)));
    if (request.method === "GET" && segments[1] === "pages" && segments.length === 3) return ok(await this.page(actor, segments[2] ?? "", request.signal));
    if (request.method === "GET" && segments[1] === "artifacts" && segments[3] === "excerpt") {
      return ok(this.artifact(actor, segments[2] ?? "", numberQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), numberQuery(url, "max_bytes", 16_384, 1, MAX_ARTIFACT_BYTES)));
    }
    if (segments[1] === "browser") return this.browser(actor, request, segments);
    throw problem(404, "not-found", "operation was not found", false);
  }

  private async search(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<{ query: string; hits: SearchHit[]; truncated: boolean }> {
    requireScope(actor, scope);
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 8_192) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
    const limit = integer(request.limit ?? 10, "limit", 1, 50);
    const input = request as SearchRequest & { domains?: string[]; freshness?: "day" | "week" | "month" | "year" };
    if (this.options.searxUrl === undefined) {
      const terms = request.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const matches = this.options.sources.filter((source) => terms.every((term) => `${source.title} ${source.content}`.toLocaleLowerCase().includes(term)));
      const hits = matches.slice(0, limit).map((source, index): SearchHit => ({ hitId: source.hitId, title: source.title, url: source.url, snippet: boundText(source.content, 320).text, rank: index + 1, visibility: source.visibility, pageId: source.pageId, artifactId: source.artifactId }));
      return { query: request.query, hits, truncated: matches.length > hits.length };
    }
    const parsedQuery = parseSearchQuery(request.query);
    const domains = [...new Set([...(input.domains?.filter((domain) => domain.length > 0) ?? []), ...parsedQuery.domains])];
    const domainQuery = domains.length === 0 ? "" : ` ${domains.map((domain) => `site:${domain}`).join(" OR ")}`;
    const endpoint = new URL("/search", this.options.searxUrl ?? "http://127.0.0.1:8888");
    endpoint.searchParams.set("q", `${parsedQuery.query}${domainQuery}`.trim());
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "0");
    if (input.freshness !== undefined) endpoint.searchParams.set("time_range", input.freshness);
    const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: Array<{ url?: unknown; title?: unknown; content?: unknown; score?: unknown; publishedDate?: unknown; engines?: unknown }> };
    let raw: RawSearchHit[] = Array.isArray(payload.results) ? payload.results : [];
    const isEligible = (item: RawSearchHit): boolean => {
      if (typeof item.url !== "string" || typeof item.title !== "string") return false;
      if (!searchResultRelevant(item, parsedQuery)) return false;
      if (domains.length === 0) return true;
      try {
        const hostname = new URL(item.url).hostname.toLocaleLowerCase().replace(/^www\./u, "");
        return domains.some((domain) => {
          const wanted = domain.toLocaleLowerCase().replace(/^www\./u, "");
          return hostname === wanted || hostname.endsWith(`.${wanted}`);
        });
      } catch { return false; }
    };
    let eligible = raw.filter(isEligible);
    if (eligible.length === 0 && domains.length > 0) {
      endpoint.searchParams.set("q", parsedQuery.query);
      const fallbackResponse = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
      if (fallbackResponse.ok) {
        const fallback = await fallbackResponse.json() as { results?: RawSearchHit[] };
        raw = Array.isArray(fallback.results) ? fallback.results : [];
        eligible = raw.filter(isEligible);
      }
    }
    const unique = [...new Map(eligible.map((item) => [String(item.url), item])).values()]
      .sort((left, right) => searchResultScore(right, parsedQuery, domains) - searchResultScore(left, parsedQuery, domains));
    const hits: SearchHit[] = unique.slice(0, limit).map((item, index) => ({
      hitId: `search-${createHash("sha256").update(String(item.url)).digest("hex").slice(0, 20)}`,
      title: String(item.title), url: String(item.url), snippet: boundText(typeof item.content === "string" ? item.content : "", 500).text,
      rank: index + 1, visibility: "public",
      metadata: { score: item.score, publishedDate: item.publishedDate, engines: item.engines },
    } as SearchHit));
    return { query: request.query, hits, truncated: unique.length > hits.length };
  }

  private async read(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal): Promise<BoundedContent> {
    requireScope(actor, "retrieval.read");
    if ((request.url === undefined) === (request.pageId === undefined)) throw problem(400, "invalid-request", "supply exactly one url or pageId", false);
    const allSources = [...this.options.sources, ...this.#liveSources.values()];
    let source = request.pageId === undefined ? allSources.find((item) => item.url === request.url) : allSources.find((item) => item.pageId === request.pageId);
    const input = request as ReadRequest & { query?: string; view?: string };
    if (source === undefined && request.url !== undefined && this.options.readerUrl !== undefined) {
      const response = await fetch(new URL("/v1/read", this.options.readerUrl), {
        method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ url: request.url, query: input.query, view: input.view ?? "main", maxChars: integer(request.maxChars ?? DEFAULT_CONTENT_CHARS, "maxChars", 1, 1_000_000) }),
      });
      if (!response.ok) throw new Error(`reader returned HTTP ${response.status}: ${boundText(await response.text(), 500).text}`);
      const page = await response.json() as { url?: unknown; title?: unknown; content?: unknown; mediaType?: unknown; source?: unknown; truncated?: unknown; metadata?: unknown };
      if (typeof page.content !== "string") throw new Error("reader returned no text content");
      const digest = createHash("sha256").update(`${request.url}\0${page.content}`).digest("hex");
      source = { hitId: `hit-${digest.slice(0, 20)}`, ownerPrincipalId: actor.principalId, title: typeof page.title === "string" ? page.title : request.url, url: typeof page.url === "string" ? page.url : request.url, content: page.content, visibility: "public", pageId: `page-${digest}`, artifactId: `artifact-${digest}` };
      this.#liveSources.set(source.pageId, source);
      const readerMetadata = typeof page.metadata === "object" && page.metadata !== null ? page.metadata as Record<string, unknown> : {};
      this.#liveReadMetadata.set(source.pageId, { requestedUrl: request.url, finalUrl: source.url, source: page.source, substituted: source.url !== request.url, reader: readerMetadata });
      this.#liveArtifacts.set(source.artifactId, { artifactId: source.artifactId, ownerPrincipalId: actor.principalId, mediaType: typeof page.mediaType === "string" ? page.mediaType : "text/markdown", sha256: createHash("sha256").update(page.content).digest("hex"), content: page.content, visibility: "public" });
    }
    if (source === undefined || !canRead(actor, source.ownerPrincipalId, source.visibility)) throw problem(404, "not-found", "page was not found", false);
    const maxChars = integer(request.maxChars ?? DEFAULT_CONTENT_CHARS, "maxChars", 1, 1_000_000);
    const bounded = boundText(source.content, maxChars);
    return { title: source.title, url: source.url, untrustedContent: bounded.text, truncated: bounded.truncated, artifactId: source.artifactId, pageId: source.pageId, visibility: source.visibility, metadata: this.#liveReadMetadata.get(source.pageId) } as BoundedContent;
  }

  private async research(actor: AuthorityActor, request: ResearchRequest, signal?: AbortSignal): Promise<{ question: string; summary: string; sources: SearchHit[]; truncated: boolean }> {
    requireScope(actor, "research.write");
    if (typeof request.question !== "string" || request.question.trim().length === 0) throw problem(400, "invalid-request", "question is required", false);
    const input = request as ResearchRequest & { maxPages?: number; maxBytes?: number; maxQueries?: number; mode?: string };
    const pageLimit = integer(input.maxPages ?? (input.mode === "deep" ? 12 : input.mode === "research" ? 8 : 4), "maxPages", 0, 40);
    const queryLimit = integer(input.maxQueries ?? (input.mode === "deep" ? 8 : input.mode === "research" ? 5 : 3), "maxQueries", 1, 24);
    const plans = researchSearchPlans(request.question).slice(0, queryLimit);
    const collected: SearchHit[] = [];
    let searchTruncated = false;
    for (const plan of plans) {
      const result = await this.search(actor, { query: plan.query, limit: Math.max(6, pageLimit), ...(plan.domains.length > 0 ? { domains: plan.domains } : {}) }, "research.write", signal);
      searchTruncated ||= result.truncated;
      for (const hit of result.hits) if (!collected.some((existing) => existing.url === hit.url)) collected.push(hit);
    }
    const sources = collected.slice(0, Math.max(6, pageLimit)).map((hit, index) => ({ ...hit, rank: index + 1 }));
    const sections: string[] = [];
    let readableSources = 0;
    for (const hit of sources.slice(0, pageLimit)) {
      try {
        const perPageChars = Math.min(6_000, Math.floor((input.maxBytes ?? 24_000) / Math.max(1, pageLimit)));
        const page = await this.read({ ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) }, { url: hit.url, maxChars: perPageChars }, signal);
        if (!page.untrustedContent.trim()) continue;
        readableSources += 1;
        sections.push(`## ${page.title}\n${page.url}\n\n${page.untrustedContent}`);
      } catch (error) {
        sections.push(`## ${hit.title}\nSource: ${hit.url}\n\nRead failed: ${safeMessage(error)}`);
      }
    }
    const summary = readableSources >= 2
      ? sections.join("\n\n")
      : `Insufficient relevant evidence. Found ${readableSources} readable source${readableSources === 1 ? "" : "s"}; at least 2 are required.\n\n${sections.join("\n\n")}`;
    const outputLimit = Math.min(MAX_CONTENT_CHARS, input.maxBytes ?? 24_000);
    return { question: request.question, summary: boundText(summary, outputLimit).text, sources, truncated: searchTruncated || summary.length > outputLimit };
  }

  private searchPages(actor: AuthorityActor, request: PageLibrarySearchRequest): PageLibrarySearchResponse {
    requireScope(actor, "pages.read");
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 8_192) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
    const limit = integer(request.limit ?? 10, "limit", 1, 100);
    const query = request.query.toLocaleLowerCase();
    const matches = [...this.options.sources, ...this.#liveSources.values()].filter((source) => source.visibility === "public" && !this.#forgottenPages.has(source.pageId) && `${source.title} ${source.content} ${source.url}`.toLocaleLowerCase().includes(query));
    return {
      query: request.query,
      pages: matches.slice(0, limit).map((source) => ({ pageId: source.pageId, ownerPrincipalId: source.ownerPrincipalId, title: source.title, url: source.url, visibility: source.visibility, artifactId: source.artifactId })),
      truncated: matches.length > limit,
    };
  }

  private forgetPage(actor: AuthorityActor, request: PageForgetRequest): { forgotten: true; pageId: string } {
    requireScope(actor, "pages.write");
    if ((request.pageId === undefined) === (request.url === undefined)) throw problem(400, "invalid-request", "supply exactly one pageId or url", false);
    const sources = [...this.options.sources, ...this.#liveSources.values()];
    const source = request.pageId === undefined ? sources.find((item) => item.url === request.url) : sources.find((item) => item.pageId === request.pageId);
    if (source === undefined || source.visibility !== "public" || source.ownerPrincipalId !== actor.principalId || this.#forgottenPages.has(source.pageId)) throw problem(404, "not-found", "page was not found", false);
    this.#forgottenPages.add(source.pageId);
    return { forgotten: true, pageId: source.pageId };
  }

  private async page(actor: AuthorityActor, pageId: string, signal?: AbortSignal): Promise<BoundedContent> {
    requireScope(actor, "pages.read");
    if (this.#forgottenPages.has(pageId)) throw problem(404, "not-found", "page was not found", false);
    return this.read({ ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) }, { pageId }, signal);
  }

  private artifact(actor: AuthorityActor, artifactId: string, offset: number, maxBytes: number): ArtifactExcerpt {
    requireScope(actor, "artifacts.read");
    const artifact = this.options.artifacts.find((item) => item.artifactId === artifactId) ?? this.#liveArtifacts.get(artifactId);
    if (artifact === undefined || !canRead(actor, artifact.ownerPrincipalId, artifact.visibility)) throw problem(404, "not-found", "artifact was not found", false);
    const bytes = new TextEncoder().encode(artifact.content);
    const end = Math.min(bytes.byteLength, offset + maxBytes);
    const excerpt = new TextDecoder().decode(bytes.slice(offset, end));
    return { artifactId, mediaType: artifact.mediaType, sha256: artifact.sha256, sizeBytes: bytes.byteLength, excerpt, offset, ...(end < bytes.byteLength ? { nextOffset: end } : {}), visibility: artifact.visibility, integrityVerified: true };
  }

  private async browser(actor: AuthorityActor, request: TransportRequest, segments: readonly string[]): Promise<TransportResponse> {
    const sessionId = segments[3];
    if (request.method === "POST" && segments.length === 3 && segments[2] === "workspace") {
      requireScope(actor, "browser.control");
      return ok(await this.options.browser.workspace(actor, body<BrowserWorkspaceRequest>(request), operationId(request), request.signal));
    }
    if (request.method === "GET" && segments.length === 3 && segments[2] === "sessions") {
      requireScope(actor, "browser.read");
      const sessions = await this.options.browser.listSessions(actor, request.signal);
      for (const session of sessions) this.#browserOwners.set(session.sessionId, { principalId: actor.principalId, agentId: actor.agentId });
      return ok({ sessions });
    }
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
      if (request.method === "DELETE" && segments[4] === "tabs" && segments[5] !== undefined) { requireScope(actor, "browser.write"); await this.options.browser.closeTab(actor, sessionId, segments[5], request.signal); return { status: 204, headers: jsonHeaders() }; }
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
      if (request.method === "POST" && segments[4] === "debug") {
        requireScope(actor, "browser.debug");
        const input = body<BrowserDebugRequest>(request);
        if (!isSafeDebugOperation(input.operation)) throw problem(403, "debug-refused", "secret-bearing browser debug operations are refused", false);
        return ok(await this.options.browser.debug(actor, sessionId, input, operationId(request), request.signal));
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

function isSafeDebugOperation(value: unknown): value is BrowserDebugRequest["operation"] {
  return value === "console" || value === "network" || value === "html" || value === "pdf" || value === "record-start" || value === "record-stop";
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
function parseSearchQuery(raw: string): ParsedSearchQuery {
  const domains = [...raw.matchAll(/(?:^|\s)site:([A-Za-z0-9.-]+)/giu)].map((match) => match[1] ?? "").filter(Boolean);
  const phrases = [...raw.matchAll(/"([^"]+)"/gu)].map((match) => (match[1] ?? "").trim().toLocaleLowerCase()).filter(Boolean);
  const query = raw.replace(/(?:^|\s)site:[A-Za-z0-9.-]+/giu, " ").replace(/\s+/gu, " ").trim();
  const terms = query.replace(/"/gu, "").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
  const noise = new Set(["a", "an", "and", "at", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);
  const useful = [...new Set(terms.filter((term) => term.length > 1 && !noise.has(term)))];
  return { query, domains, phrases, terms: useful, requiredTokens: useful.filter((term) => /\d/u.test(term)) };
}
function searchText(item: RawSearchHit): string { return `${String(item.title ?? "")} ${String(item.content ?? "")} ${String(item.url ?? "")}`.toLocaleLowerCase(); }
function searchResultRelevant(item: RawSearchHit, query: ParsedSearchQuery): boolean {
  const text = searchText(item);
  if (query.phrases.some((phrase) => !text.includes(phrase))) return false;
  if (query.requiredTokens.some((token) => !text.includes(token))) return false;
  if (query.terms.length === 0) return true;
  const matched = query.terms.filter((term) => text.includes(term)).length;
  return matched >= Math.max(1, Math.ceil(Math.min(query.terms.length, 6) / 2));
}
function searchResultScore(item: RawSearchHit, query: ParsedSearchQuery, domains: readonly string[]): number {
  const text = searchText(item);
  const title = String(item.title ?? "").toLocaleLowerCase();
  const matched = query.terms.filter((term) => text.includes(term)).length;
  const titleMatches = query.terms.filter((term) => title.includes(term)).length;
  let score = matched * 3 + titleMatches * 5 + query.phrases.filter((phrase) => title.includes(phrase)).length * 10;
  try {
    const hostname = new URL(String(item.url)).hostname.toLocaleLowerCase().replace(/^www\./u, "");
    if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) score += 20;
    if (/\.(?:gov|edu)$/u.test(hostname) || hostname.endsWith(".gov.uk") || hostname.includes("docs.")) score += 5;
  } catch { return score; }
  if (typeof item.score === "number" && Number.isFinite(item.score)) score += Math.min(5, item.score);
  return score;
}
function researchSearchPlans(question: string): Array<{ query: string; domains: string[] }> {
  const normalized = question.toLocaleLowerCase();
  const technologies: Array<{ pattern: RegExp; query: string; domains: string[] }> = [
    { pattern: /\bnode(?:\.js|js)?\b/u, query: "Node.js latest current LTS release", domains: ["nodejs.org"] },
    { pattern: /\brust\b/u, query: "Rust latest stable release", domains: ["rust-lang.org"] },
    { pattern: /\bpython\b/u, query: "Python latest stable release", domains: ["python.org"] },
    { pattern: /\b(?:golang|go programming)\b/u, query: "Go latest stable release", domains: ["go.dev"] },
  ];
  const selected = technologies.filter((item) => item.pattern.test(normalized)).map(({ query, domains }) => ({ query, domains }));
  if (selected.length > 1) return selected;
  return [{ query: researchSearchQuery(question), domains: researchDomains(question) }];
}
function researchDomains(question: string): string[] {
  const normalized = question.toLocaleLowerCase();
  if (normalized.includes("fedora")) return ["fedoraproject.org", "fedoramagazine.org"];
  if (normalized.includes("pi coding agent") || normalized.includes("pi agent")) return ["pi.dev", "github.com"];
  if (normalized.includes("weather") || normalized.includes("forecast")) return ["weather.gov"];
  if (normalized.includes("ecb") || normalized.includes("european central bank")) return ["ecb.europa.eu"];
  return [];
}
function researchSearchQuery(question: string): string {
  const noise = new Set(["a", "an", "and", "are", "be", "before", "can", "do", "find", "for", "from", "how", "identify", "in", "is", "of", "official", "or", "should", "source", "sources", "the", "to", "two", "use", "user", "using", "what", "when", "with"]);
  const terms = question.replace(/[^\p{L}\p{N}._+-]+/gu, " ").trim().split(/\s+/u).filter((term) => term.length > 1 && !noise.has(term.toLocaleLowerCase()));
  return terms.length > 0 ? terms.slice(0, 12).join(" ") : question;
}
function safeMessage(error: unknown): string { return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 300) : "browser or authority backend failed"; }
