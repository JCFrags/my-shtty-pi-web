import { createHash } from "node:crypto";
import type {
  ArtifactByteExcerpt,
  BoundedContent,
  BrowserAction,
  BrowserDebugRequest,
  BrowserSessionRequest,
  BrowserWorkspaceRequest,
  CapabilityCatalog,
  CrawlRequest,
  CrawlResponse,
  RangeReadRequest,
  RangeReadResponse,
  ReadRequest,
  SearchHit,
  SearchRequest,
  SearchResponse,
  TransportRequest,
  TransportResponse,
  Visibility,
  WebxProblem,
} from "../../../packages/sdk/src/index.js";
import { BROWSER_PROTOCOL_VERSION, WEBX_API_VERSION } from "../../../packages/sdk/src/index.js";
import type { AuthorityActor, AuthorityClock, AuthorityIdSource, BrowserDaemonPort, IndexedSource } from "./ports.js";
import { WebCache } from "./cache.js";
import { BrowserPortError, isBrowserPathId } from "./ports.js";

const DEFAULT_CONTENT_CHARS = 16_384;
const MAX_CONTENT_CHARS = 100_000;
const MAX_ARTIFACT_BINARY_BYTES = 49_152;
const MAX_RANGE_BYTES = 1_048_576;
const MAX_RANGE_REDIRECTS = 10;
const MAX_BINARY_ARTIFACT_COUNT = 64;
const MAX_BINARY_ARTIFACT_BYTES = 33_554_432;
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1_000;
const READ_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

interface RawSearchHit { readonly url?: unknown; readonly title?: unknown; readonly content?: unknown; readonly score?: unknown; readonly publishedDate?: unknown; readonly engines?: unknown }
interface SearchBatch { readonly hits: RawSearchHit[]; readonly searches: number }

interface StoredBinaryArtifact {
  readonly artifactId: string;
  readonly ownerPrincipalId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly visibility: Visibility;
}

interface CachedResult {
  readonly fingerprint: string;
  readonly response: TransportResponse;
}

export interface WebxAuthorityOptions {
  readonly browser: BrowserDaemonPort;
  readonly sources: readonly IndexedSource[];
  readonly clock: AuthorityClock;
  readonly ids: AuthorityIdSource;
  readonly searxUrl?: string;
  readonly readerUrl?: string;
  readonly crawlUrl?: string;
  readonly cacheDirectory?: string;
}

export class WebxAuthority {
  readonly #idempotency = new Map<string, CachedResult>();
  readonly #browserOwners = new Map<string, { principalId: string; agentId: string }>();
  readonly #liveBinaryArtifacts = new Map<string, StoredBinaryArtifact>();
  readonly #cache: WebCache;

  constructor(private readonly options: WebxAuthorityOptions) {
    this.#cache = new WebCache({ directory: options.cacheDirectory });
  }

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
        capabilities: ["search", "read", "browser"].map((id) => ({ id: id as CapabilityCatalog["capabilities"][number]["id"], enabled: true, healthy: id !== "browser" || paths.some((path) => path.pathId === "agent-browser/chrome" && path.visual) })),
        browserPaths: paths,
      };
      return ok(catalog);
    }
    if (request.method === "POST" && url.pathname === "/v1/search") return ok(await this.search(actor, body<SearchRequest>(request), "search.write", request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read") return ok(await this.read(actor, body<ReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read-range") return ok(await this.readRange(actor, body<RangeReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/crawl") return ok(await this.crawl(actor, body<CrawlRequest>(request), request.signal));
    if (request.method === "GET" && segments[1] === "artifacts" && segments[3] === "bytes") {
      return ok(this.artifactBytes(actor, segments[2] ?? "", numberQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), numberQuery(url, "max_bytes", MAX_ARTIFACT_BINARY_BYTES, 1, MAX_ARTIFACT_BINARY_BYTES)));
    }
    if (segments[1] === "browser") return this.browser(actor, request, segments);
    throw problem(404, "not-found", "operation was not found", false);
  }

  private async search(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<SearchResponse> {
    requireScope(actor, scope);
    const key = { formatVersion: 17, request, searxUrl: this.options.searxUrl, readerUrl: this.options.readerUrl };
    const cached = await this.#cache.get<SearchResponse>("search", key);
    if (cached !== undefined) return cached;
    const result = await this.uncachedSearch(actor, request, scope, signal);
    await this.#cache.set("search", key, result, SEARCH_CACHE_TTL_MS).catch(() => undefined);
    return result;
  }

  private async uncachedSearch(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<SearchResponse> {
    requireScope(actor, scope);
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 8_192) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
    if (request.operation !== "links" && request.operation !== "extracts") throw problem(400, "invalid-request", "operation must be links or extracts", false);
    if (request.effort !== "fast" && request.effort !== "quality" && request.effort !== "deep") throw problem(400, "invalid-request", "effort must be fast, quality, or deep", false);
    const queries = request.effort === "fast" ? [request.query] : request.effort === "quality" ? qualitySearchQueries(request.query) : deepSearchQueries(request.query);
    const batches: SearchBatch[] = [];
    const failures: string[] = [];
    for (const query of queries) {
      try { batches.push(await this.searchOne(query, request.domains ?? [], signal)); }
      catch (error) { failures.push(safeMessage(error)); }
    }
    if (batches.every((batch) => batch.hits.length === 0) && failures.length > 0) throw new Error(`search providers returned no results: ${[...new Set(failures)].join("; ")}`);
    const merged = [...new Map(batches.flatMap((batch) => batch.hits).filter((item) => typeof item.url === "string" && typeof item.title === "string").map((item) => [String(item.url).replace(/#.*$/u, ""), item])).values()];
    const candidates = merged.map((item, index) => ({ item, index, score: request.effort !== "fast" ? searchCandidateScore(item, request.query) + freshnessScore(item.publishedDate, request.freshness, this.options.clock.now()) : 0 }));
    if (request.effort !== "fast") candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    const resultLimit = request.operation === "links" ? (request.effort === "deep" ? 20 : 10) : request.effort === "deep" ? 10 : request.effort === "quality" ? 5 : 3;
    const selected = candidates.slice(0, resultLimit);
    let pagesRead = 0;
    const hits: SearchHit[] = [];
    const readerActor = { ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) };
    for (const candidate of selected) {
      const item = candidate.item;
      let title = String(item.title);
      let url = String(item.url);
      let snippet = request.operation === "links"
        ? boundText(typeof item.content === "string" ? item.content : "", 320).text
        : evidenceExcerpt(typeof item.content === "string" ? item.content : "", request.query, 1_200);
      if (request.operation === "extracts") {
        try {
          const page = await this.uncachedRead(readerActor, { url, query: request.query, maxChars: 8_000, maxPages: 1, maxDepth: 0 }, signal);
          pagesRead += 1;
          title = page.title || title;
          url = page.url || url;
          const extracted = evidenceExcerpt(page.untrustedContent, request.query, 1_200);
          if (extracted.length >= 60) snippet = extracted;
        } catch { /* Keep usable discovery results when bounded verification fails. */ }
      }
      if (request.operation === "extracts" && snippet.length < 60) continue;
      hits.push({
        hitId: `search-${createHash("sha256").update(url).digest("hex").slice(0, 20)}`,
        title, url, snippet, rank: hits.length + 1, visibility: "public",
        metadata: { score: item.score, publishedDate: item.publishedDate, engines: item.engines },
      } as SearchHit);
    }
    return { query: request.query, operation: request.operation, effort: request.effort, hits, truncated: merged.length > hits.length, metadata: { searches: batches.reduce((total, batch) => total + batch.searches, 0), pagesRead, linkedDepth: 0, freshnessReranked: request.effort !== "fast" && request.freshness !== undefined } };
  }

  private async searchOne(query: string, requestedDomains: readonly string[], signal?: AbortSignal): Promise<SearchBatch> {
    if (this.options.searxUrl === undefined) {
      const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const hits = this.options.sources.filter((source) => terms.every((term) => `${source.title} ${source.content}`.toLocaleLowerCase().includes(term))).map((source) => ({ url: source.url, title: source.title, content: source.content }));
      return { hits, searches: 1 };
    }
    const domains = [...new Set([...requestedDomains.filter(Boolean), ...searchDomains(query)])];
    const endpoint = new URL("/search", this.options.searxUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "0");
    const wantedDomains = domains.map((domain) => domain.toLocaleLowerCase().replace(/^www\./u, ""));
    const request = async (): Promise<{ eligible: RawSearchHit[]; rawCount: number; unavailable: string[] }> => {
      const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
      const payload = await response.json() as { results?: RawSearchHit[]; unresponsive_engines?: unknown };
      const raw = Array.isArray(payload.results) ? payload.results : [];
      const eligible = raw.filter((item) => {
        if (typeof item.url !== "string" || typeof item.title !== "string") return false;
        try {
          const hostname = new URL(item.url).hostname.toLocaleLowerCase().replace(/^www\./u, "");
          return wantedDomains.length === 0 || wantedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
        } catch { return false; }
      });
      return { eligible, rawCount: raw.length, unavailable: searxUnavailableEngines(payload.unresponsive_engines) };
    };
    const result = await request();
    if (result.rawCount === 0 && result.unavailable.length > 0) throw new Error(`unavailable engines: ${result.unavailable.join(", ")}`);
    return { hits: result.eligible, searches: 1 };
  }

  private async read(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal): Promise<BoundedContent> {
    requireScope(actor, "retrieval.read");
    const key = { formatVersion: 8, principalId: actor.principalId, request, readerUrl: this.options.readerUrl };
    const cached = await this.#cache.get<BoundedContent>("read", key);
    if (cached !== undefined) return cached;
    const result = await this.uncachedRead(actor, request, signal);
    await this.#cache.set("read", key, result, READ_CACHE_TTL_MS).catch(() => undefined);
    return result;
  }

  private async uncachedRead(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal): Promise<BoundedContent> {
    requireScope(actor, "retrieval.read");
    if (typeof request.url !== "string" || request.url.length === 0) throw problem(400, "invalid-request", "url is required", false);
    const crawlPages = integer(request.maxPages ?? 1, "maxPages", 1, 20);
    const crawlDepth = integer(request.maxDepth ?? 0, "maxDepth", 0, 3);
    if (request.contentOffset !== undefined && (crawlPages > 1 || crawlDepth > 0)) {
      throw problem(400, "invalid-request", "contentOffset continues a direct single-page read and cannot be combined with maxPages above 1 or maxDepth above 0", false);
    }
    if (crawlPages > 1 || crawlDepth > 0) {
      const maxChars = integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000);
      const crawled = await this.crawl(actor, { url: request.url, maxPages: crawlPages, maxDepth: crawlDepth, maxChars, sameDomain: request.sameDomain, query: request.query }, signal);
      const successful = crawled.pages.filter((page) => page.ok && page.content);
      const perPageLimit = Math.max(1_500, Math.floor(maxChars / Math.max(1, successful.length)));
      const allContent = successful.map((page, index) => `${successful.length > 1 ? `## ${page.title ?? `Page ${index + 1}`}\n\n` : ""}${request.query ? focusedReadContent(page.content ?? "", request.query, perPageLimit) : cleanMainContent(page.content ?? "")}`).join("\n\n");
      const contentOffset = integer(request.contentOffset ?? 0, "contentOffset", 0, 100_000_000);
      const content = allContent.slice(contentOffset);
      const primary = successful[0];
      return { title: primary?.title ?? `Content from ${request.url}`, url: primary?.url ?? request.url, untrustedContent: content, truncated: crawled.truncated, visibility: "public", metadata: { engine: "crawl4ai", pageCount: crawled.pageCount, contentOffset, nextContentOffset: crawled.truncated ? contentOffset + content.length : null, pages: crawled.pages.map((page) => ({ title: page.title, url: page.url, depth: page.depth, ok: page.ok })) } } as BoundedContent;
    }
    const allSources = this.options.sources;
    const input = request as ReadRequest & { query?: string; view?: string; fields?: readonly string[]; itemOffset?: number; itemLimit?: number; contentOffset?: number };
    const transformed = input.query !== undefined || input.fields !== undefined || input.itemOffset !== undefined || input.itemLimit !== undefined || input.contentOffset !== undefined || (input.view !== undefined && input.view !== "main");
    let source = !transformed ? allSources.find((item) => item.url === request.url) : undefined;
    if (source === undefined && this.options.readerUrl !== undefined) {
      const response = await fetch(new URL("/v1/read", this.options.readerUrl), {
        method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ url: request.url, query: input.query, view: input.view ?? "main", fields: input.fields ?? [], itemOffset: integer(input.itemOffset ?? 0, "itemOffset", 0, 1_000_000), itemLimit: integer(input.itemLimit ?? 50, "itemLimit", 1, 500), contentOffset: integer(input.contentOffset ?? 0, "contentOffset", 0, 100_000_000), maxChars: integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000) }),
      });
      if (!response.ok) {
        const failure = parseReaderFailure(response.status, await response.text());
        throw problem(failure.toolStatus, "read-failed", failure.message, failure.retryable);
      }
      const page = await response.json() as { url?: unknown; title?: unknown; content?: unknown; mediaType?: unknown; source?: unknown; truncated?: unknown; metadata?: unknown };
      if (typeof page.content !== "string") throw new Error("reader returned no text content");
      const digest = createHash("sha256").update(`${request.url}\0${page.content}`).digest("hex");
      source = { hitId: `hit-${digest.slice(0, 20)}`, ownerPrincipalId: actor.principalId, title: typeof page.title === "string" ? page.title : request.url, url: typeof page.url === "string" ? page.url : request.url, content: page.content, visibility: "public" };
      const readerMetadata = typeof page.metadata === "object" && page.metadata !== null ? page.metadata as Record<string, unknown> : {};
      const metadata = { requestedUrl: request.url, finalUrl: source.url, source: page.source, substituted: source.url !== request.url, reader: { ...readerMetadata, truncated: page.truncated === true } };
      const maxChars = integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000);
      const bounded = boundText(source.content, maxChars);
      return { title: source.title, url: source.url, untrustedContent: bounded.text, truncated: bounded.truncated || page.truncated === true, visibility: source.visibility, metadata } as BoundedContent;
    }
    if (source === undefined || !canRead(actor, source.ownerPrincipalId, source.visibility)) throw problem(404, "not-found", "page was not found", false);
    const maxChars = integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000);
    const bounded = boundText(source.content, maxChars);
    return { title: source.title, url: source.url, untrustedContent: bounded.text, truncated: bounded.truncated, visibility: source.visibility } as BoundedContent;
  }

  private async crawl(actor: AuthorityActor, request: CrawlRequest, signal?: AbortSignal): Promise<CrawlResponse> {
    requireScope(actor, "retrieval.read");
    if (this.options.crawlUrl === undefined) throw problem(503, "crawl-unavailable", "Crawl4AI service is unavailable", true);
    assertPublicUrlSyntax(request.url);
    const response = await fetch(new URL("/v1/crawl", this.options.crawlUrl), {
      method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        url: request.url,
        maxPages: integer(request.maxPages ?? 5, "maxPages", 1, 20),
        maxDepth: integer(request.maxDepth ?? 1, "maxDepth", 0, 3),
        maxChars: integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000),
        sameDomain: request.sameDomain ?? true,
        query: request.query,
      }),
    });
    if (!response.ok) {
      const failure = parseReaderFailure(response.status, await response.text());
      throw problem(failure.toolStatus, "crawl-failed", failure.message, failure.retryable);
    }
    return await response.json() as CrawlResponse;
  }

  private async readRange(actor: AuthorityActor, request: RangeReadRequest, signal?: AbortSignal): Promise<RangeReadResponse> {
    requireScope(actor, "retrieval.read");
    if (this.options.readerUrl === undefined) throw problem(503, "range-unavailable", "bounded Range reader is unavailable", true);
    assertPublicUrlSyntax(request.url);
    const offset = integer(request.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    const length = integer(request.length, "length", 1, MAX_RANGE_BYTES);
    if (offset > Number.MAX_SAFE_INTEGER - length) throw problem(400, "invalid-request", "range end exceeds the safe integer bound", false);
    const maxRedirects = integer(request.maxRedirects ?? 4, "maxRedirects", 0, MAX_RANGE_REDIRECTS);
    const response = await fetch(new URL("/v1/read-range", this.options.readerUrl), {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: request.url, offset, length, maxRedirects }),
    });
    if (!response.ok) {
      const failure = parseReaderFailure(response.status, await response.text());
      throw problem(failure.toolStatus, "range-read-failed", failure.message, failure.retryable);
    }
    const value = await response.json() as Record<string, unknown>;
    const requestedUrl = requiredString(value.requestedUrl, "requestedUrl");
    const finalUrl = requiredString(value.finalUrl, "finalUrl");
    if (requestedUrl !== request.url) throw new Error("range reader changed the requested URL");
    assertPublicUrlSyntax(finalUrl);
    if (value.statusCode !== 206) throw new Error("range reader returned a non-206 status");
    const rangeStart = integerValue(value.rangeStart, "rangeStart", 0, Number.MAX_SAFE_INTEGER);
    const rangeEnd = integerValue(value.rangeEnd, "rangeEnd", rangeStart, Number.MAX_SAFE_INTEGER);
    const bodyBytes = integerValue(value.bodyBytes, "bodyBytes", 1, length);
    if (rangeStart !== offset || rangeEnd > offset + length - 1 || bodyBytes !== rangeEnd - rangeStart + 1) {
      throw new Error("range reader returned inconsistent bounds");
    }
    const totalBytes = value.totalBytes === null ? null : integerValue(value.totalBytes, "totalBytes", rangeEnd + 1, Number.MAX_SAFE_INTEGER);
    const contentRange = requiredString(value.contentRange, "contentRange");
    if (contentRange !== `bytes ${rangeStart}-${rangeEnd}/${totalBytes ?? "*"}`) throw new Error("range reader returned inconsistent Content-Range");
    const redirectChain = stringArray(value.redirectChain, "redirectChain", maxRedirects + 1);
    if (redirectChain.length === 0 || redirectChain[0] !== requestedUrl || redirectChain.at(-1) !== finalUrl) throw new Error("range reader returned an inconsistent redirect chain");
    const bytes = decodeCanonicalBase64(requiredString(value.bodyBase64, "bodyBase64"));
    if (bytes.byteLength !== bodyBytes) throw new Error("range reader body length mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (value.sha256 !== digest) throw new Error("range reader body digest mismatch");
    const mediaType = requiredString(value.mediaType, "mediaType");
    const identity = createHash("sha256").update(`${actor.principalId}\0${requestedUrl}\0${rangeStart}\0${digest}`).digest("hex");
    const artifactId = `artifact-range-${identity.slice(0, 32)}`;
    this.#liveBinaryArtifacts.delete(artifactId);
    this.#liveBinaryArtifacts.set(artifactId, {
      artifactId, ownerPrincipalId: actor.principalId, mediaType, sha256: digest,
      bytes: bytes.slice(), visibility: "internal",
    });
    this.pruneBinaryArtifacts();
    return {
      requestedUrl, finalUrl, statusCode: 206, mediaType, contentRange,
      rangeStart, rangeEnd, totalBytes, bodyBytes, sha256: digest, artifactId,
      redirectChain, visibility: "internal", integrityVerified: true,
    };
  }

  private pruneBinaryArtifacts(): void {
    let totalBytes = [...this.#liveBinaryArtifacts.values()].reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
    while (this.#liveBinaryArtifacts.size > MAX_BINARY_ARTIFACT_COUNT || totalBytes > MAX_BINARY_ARTIFACT_BYTES) {
      const oldestId = this.#liveBinaryArtifacts.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = this.#liveBinaryArtifacts.get(oldestId);
      this.#liveBinaryArtifacts.delete(oldestId);
      totalBytes -= oldest?.bytes.byteLength ?? 0;
    }
  }

  private artifactBytes(actor: AuthorityActor, artifactId: string, offset: number, maxBytes: number): ArtifactByteExcerpt {
    requireScope(actor, "artifacts.read");
    const artifact = this.#liveBinaryArtifacts.get(artifactId);
    if (artifact === undefined || !canRead(actor, artifact.ownerPrincipalId, artifact.visibility)) throw problem(404, "not-found", "artifact was not found", false);
    const actual = createHash("sha256").update(artifact.bytes).digest("hex");
    if (actual !== artifact.sha256) {
      this.#liveBinaryArtifacts.delete(artifactId);
      throw problem(500, "artifact-corrupt", "artifact integrity verification failed", false);
    }
    if (offset > artifact.bytes.byteLength) throw problem(416, "invalid-range", "artifact offset exceeds its size", false);
    const end = Math.min(artifact.bytes.byteLength, offset + maxBytes);
    const bodyBase64 = encodeBase64(artifact.bytes.slice(offset, end));
    return {
      artifactId, mediaType: artifact.mediaType, sha256: artifact.sha256,
      sizeBytes: artifact.bytes.byteLength, bodyBase64, offset,
      ...(end < artifact.bytes.byteLength ? { nextOffset: end } : {}),
      visibility: artifact.visibility, integrityVerified: true,
    };
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
function integer(value: number, name: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw problem(400, "invalid-request", `${name} must be an integer from ${minimum} to ${maximum}`, false); return value; }
function integerValue(value: unknown, name: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`range reader ${name} is invalid`); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new Error(`range reader ${name} is invalid`); return value; }
function stringArray(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string")) throw new Error(`range reader ${name} is invalid`);
  const result = value as string[];
  for (const item of result) assertPublicUrlSyntax(item);
  return result;
}
function assertPublicUrlSyntax(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw problem(400, "invalid-request", "URL must be absolute", false); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") throw problem(400, "invalid-request", "URL is not an allowed public HTTP target", false);
}
function decodeCanonicalBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("range reader body is not canonical base64");
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) throw new Error("range reader body is not canonical base64");
  return bytes;
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function numberQuery(url: URL, name: string, fallback: number, minimum: number, maximum: number): number { const raw = url.searchParams.get(name); return integer(raw === null ? fallback : Number(raw), name, minimum, maximum); }
function boundText(value: string, maxChars: number): { text: string; truncated: boolean } { const points = [...value]; return points.length <= maxChars ? { text: value, truncated: false } : { text: points.slice(0, maxChars).join(""), truncated: true }; }

function cleanMainContent(value: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of value.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").split("\n")) {
    const line = raw.trim();
    if (!line || /^(?:skip to|sign in|log in|menu|navigation|privacy policy|terms of service|cookie settings)$/iu.test(line)) continue;
    const key = line.toLocaleLowerCase().replace(/\s+/gu, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function focusedReadContent(value: string, query: string, maxChars: number): string {
  const clean = cleanMainContent(value);
  if (/notable\s+changes/iu.test(query)) {
    const match = clean.match(/(?:^|\n)#{2,4}\s+Notable Changes\s*\n([\s\S]*?)(?=\n#{2,4}\s+Commits|$)/iu);
    if (match?.[1]) {
      const introduction = clean.slice(0, Math.max(0, match.index ?? 0)).split("\n").filter((line) => /^(?:#|.*\b(?:version|release|lts)\b)/iu.test(line)).slice(0, 5).join("\n");
      return boundText(`${introduction}\n\n## Notable Changes\n${match[1].trim()}`.trim(), maxChars).text;
    }
  }
  return evidenceExcerpt(clean, query, maxChars);
}

function evidenceExcerpt(value: string, query: string, maxChars: number): string {
  const clean = cleanMainContent(value);
  const terms = [...new Set(query.toLocaleLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/gu) ?? [])];
  const blocks = clean.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/u).map((item) => item.trim()).filter((item) => item.length >= 20);
  const scored = blocks.map((text, index) => ({ text, index, score: terms.reduce((sum, term) => sum + (text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) }));
  const positive = scored.filter((item) => item.score > 0);
  const ranked = (positive.length >= 2 ? positive : scored)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: string[] = [];
  let length = 0;
  for (const item of ranked) {
    if (selected.includes(item.text)) continue;
    if (selected.length > 0 && length + item.text.length + 2 > maxChars) continue;
    selected.push(item.text);
    length += item.text.length + 2;
    if (length >= maxChars * 0.8 || selected.length >= 10) break;
  }
  return boundText(selected.join("\n\n") || clean, maxChars).text.trim();
}

function qualitySearchQueries(query: string): string[] {
  return searchQueryVariants(query).slice(0, 3);
}

function deepSearchQueries(query: string): string[] {
  return searchQueryVariants(query).slice(0, 5);
}

function searchQueryVariants(query: string): string[] {
  const base = query.trim();
  if (/\bpi\b/iu.test(base)) {
    const rest = base.replace(/\bpi\b/iu, " ").replace(/\s+/gu, " ").trim();
    const suffix = rest ? ` ${rest}` : "";
    return [...new Set([
      base,
      `"Pi coding agent"${suffix}`,
      `Pi package${suffix} site:pi.dev`,
      `Pi extension${suffix} site:github.com`,
      `Pi coding agent${suffix} documentation`,
    ])];
  }
  return [...new Set([base, `${base} official`, `${base} guide`, `${base} documentation`, `${base} GitHub`])];
}

function searxUnavailableEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) && typeof item[0] === "string" ? [`${item[0]}${typeof item[1] === "string" ? ` (${item[1]})` : ""}`] : []);
}

function freshnessScore(value: unknown, freshness: SearchRequest["freshness"], now: string): number {
  if (freshness === undefined || typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  const currentTimestamp = Date.parse(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(currentTimestamp)) return 0;
  const ageDays = (currentTimestamp - timestamp) / (24 * 60 * 60 * 1_000);
  if (ageDays < -2) return 0;
  const windowDays = { day: 1, week: 7, month: 31, year: 366 }[freshness];
  if (ageDays <= windowDays) return 6;
  if (ageDays <= windowDays * 2) return 2;
  return -2;
}

function searchCandidateScore(item: RawSearchHit, query: string): number {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[a-z0-9][a-z0-9.+-]{1,}/gu) ?? [])];
  const title = typeof item.title === "string" ? item.title.toLocaleLowerCase() : "";
  const content = typeof item.content === "string" ? item.content.toLocaleLowerCase() : "";
  const titleMatches = terms.filter((term) => title.includes(term)).length;
  const contentMatches = terms.filter((term) => content.includes(term)).length;
  return titleMatches * 3 + contentMatches + (title.includes(query.toLocaleLowerCase()) ? 8 : 0);
}

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
function searchDomains(query: string): string[] {
  return [...query.matchAll(/(?:^|\s)site:([A-Za-z0-9.-]+)/giu)].map((match) => match[1] ?? "").filter(Boolean);
}
function parseReaderFailure(status: number, raw: string): { toolStatus: number; message: string; retryable: boolean } {
  let detail = "reader failed";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; upstreamStatus?: unknown };
    const nested = typeof parsed.detail === "object" && parsed.detail !== null ? parsed.detail as { detail?: unknown; upstreamStatus?: unknown } : parsed;
    if (typeof nested.detail === "string") detail = nested.detail;
    else if (typeof parsed.detail === "string") detail = parsed.detail;
    if (typeof nested.upstreamStatus === "number" && nested.upstreamStatus >= 400 && nested.upstreamStatus < 600) status = nested.upstreamStatus;
  } catch { /* Return a bounded generic failure. */ }
  detail = detail
    .replace(/https?:\/\/(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?[^\s"']*/giu, "the internal converter")
    .replace(/For more information check:[\s\S]*/giu, "")
    .trim();
  const fallback = status === 413 ? "retry with contentOffset, itemOffset, fields, or a section query" : "retry with a section query, or use browser_open when rendering or interaction is required";
  return { toolStatus: status, message: `content retrieval failed; action=fetch_extract; upstream_status=${status}; limit=${status === 413 ? "response_bytes" : "none reported"}; detail=${detail}; supported_fallback=${fallback}`.slice(0, 500), retryable: status >= 500 || status === 429 };
}
function safeMessage(error: unknown): string { return error instanceof Error && error.message.length > 0 ? error.message.replace(/https?:\/\/(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?[^\s"']*/giu, "internal service").slice(0, 300) : "browser or authority backend failed"; }
