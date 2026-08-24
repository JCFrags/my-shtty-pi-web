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
interface ParsedSearchQuery { readonly query: string; readonly domains: readonly string[]; readonly phrases: readonly string[]; readonly terms: readonly string[]; readonly requiredTokens: readonly string[] }

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
        capabilities: ["search", "read", "research", "browser"].map((id) => ({ id: id as CapabilityCatalog["capabilities"][number]["id"], enabled: true, healthy: id !== "browser" || paths.some((path) => path.pathId === "agent-browser/chrome" && path.visual) })),
        browserPaths: paths,
      };
      return ok(catalog);
    }
    if (request.method === "POST" && url.pathname === "/v1/search") return ok(await this.search(actor, body<SearchRequest>(request), "search.write", request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read") return ok(await this.read(actor, body<ReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read-range") return ok(await this.readRange(actor, body<RangeReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/crawl") return ok(await this.crawl(actor, body<CrawlRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/research") return ok(await this.research(actor, body<ResearchRequest>(request), request.signal));
    if (request.method === "GET" && segments[1] === "artifacts" && segments[3] === "bytes") {
      return ok(this.artifactBytes(actor, segments[2] ?? "", numberQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), numberQuery(url, "max_bytes", MAX_ARTIFACT_BINARY_BYTES, 1, MAX_ARTIFACT_BINARY_BYTES)));
    }
    if (segments[1] === "browser") return this.browser(actor, request, segments);
    throw problem(404, "not-found", "operation was not found", false);
  }

  private async search(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<{ query: string; hits: SearchHit[]; truncated: boolean }> {
    requireScope(actor, scope);
    const key = { formatVersion: 6, request, searxUrl: this.options.searxUrl };
    const cached = await this.#cache.get<{ query: string; hits: SearchHit[]; truncated: boolean }>("search", key);
    if (cached !== undefined) return cached;
    const result = await this.uncachedSearch(actor, request, scope, signal);
    await this.#cache.set("search", key, result, SEARCH_CACHE_TTL_MS).catch(() => undefined);
    return result;
  }

  private async uncachedSearch(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<{ query: string; hits: SearchHit[]; truncated: boolean }> {
    requireScope(actor, scope);
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 8_192) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
    const limit = integer(request.limit ?? 10, "limit", 1, 50);
    const input = request as SearchRequest & { domains?: string[]; freshness?: "day" | "week" | "month" | "year" };
    if (this.options.searxUrl === undefined) {
      const terms = request.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const matches = this.options.sources.filter((source) => terms.every((term) => `${source.title} ${source.content}`.toLocaleLowerCase().includes(term)));
      const hits = matches.slice(0, limit).map((source, index): SearchHit => ({ hitId: source.hitId, title: source.title, url: source.url, snippet: boundText(source.content, 320).text, rank: index + 1, visibility: source.visibility }));
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
      if (!searchResultRelevant(item, parsedQuery, domains.length > 0)) return false;
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
    const discoveryDomains = domains.length > 0 ? domains : inferredAuthoritativeDomains(parsedQuery.query);
    if (discoveryDomains.length > 0) {
      const authoritative = await authoritativeSearchAdapters(parsedQuery.query, discoveryDomains, signal);
      eligible = [...eligible, ...authoritative.filter((item) => typeof item.url === "string" && typeof item.title === "string")];
      if (eligible.length === 0) raw = authoritative;
    }
    if (eligible.length === 0) {
      eligible = raw.filter((item) => {
        if (typeof item.url !== "string" || typeof item.title !== "string") return false;
        if (domains.length === 0) return true;
        try {
          const hostname = new URL(item.url).hostname.toLocaleLowerCase().replace(/^www\./u, "");
          return domains.some((domain) => hostname === domain.toLocaleLowerCase().replace(/^www\./u, "") || hostname.endsWith(`.${domain.toLocaleLowerCase().replace(/^www\./u, "")}`));
        } catch { return false; }
      });
    }
    eligible = [...eligible, ...staticAuthoritativeHits(parsedQuery.query, domains)];
    const unique = [...new Map(eligible.map((item) => [String(item.url), item])).values()]
      .sort((left, right) => searchResultScore(right, parsedQuery, domains) - searchResultScore(left, parsedQuery, domains));
    let hits: SearchHit[] = unique.slice(0, limit).map((item, index) => ({
      hitId: `search-${createHash("sha256").update(String(item.url)).digest("hex").slice(0, 20)}`,
      title: String(item.title), url: String(item.url), snippet: boundText(typeof item.content === "string" ? item.content : "", 500).text,
      rank: index + 1, visibility: "public",
      metadata: { score: item.score, publishedDate: item.publishedDate, engines: item.engines },
    } as SearchHit));
    const crawlPages = integer(request.crawlPages ?? 0, "crawlPages", 0, 5);
    const crawlDepth = integer(request.crawlDepth ?? 0, "crawlDepth", 0, 1);
    if (crawlPages > 0) {
      const enriched: SearchHit[] = [];
      for (const hit of hits) {
        if (enriched.length < crawlPages) {
          try {
            const crawled = await this.crawl({ ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) }, { url: hit.url, maxPages: 1, maxDepth: crawlDepth, maxChars: 8_000, query: request.query }, signal);
            const content = crawled.pages.find((page) => page.ok && page.content)?.content;
            enriched.push(content ? { ...hit, snippet: evidenceExcerpt(content, request.query, 600) } : hit);
            continue;
          } catch { /* Keep the search result when optional enrichment fails. */ }
        }
        enriched.push(hit);
      }
      hits = enriched;
    }
    return { query: request.query, hits, truncated: unique.length > hits.length };
  }

  private async read(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal): Promise<BoundedContent> {
    requireScope(actor, "retrieval.read");
    const key = { formatVersion: 3, principalId: actor.principalId, request, readerUrl: this.options.readerUrl };
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

  private async research(actor: AuthorityActor, request: ResearchRequest, signal?: AbortSignal): Promise<{ question: string; summary: string; sources: SearchHit[]; truncated: boolean }> {
    requireScope(actor, "research.write");
    if (typeof request.question !== "string" || request.question.trim().length === 0) throw problem(400, "invalid-request", "question is required", false);
    const input = request as ResearchRequest & { maxPages?: number; maxBytes?: number; maxQueries?: number; mode?: string; crawlDepth?: number };
    const pageLimit = integer(input.maxPages ?? (input.mode === "deep" ? 12 : input.mode === "research" ? 8 : 4), "maxPages", 0, 40);
    const queryLimit = integer(input.maxQueries ?? (input.mode === "deep" ? 8 : input.mode === "research" ? 5 : 3), "maxQueries", 1, 24);
    const crawlDepth = integer(input.crawlDepth ?? 0, "crawlDepth", 0, 2);
    const plans = researchSearchPlans(request.question).slice(0, queryLimit);
    const collected: SearchHit[] = researchSeedHits(request.question);
    let searchTruncated = false;
    const perPlanLimit = plans.length > 1 ? 1 : Math.max(2, Math.ceil(Math.max(6, pageLimit) / Math.max(1, plans.length)));
    for (const plan of plans) {
      const result = await this.search(actor, { query: plan.query, limit: perPlanLimit, ...(plan.domains.length > 0 ? { domains: plan.domains } : {}) }, "research.write", signal);
      searchTruncated ||= result.truncated;
      for (const hit of result.hits.slice(0, perPlanLimit)) if (!collected.some((existing) => existing.url === hit.url)) collected.push(hit);
    }
    const sources = collected.slice(0, Math.max(6, pageLimit)).map((hit, index) => ({ ...hit, rank: index + 1 }));
    const evidence: Array<{ source: SearchHit; excerpt: string; directFinding?: string }> = [];
    const failures: string[] = [];
    const readableUrls: string[] = [];
    for (const hit of sources.slice(0, pageLimit)) {
      try {
        const perPageChars = Math.min(6_000, Math.floor((input.maxBytes ?? 24_000) / Math.max(1, pageLimit)));
        let readRequest: ReadRequest & { query?: string; fields?: string[]; itemLimit?: number } = { url: hit.url, maxChars: perPageChars, query: request.question, ...(crawlDepth > 0 ? { maxPages: 3, maxDepth: crawlDepth, sameDomain: true } : {}) };
        if (hit.url === "https://nodejs.org/dist/index.json") readRequest = { url: hit.url, maxChars: perPageChars, fields: ["version", "date", "lts"], itemLimit: 50 };
        if (hit.url.startsWith("https://go.dev/dl/?mode=json")) readRequest = { url: hit.url, maxChars: perPageChars, fields: ["version", "stable"], itemLimit: 10 };
        const page = await this.read({ ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) }, readRequest, signal);
        if (!page.untrustedContent.trim()) continue;
        readableUrls.push(page.url);
        const finding = releaseFinding(page.url, page.untrustedContent);
        const excerpt = finding ?? evidenceExcerpt(page.untrustedContent, request.question, Math.min(1_200, perPageChars));
        if (excerpt) evidence.push({ source: hit, excerpt, ...(finding ? { directFinding: finding } : {}) });
      } catch (error) {
        failures.push(`${hit.title}: ${safeMessage(error)}`);
      }
    }
    const hasPrimaryProcedure = readableUrls.some((url) => {
      try { return new URL(url).hostname === "docs.fedoraproject.org" && /upgrad/iu.test(request.question); } catch { return false; }
    });
    const minimumReadable = hasPrimaryProcedure || evidence.some((item) => item.directFinding) ? 1 : 2;
    const directFindings = [...new Set(evidence.map((item) => item.directFinding).filter((item): item is string => Boolean(item)))];
    const evidenceLines = evidence.map((item, index) => `### [${index + 1}] ${item.source.title}\n${item.excerpt}`);
    const status = evidence.length >= minimumReadable
      ? `Collected ${evidence.length} readable sources.`
      : `Insufficient relevant evidence. Found ${evidence.length} readable source${evidence.length === 1 ? "" : "s"}; at least ${minimumReadable} are required.`;
    const summary = [
      directFindings.length ? `## Direct findings\n${directFindings.map((item) => `- ${item}`).join("\n")}` : "",
      `## Evidence\n${evidenceLines.join("\n\n") || "No relevant readable evidence was found."}`,
      `## Evidence quality\n${status}${failures.length ? ` ${failures.length} source read${failures.length === 1 ? "" : "s"} failed.` : ""}`,
    ].filter(Boolean).join("\n\n");
    const outputLimit = Math.min(MAX_CONTENT_CHARS, input.maxBytes ?? 24_000);
    return { question: request.question, summary: boundText(summary, outputLimit).text, sources: evidence.map((item, index) => ({ ...item.source, rank: index + 1 })), truncated: searchTruncated || summary.length > outputLimit };
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
function staticAuthoritativeHits(query: string, domains: readonly string[]): RawSearchHit[] {
  const normalizedDomains = domains.map((domain) => domain.toLocaleLowerCase().replace(/^www\./u, ""));
  const hits: RawSearchHit[] = [];
  if (/qwen3[\s-]+embedding/iu.test(query)) {
    if (normalizedDomains.length === 0 || normalizedDomains.includes("qwenlm.github.io")) hits.push({ title: "Qwen3 Embedding: Advancing Text Embedding and Reranking Through Foundation Models", url: "https://qwenlm.github.io/blog/qwen3-embedding/", content: "Official Qwen release post for the Qwen3 Embedding and Reranker model series.", engines: ["official-route"] });
    if (normalizedDomains.length === 0 || normalizedDomains.includes("github.com")) hits.push({ title: "QwenLM/Qwen3-Embedding", url: "https://github.com/QwenLM/Qwen3-Embedding", content: "Official Qwen3 Embedding source repository and usage documentation.", engines: ["official-route"] });
    if (normalizedDomains.length === 0 || normalizedDomains.includes("huggingface.co")) hits.push({ title: "Qwen/Qwen3-Embedding-8B", url: "https://huggingface.co/Qwen/Qwen3-Embedding-8B", content: "Official Qwen3 Embedding 8B model card.", engines: ["official-route"] });
  }
  if (normalizedDomains.includes("rust-lang.org") && /release/iu.test(query)) hits.push({ title: "Rust Releases and Release Notes", url: "https://doc.rust-lang.org/releases.html", content: "Official Rust stable release notes and version history.", engines: ["official-route"] });
  if (normalizedDomains.includes("nodejs.org") && /release/iu.test(query)) hits.push({ title: "Node.js Release Index", url: "https://nodejs.org/dist/index.json", content: "Official Node.js current and long-term support release index.", engines: ["official-route"] });
  if (normalizedDomains.includes("python.org") && /release/iu.test(query)) hits.push({ title: "Python Releases and Downloads", url: "https://www.python.org/downloads/", content: "Official Python stable release downloads and version history.", engines: ["official-route"] });
  if (normalizedDomains.includes("go.dev") && /release/iu.test(query)) hits.push({ title: "Go Release Index", url: "https://go.dev/dl/?mode=json", content: "Official Go stable release index.", engines: ["official-route"] });
  return hits;
}

function inferredAuthoritativeDomains(query: string): string[] {
  const domains: string[] = [];
  if (/github|\brepositor(?:y|ies)\b|\bissue\b|source code/iu.test(query)) domains.push("github.com");
  if (/hugging\s*face|model card|\bmodel\b|embedding|transformer/iu.test(query)) domains.push("huggingface.co");
  return domains;
}

function platformSearchQuery(query: string): string {
  return query.replace(/\b(?:official|github|hugging\s*face|repository|repositories|model card|release|issue|issues)\b/giu, " ").replace(/\s+/gu, " ").trim();
}

async function authoritativeSearchAdapters(query: string, domains: readonly string[], signal?: AbortSignal): Promise<RawSearchHit[]> {
  const hits: RawSearchHit[] = [];
  if (domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "fedoraproject.org") && /fedora/iu.test(query) && /upgrad/iu.test(query)) {
    hits.push({
      title: "Upgrading Fedora Linux Using DNF System Plugin",
      url: "https://docs.fedoraproject.org/en-US/quick-docs/upgrading-fedora-offline/",
      content: "Official supported method to upgrade Fedora Workstation to the next release with DNF system-upgrade.",
      engines: ["official-route"],
    });
  }
  const combinedFedoraUpgrade = domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "fedoraproject.org") && /upgrad/iu.test(query);
  if (domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "fedoramagazine.org") && !combinedFedoraUpgrade) {
    const endpoint = new URL("https://fedoramagazine.org/wp-json/wp/v2/search");
    const wordpressQuery = /fedora/iu.test(query) && /upgrad/iu.test(query) ? "Fedora Workstation upgrade" : query.replaceAll('"', "");
    endpoint.searchParams.set("search", wordpressQuery);
    endpoint.searchParams.set("per_page", "20");
    const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
    if (response.ok) {
      const payload = await response.json() as Array<{ title?: unknown; url?: unknown }>;
      if (Array.isArray(payload)) for (const item of payload) hits.push({ title: decodeBasicEntities(String(item.title ?? "")), url: item.url, content: "Official Fedora Magazine search result", engines: ["wordpress-api"] });
    }
  }
  if (domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "ecb.europa.eu")) {
    const endpoint = new URL("https://api.addsearch.com/v1/search/61893af990d2673c4a92b492dd7f6631");
    endpoint.searchParams.set("term", query.replaceAll('"', ""));
    endpoint.searchParams.set("limit", "100");
    const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
    if (response.ok) {
      const payload = await response.json() as { hits?: Array<{ title?: unknown; url?: unknown; meta_description?: unknown; highlight?: unknown }> };
      if (Array.isArray(payload.hits)) for (const item of payload.hits) hits.push({ title: item.title, url: item.url, content: typeof item.meta_description === "string" ? item.meta_description : typeof item.highlight === "string" ? item.highlight : "Official ECB search result", engines: ["ecb-addsearch-api"] });
    }
  }
  if (domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "github.com")) {
    const endpoint = new URL("https://api.github.com/search/repositories");
    endpoint.searchParams.set("q", platformSearchQuery(query));
    endpoint.searchParams.set("per_page", "10");
    const response = await fetch(endpoint, { signal, headers: { accept: "application/vnd.github+json", "user-agent": "Pi-WebX/0.1" } });
    if (response.ok) {
      const payload = await response.json() as { items?: Array<{ full_name?: unknown; html_url?: unknown; description?: unknown; updated_at?: unknown }> };
      if (Array.isArray(payload.items)) for (const item of payload.items) hits.push({ title: item.full_name, url: item.html_url, content: `${String(item.description ?? "GitHub repository")} Updated ${String(item.updated_at ?? "unknown")}.`, engines: ["github-api"] });
    }
    if (/\bissue\b/iu.test(query)) {
      const issuesEndpoint = new URL("https://api.github.com/search/issues");
      issuesEndpoint.searchParams.set("q", `${platformSearchQuery(query)} is:issue`);
      issuesEndpoint.searchParams.set("per_page", "10");
      const issuesResponse = await fetch(issuesEndpoint, { signal, headers: { accept: "application/vnd.github+json", "user-agent": "Pi-WebX/0.1" } });
      if (issuesResponse.ok) {
        const payload = await issuesResponse.json() as { items?: Array<{ title?: unknown; html_url?: unknown; body?: unknown; updated_at?: unknown }> };
        if (Array.isArray(payload.items)) for (const item of payload.items) hits.push({ title: item.title, url: item.html_url, content: `${String(item.body ?? "GitHub issue").slice(0, 500)} Updated ${String(item.updated_at ?? "unknown")}.`, engines: ["github-api"] });
      }
    }
  }
  if (domains.some((domain) => domain.toLocaleLowerCase().replace(/^www\./u, "") === "huggingface.co")) {
    const endpoint = new URL("https://huggingface.co/api/models");
    endpoint.searchParams.set("search", platformSearchQuery(query));
    endpoint.searchParams.set("limit", "10");
    const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
    if (response.ok) {
      const payload = await response.json() as Array<{ modelId?: unknown; id?: unknown; pipeline_tag?: unknown; downloads?: unknown; likes?: unknown }>;
      if (Array.isArray(payload)) for (const item of payload) {
        const id = String(item.modelId ?? item.id ?? "");
        if (id) hits.push({ title: id, url: `https://huggingface.co/${id}`, content: `Hugging Face model. Task: ${String(item.pipeline_tag ?? "unknown")}. Downloads: ${String(item.downloads ?? "unknown")}. Likes: ${String(item.likes ?? "unknown")}.`, engines: ["huggingface-api"] });
      }
    }
  }
  return hits;
}
function decodeBasicEntities(value: string): string {
  return value.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code))).replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#039;", "'");
}
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
function searchResultRelevant(item: RawSearchHit, query: ParsedSearchQuery, domainConstrained: boolean): boolean {
  const text = searchText(item);
  if (query.phrases.some((phrase) => !text.includes(phrase))) return false;
  if (query.requiredTokens.length <= 2 && query.requiredTokens.some((token) => !text.includes(token))) return false;
  if (query.terms.length === 0) return true;
  const matched = query.terms.filter((term) => text.includes(term)).length;
  const threshold = domainConstrained && query.terms.length <= 4 ? Math.max(1, query.terms.length - 1) : 1;
  return matched >= threshold;
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
    if ((query.terms.includes("github") && hostname === "github.com") || (query.terms.some((term) => term === "hugging" || term === "huggingface") && hostname === "huggingface.co")) score += 18;
    if (hostname === "github.com" || hostname === "huggingface.co") score += 2;
    const brand = query.terms[0]?.replace(/\d+$/u, "");
    if (brand && brand.length >= 3 && hostname.split(".").some((label) => label.startsWith(brand))) score += 15;
  } catch { return score; }
  if (Array.isArray(item.engines) && item.engines.includes("official-route")) score += 50;
  if (Array.isArray(item.engines) && (item.engines.includes("github-api") || item.engines.includes("huggingface-api"))) {
    const cleaned = platformSearchQuery(query.query).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
    const titleLeaf = title.split("/").at(-1)?.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
    if (cleaned.length > 0 && titleLeaf === cleaned) score += 20;
  }
  if (typeof item.score === "number" && Number.isFinite(item.score)) score += Math.min(5, item.score);
  return score;
}
function researchSeedHits(question: string): SearchHit[] {
  const normalized = question.toLocaleLowerCase();
  const seeds: Array<{ title: string; url: string }> = [];
  if (/\bnode(?:\.js|js)?\b/u.test(normalized)) seeds.push(
    { title: "Official Node.js Release Index", url: "https://nodejs.org/dist/index.json" },
    { title: "Official Node.js Release Support Policy", url: "https://nodejs.org/en/about/previous-releases" },
  );
  if (/\bpython\b/u.test(normalized)) seeds.push({ title: "Official Python Releases", url: "https://www.python.org/downloads/" });
  if (/\brust\b/u.test(normalized)) seeds.push({ title: "Official Rust Releases", url: "https://doc.rust-lang.org/releases.html" });
  if (/\b(?:golang|go programming)\b/u.test(normalized)) seeds.push({ title: "Official Go Release Index", url: "https://go.dev/dl/?mode=json" });
  return seeds.map((seed, index) => ({ hitId: `research-seed-${index + 1}`, title: seed.title, url: seed.url, snippet: "Official machine-readable release source.", rank: index + 1, visibility: "public" }));
}

function researchSearchPlans(question: string): Array<{ query: string; domains: string[] }> {
  const normalized = question.toLocaleLowerCase();
  if (/qwen3[\s-]+embedding/iu.test(question)) return [
    { query: "Qwen3 Embedding", domains: ["qwenlm.github.io"] },
    { query: "Qwen3-Embedding-8B", domains: ["huggingface.co"] },
    { query: "Qwen3 Embedding", domains: ["github.com"] },
  ];
  const technologies: Array<{ pattern: RegExp; query: string; domains: string[] }> = [
    { pattern: /\bnode(?:\.js|js)?\b/u, query: "Node.js releases", domains: ["nodejs.org"] },
    { pattern: /\brust\b/u, query: "Rust releases", domains: ["rust-lang.org"] },
    { pattern: /\bpython\b/u, query: "Python releases", domains: ["python.org"] },
    { pattern: /\b(?:golang|go(?: programming)?)(?=\s+(?:stable|release|version)|\b)/u, query: "Go releases", domains: ["go.dev"] },
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
function releaseFinding(url: string, content: string): string | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    if (url.includes("nodejs.org/dist/index.json")) {
      const rows = Array.isArray(value)
        ? value.filter((item): item is { version: string; date: string; lts?: unknown } => typeof item === "object" && item !== null && typeof (item as { version?: unknown }).version === "string" && typeof (item as { date?: unknown }).date === "string")
        : projectedRows(value, ["version", "date", "lts"]) as Array<{ version: string; date: string; lts?: unknown }>;
      const latest = rows[0];
      const lts = rows.find((item) => typeof item.lts === "string" && item.lts.length > 0);
      if (latest && lts) return `Node.js latest stable is ${latest.version} (${latest.date}); current LTS is ${lts.version} (${lts.date}, ${String(lts.lts)}).`;
    }
    if (url.startsWith("https://go.dev/dl/")) {
      const rows = Array.isArray(value) ? value : projectedRows(value, ["version", "stable"]);
      const stable = rows.find((item): item is { version: string; stable: true } => typeof item === "object" && item !== null && (item as { stable?: unknown }).stable === true && typeof (item as { version?: unknown }).version === "string");
      if (stable) return `Go latest stable is ${stable.version}.`;
    }
  } catch { /* HTML findings use bounded pattern extraction below. */ }
  if (/^https:\/\/(?:www\.)?nodejs\.org\/en\/about\/previous-releases\/?(?:[?#]|$)/u.test(url) && /production applications should only use/iu.test(content)) {
    return "Production applications should use Active LTS or Maintenance LTS Node.js releases.";
  }
  if (/^https:\/\/(?:www\.)?python\.org\/downloads\/?(?:[?#]|$)/u.test(url)) {
    const match = content.match(/Python\s+(3\.\d+\.\d+)[^\n]*\n?([A-Z][a-z]+\.\s+\d{1,2},\s+\d{4})/u);
    if (match) return `Python latest stable is ${match[1]} (${match[2]}).`;
  }
  return undefined;
}
function projectedRows(value: unknown, keys: readonly string[]): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const length = Math.max(0, ...keys.map((key) => Array.isArray(record[key]) ? record[key].length : 0));
  return Array.from({ length }, (_, index) => Object.fromEntries(keys.map((key) => [key, Array.isArray(record[key]) ? record[key][index] : undefined])));
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
