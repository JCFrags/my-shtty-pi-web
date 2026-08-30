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
  ContentRequest,
  StoredContent,
  RangeReadRequest,
  RangeReadResponse,
  ReadRequest,
  ReadContent,
  ReadFreshness,
  ReadBatchRequest,
  ReadBatchResponse,
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
import { WebCache, type WebCacheOptions } from "./cache.js";
import { ContentEntryTooLargeError, NormalizedContentStore, type ContentRepresentation, type NormalizedContentRecord } from "./content-store.js";
import { BrowserPortError, isBrowserPathId } from "./ports.js";
import { BoundedLocalJsonClient, LOCAL_JSON_LIMITS } from "./local-json-client.js";
import { selectCanonicalPassage } from "./passage-selector.js";

const DEFAULT_CONTENT_CHARS = 16_384;
const MAX_CONTENT_CHARS = 100_000;
const MAX_ARTIFACT_BINARY_BYTES = 49_152;
const MAX_RANGE_BYTES = 1_048_576;
const MAX_RANGE_REDIRECTS = 10;
const MAX_BINARY_ARTIFACT_COUNT = 64;
const MAX_BINARY_ARTIFACT_BYTES = 33_554_432;
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1_000;
const READ_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const SEARCH_RESULT_LIMIT = 10;
const EXTRACT_RESULT_LIMIT = 4;
const EXTRACT_ATTEMPT_LIMIT = 8;
const EXTRACT_READ_CONCURRENCY = 4;
const EXTRACT_PASSAGE_CHARS = 700;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const MAX_AGENT_READ_CONTENT_CHARS = 30_000;
const MAX_STORED_CONTENT_RETRIEVAL_CHARS = 30_000;
const IDEMPOTENCY_MAX_ENTRIES = 1_024;
const IDEMPOTENCY_MAX_BYTES = 16 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1_000;
const IN_FLIGHT_MAX_KEYS = 256;
const READ_BATCH_CONCURRENCY = 3;

interface RawSearchHit { readonly url?: unknown; readonly title?: unknown; readonly content?: unknown; readonly score?: unknown; readonly publishedDate?: unknown; readonly engines?: unknown }
interface SearchBatch { readonly hits: RawSearchHit[]; readonly unavailable: string[] }
interface SearchCandidate { readonly item: RawSearchHit; readonly url: string; readonly score: number; readonly firstIndex: number }
interface ExtractResult { readonly hits: SearchHit[]; readonly pagesRead: number; readonly readAttempts: number; readonly failures: number }

interface StoredBinaryArtifact {
  readonly artifactId: string;
  readonly ownerPrincipalId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly visibility: Visibility;
}

type IdempotencyPolicy = "durable-mutation" | "ephemeral-observation" | "image-read" | "none";
interface CachedResult {
  readonly fingerprint: string;
  readonly response: TransportResponse;
  readonly expiresAt: number;
  readonly bytes: number;
  readonly policy: "durable-mutation";
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
  readonly contentDirectory?: string;
  readonly contentStore?: NormalizedContentStore;
  readonly cacheOptions?: Omit<WebCacheOptions, "directory">;
  readonly idempotencyMaxEntries?: number;
  readonly idempotencyMaxBytes?: number;
  readonly idempotencyTtlMs?: number;
}

export class WebxAuthority {
  readonly #idempotency = new Map<string, CachedResult>();
  readonly #inFlight = new InFlightCoalescer(IN_FLIGHT_MAX_KEYS);
  readonly #browserOwners = new Map<string, { principalId: string; agentId: string }>();
  readonly #liveBinaryArtifacts = new Map<string, StoredBinaryArtifact>();
  readonly #cache: WebCache;
  readonly #content: NormalizedContentStore;
  readonly #localJson = new BoundedLocalJsonClient();
  readonly #idempotencyMaxEntries: number;
  readonly #idempotencyMaxBytes: number;
  readonly #idempotencyTtlMs: number;
  #idempotencyBytes = 0;

  constructor(private readonly options: WebxAuthorityOptions) {
    this.#cache = new WebCache({ directory: options.cacheDirectory, ...options.cacheOptions });
    this.#content = options.contentStore ?? new NormalizedContentStore({ directory: options.contentDirectory });
    this.#idempotencyMaxEntries = positiveOption(options.idempotencyMaxEntries ?? IDEMPOTENCY_MAX_ENTRIES, "idempotencyMaxEntries");
    this.#idempotencyMaxBytes = positiveOption(options.idempotencyMaxBytes ?? IDEMPOTENCY_MAX_BYTES, "idempotencyMaxBytes");
    this.#idempotencyTtlMs = positiveOption(options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS, "idempotencyTtlMs");
  }

  get idempotencyStats(): { readonly byPolicy: Readonly<Record<"durable-mutation" | "ephemeral-observation" | "image-read", { readonly entries: number; readonly bytes: number }>>; readonly imageBytesRetained: 0 } {
    this.pruneIdempotency();
    return { byPolicy: { "durable-mutation": { entries: this.#idempotency.size, bytes: this.#idempotencyBytes }, "ephemeral-observation": { entries: 0, bytes: 0 }, "image-read": { entries: 0, bytes: 0 } }, imageBytesRetained: 0 };
  }

  async handle(actor: AuthorityActor, request: TransportRequest): Promise<TransportResponse> {
    try {
      if (request.signal?.aborted) throw problem(499, "cancelled", "request was cancelled", false);
      const idempotencyKey = header(request, "idempotency-key");
      const mutation = request.method === "POST" || request.method === "DELETE";
      const policy = idempotencyPolicy(request);
      if (mutation && idempotencyKey === undefined) {
        throw problem(400, "missing-idempotency-key", "mutation requires an idempotency key", false);
      }
      const cacheKey = idempotencyKey === undefined ? undefined : `${actor.principalId}\0${actor.agentId}\0${idempotencyKey}`;
      const fingerprint = stableStringify({ method: request.method, path: request.path, body: request.body });
      if (cacheKey !== undefined && policy === "durable-mutation") {
        const cached = this.#idempotency.get(cacheKey);
        if (cached !== undefined) {
          if (cached.expiresAt <= Date.now()) this.removeIdempotency(cacheKey, cached);
          else {
            if (cached.fingerprint !== fingerprint) throw problem(409, "idempotency-conflict", "idempotency key was used for a different request", false);
            this.#idempotency.delete(cacheKey);
            this.#idempotency.set(cacheKey, cached);
            return cached.response;
          }
        }
      }
      const response = await this.route(actor, request);
      const bounded = enforceSerializedBound(response, request.maxResponseBytes);
      if (cacheKey !== undefined && policy === "durable-mutation" && bounded.status >= 200 && bounded.status < 300) this.rememberIdempotency(cacheKey, fingerprint, bounded);
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
      const [search, read, browser] = await Promise.all([
        this.searchHealth(request.signal),
        this.readHealth(request.signal),
        this.browserHealth(request.signal),
      ]);
      const catalog: CapabilityCatalog = {
        apiVersion: WEBX_API_VERSION,
        capabilities: [
          { id: "search", enabled: search.enabled, healthy: search.healthy, ...(search.reason === undefined ? {} : { reason: search.reason }) },
          { id: "read", enabled: read.enabled, healthy: read.healthy, ...(read.reason === undefined ? {} : { reason: read.reason }) },
          { id: "browser", enabled: true, healthy: browser.healthy, ...(browser.reason === undefined ? {} : { reason: browser.reason }) },
        ],
        browserPaths: browser.paths,
      };
      return ok(catalog);
    }
    if (request.method === "POST" && url.pathname === "/v1/search") return ok(await this.search(actor, body<SearchRequest>(request), "search.write", request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read") return ok(await this.read(actor, body<ReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/read-batch") return ok(await this.readBatch(actor, body<ReadBatchRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/content") return ok(await this.content(actor, body<ContentRequest>(request)));
    if (request.method === "POST" && url.pathname === "/v1/read-range") return ok(await this.readRange(actor, body<RangeReadRequest>(request), request.signal));
    if (request.method === "POST" && url.pathname === "/v1/crawl") return ok(await this.crawl(actor, body<CrawlRequest>(request), request.signal));
    if (request.method === "GET" && segments[1] === "artifacts" && segments[3] === "bytes") {
      return ok(this.artifactBytes(actor, segments[2] ?? "", numberQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), numberQuery(url, "max_bytes", MAX_ARTIFACT_BINARY_BYTES, 1, MAX_ARTIFACT_BINARY_BYTES)));
    }
    if (segments[1] === "browser") return this.browser(actor, request, segments);
    throw problem(404, "not-found", "operation was not found", false);
  }

  private async searchHealth(signal?: AbortSignal): Promise<{ enabled: boolean; healthy: boolean; reason?: string }> {
    if (this.options.searxUrl === undefined) return { enabled: this.options.sources.length > 0, healthy: this.options.sources.length > 0 };
    try {
      const response = await this.#localJson.request<unknown>(new URL("/config", this.options.searxUrl), {}, LOCAL_JSON_LIMITS.health, signal);
      if (!response.ok) return { enabled: true, healthy: false, reason: `search backend returned HTTP ${response.status}` };
      if (response.payload === undefined) return { enabled: true, healthy: false, reason: "search backend returned an invalid health response" };
      return { enabled: true, healthy: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { enabled: true, healthy: false, reason: `search backend is unavailable: ${safeMessage(error)}` };
    }
  }

  private async readHealth(signal?: AbortSignal): Promise<{ enabled: boolean; healthy: boolean; reason?: string }> {
    if (this.options.readerUrl === undefined) return { enabled: this.options.sources.length > 0, healthy: this.options.sources.length > 0 };
    try {
      const response = await this.#localJson.request<{ ok?: unknown }>(new URL("/health", this.options.readerUrl), {}, LOCAL_JSON_LIMITS.health, signal);
      if (!response.ok) return { enabled: true, healthy: false, reason: `reader returned HTTP ${response.status}` };
      if (response.payload?.ok !== true) return { enabled: true, healthy: false, reason: "reader returned an invalid health response" };
      return { enabled: true, healthy: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { enabled: true, healthy: false, reason: `reader is unavailable: ${safeMessage(error)}` };
    }
  }

  private async browserHealth(signal?: AbortSignal): Promise<{ healthy: boolean; paths: CapabilityCatalog["browserPaths"]; reason?: string }> {
    const probeSignal = healthProbeSignal(signal);
    try {
      const paths = await this.options.browser.capabilities(probeSignal);
      const healthy = paths.some((path) => (path.pathId === "agentcursor/chrome" || path.pathId === "agent-browser/chrome") && path.visual);
      return healthy ? { healthy, paths } : { healthy, paths, reason: "required visual browser path is unavailable" };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { healthy: false, paths: [], reason: `browser daemon is unavailable: ${safeMessage(error)}` };
    }
  }

  private async search(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<SearchResponse> {
    requireScope(actor, scope);
    const key = { formatVersion: 22, request, searxUrl: this.options.searxUrl, readerUrl: this.options.readerUrl };
    const cached = await this.#cache.get<SearchResponse>("search", key);
    if (cached !== undefined) return withSearchDelivery(cached, "hit", false);
    const flightKey = `search\0${createHash("sha256").update(stableStringify({ principalId: actor.principalId, key })).digest("hex")}`;
    const shared = await this.#inFlight.run(flightKey, signal, (sharedSignal) => this.uncachedSearch(actor, request, scope, sharedSignal));
    await this.#cache.set("search", key, shared.value, SEARCH_CACHE_TTL_MS).catch(() => undefined);
    return withSearchDelivery(shared.value, "miss", shared.coalesced);
  }

  private async uncachedSearch(actor: AuthorityActor, request: SearchRequest, scope: string, signal?: AbortSignal): Promise<SearchResponse> {
    requireScope(actor, scope);
    assertSearchRequestKeys(request);
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 8_192) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
    const output = request.output ?? "links";
    if (output !== "links" && output !== "extracts") throw problem(400, "invalid-request", "output must be links or extracts", false);
    const queryDomains = searchDomains(request.query);
    const domains = resolveSearchDomains(request.domains ?? [], queryDomains);
    const batches: SearchBatch[] = [];
    const failures: string[] = [];
    let searches = 0;
    const runSearch = async (query: string): Promise<SearchBatch | undefined> => {
      searches += 1;
      try {
        const batch = await this.searchOne(query, domains, signal);
        batches.push(batch);
        return batch;
      } catch (error) {
        failures.push(safeMessage(error));
        return undefined;
      }
    };

    const primary = await runSearch(request.query.trim());
    const fallbackQuery = stripSiteOperators(request.query);
    const fallbackUsed = (primary?.hits.length ?? 0) === 0 && queryDomains.length > 0 && fallbackQuery.length > 0 && fallbackQuery !== request.query.trim();
    if (fallbackUsed) await runSearch(fallbackQuery);

    const candidates = rankSearchCandidates(batches, request.query);
    if (candidates.length === 0 && failures.length > 0) throw new Error(`search providers returned no results: ${[...new Set(failures)].join("; ")}`);
    const providerWarnings = [...new Set(batches.flatMap((batch) => batch.unavailable))];
    let hits: SearchHit[];
    let pagesRead = 0;
    let readAttempts = 0;
    let extractionFailures = 0;
    if (output === "extracts") {
      const extracted = await this.extractSearchHits(actor, candidates, domains, request.query, signal);
      hits = extracted.hits;
      pagesRead = extracted.pagesRead;
      readAttempts = extracted.readAttempts;
      extractionFailures = extracted.failures;
    } else {
      hits = candidates.slice(0, SEARCH_RESULT_LIMIT).map((candidate, index) => ({
        hitId: searchHitId(candidate.url),
        title: String(candidate.item.title),
        url: candidate.url,
        snippet: boundText(typeof candidate.item.content === "string" ? candidate.item.content : "", 360).text.trim(),
        rank: index + 1,
        visibility: "public",
      }));
    }
    return {
      query: request.query, output, hits, truncated: candidates.length > hits.length,
      metadata: {
        searches, fallbackUsed,
        partial: failures.length > 0 || providerWarnings.length > 0 || extractionFailures > 0,
        pagesRead, readAttempts,
        ...(output === "extracts" ? {
          warning: "output=extracts is deprecated and remains available through the current 0.x API line.",
          migration: "Use web_search links, select sources, call web_read_batch, then use web_content for focus or continuation.",
        } : {}),
      },
    };
  }

  private async extractSearchHits(actor: AuthorityActor, candidates: readonly SearchCandidate[], domains: readonly string[], query: string, signal?: AbortSignal): Promise<ExtractResult> {
    const readerActor = { ...actor, scopes: new Set([...actor.scopes, "retrieval.read"]) };
    const selected: SearchHit[] = [];
    const seen = new Set<string>();
    let pagesRead = 0;
    let readAttempts = 0;
    let failures = 0;
    const attempted = candidates.slice(0, EXTRACT_ATTEMPT_LIMIT);
    for (let offset = 0; offset < attempted.length && selected.length < EXTRACT_RESULT_LIMIT; offset += EXTRACT_READ_CONCURRENCY) {
      const chunk = attempted.slice(offset, offset + EXTRACT_READ_CONCURRENCY);
      readAttempts += chunk.length;
      const outcomes = await boundedOrderedFanOut(chunk, EXTRACT_READ_CONCURRENCY, async (candidate): Promise<{ pageRead: boolean; hit?: SearchHit }> => {
        try {
          const page = await this.uncachedRead(readerActor, { url: candidate.url, query: stripSiteOperators(query), maxChars: EXTRACT_PASSAGE_CHARS }, signal, false);
          const url = normalizeSearchUrl(page.url || candidate.url);
          if (url === undefined || !urlMatchesDomains(url, domains)) return { pageRead: true };
          const snippet = page.untrustedContent;
          if (snippet.length < 60) return { pageRead: true };
          return {
            pageRead: true,
            hit: { hitId: searchHitId(url), title: page.title || String(candidate.item.title), url, snippet, rank: 0, visibility: "public" },
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          return { pageRead: false };
        }
      });
      for (const outcome of outcomes) {
        if (outcome.pageRead) pagesRead += 1;
        if (outcome.hit === undefined) failures += 1;
      }
      for (const outcome of outcomes) {
        if (outcome.hit === undefined || selected.length >= EXTRACT_RESULT_LIMIT) continue;
        const key = canonicalSearchUrl(outcome.hit.url);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push({ ...outcome.hit, rank: selected.length + 1 });
      }
    }
    return { hits: selected, pagesRead, readAttempts, failures };
  }

  private async searchOne(query: string, domains: readonly string[], signal?: AbortSignal): Promise<SearchBatch> {
    if (this.options.searxUrl === undefined) {
      const terms = searchTerms(stripSiteOperators(query));
      const hits = this.options.sources
        .filter((source) => terms.every((term) => `${source.title} ${source.content}`.toLocaleLowerCase().includes(term)))
        .filter((source) => urlMatchesDomains(source.url, domains))
        .map((source) => ({ url: source.url, title: source.title, content: source.content }));
      return { hits, unavailable: [] };
    }
    const endpoint = new URL("/search", this.options.searxUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "0");
    const response = await this.#localJson.request<{ results?: RawSearchHit[]; unresponsive_engines?: unknown }>(endpoint, {}, LOCAL_JSON_LIMITS.searxQuery, signal);
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const payload = response.payload ?? {};
    const raw = Array.isArray(payload.results) ? payload.results : [];
    const eligible = raw.filter((item) => typeof item.url === "string" && typeof item.title === "string" && urlMatchesDomains(item.url, domains));
    const unavailable = searxUnavailableEngines(payload.unresponsive_engines);
    if (raw.length === 0 && unavailable.length > 0) throw new Error(`unavailable engines: ${unavailable.join(", ")}`);
    return { hits: eligible, unavailable };
  }

  private async read(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal): Promise<ReadContent> {
    requireScope(actor, "retrieval.read");
    assertReadRequest(request);
    const canonicalRequest = withoutRefresh(request);
    const key = { formatVersion: 13, principalId: actor.principalId, request: canonicalRequest, readerUrl: this.options.readerUrl };
    const entry = await this.#cache.getEntry<ReadContent>("read", key, true);
    const prior = entry === undefined ? undefined : await this.usableCachedRead(actor, entry.value);
    if (request.refresh !== true && entry?.fresh === true && prior !== undefined) return withReadDelivery(prior, "hit", false, "cached", this.options.clock.now());
    const mode = request.refresh === true ? "refresh" : prior === undefined ? "miss" : "stale";
    const flightKey = `read\0${mode}\0${createHash("sha256").update(stableStringify(key)).digest("hex")}`;
    const shared = await this.#inFlight.run(flightKey, signal, (sharedSignal) => this.uncachedRead(actor, canonicalRequest, sharedSignal, true, prior) as Promise<ReadContent>);
    await this.#cache.set("read", key, shared.value, READ_CACHE_TTL_MS).catch(() => undefined);
    const freshness = readValidation(shared.value) === "not-modified" ? "revalidated" : "fetched";
    return withReadDelivery(shared.value, "miss", shared.coalesced, freshness, this.options.clock.now());
  }

  private async usableCachedRead(actor: AuthorityActor, cached: ReadContent): Promise<ReadContent | undefined> {
    const metadata = typeof cached.metadata === "object" && cached.metadata !== null ? cached.metadata as Record<string, unknown> : {};
    const contentId = typeof metadata.contentId === "string" ? metadata.contentId : undefined;
    return contentId !== undefined && await this.#content.get(contentId, actor.principalId) !== undefined ? cached : undefined;
  }

  private async readBatch(actor: AuthorityActor, request: ReadBatchRequest, signal?: AbortSignal): Promise<ReadBatchResponse> {
    requireScope(actor, "retrieval.read");
    assertReadBatchRequest(request);
    const results = await boundedOrderedFanOut(request.items, READ_BATCH_CONCURRENCY, async (item, index): Promise<ReadBatchResponse["results"][number]> => {
      if (signal?.aborted) throw problem(499, "cancelled", "request was cancelled", false);
      try {
        return { index, url: item.url, ok: true, result: await this.read(actor, item, signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { index, url: item.url, ok: false, error: publicProblem(error) };
      }
    });
    const succeeded = results.filter((item) => item.ok).length;
    return { results, metadata: { requested: results.length, succeeded, failed: results.length - succeeded, maxConcurrency: 3 } };
  }

  private async uncachedRead(actor: AuthorityActor, request: ReadRequest, signal?: AbortSignal, retainContent = true, prior?: ReadContent): Promise<BoundedContent> {
    requireScope(actor, "retrieval.read");
    if (typeof request.url !== "string" || request.url.length === 0) throw problem(400, "invalid-request", "url is required", false);
    const crawlPages = integer(request.maxPages ?? 1, "maxPages", 1, 20);
    const crawlDepth = integer(request.maxDepth ?? 0, "maxDepth", 0, 3);
    if (request.contentOffset !== undefined && (crawlPages > 1 || crawlDepth > 0)) {
      throw problem(400, "invalid-request", "contentOffset continues a direct single-page read and cannot be combined with maxPages above 1 or maxDepth above 0", false);
    }
    if (crawlPages > 1 || crawlDepth > 0) {
      const requestedChars = integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000);
      const sourceChars = 1_000_000;
      const crawled = await this.crawl(actor, { url: request.url, maxPages: crawlPages, maxDepth: crawlDepth, maxChars: sourceChars, sameDomain: request.sameDomain, query: request.query }, signal);
      const successful = crawled.pages.filter((page) => page.ok && page.content);
      const perPageLimit = Math.max(1_500, Math.floor(sourceChars / Math.max(1, successful.length)));
      const allContent = successful.map((page, index) => `${successful.length > 1 ? `## ${page.title ?? `Page ${index + 1}`}\n\n` : ""}${request.query ? selectCanonicalPassage(cleanMainContent(page.content ?? ""), request.query, perPageLimit) : cleanMainContent(page.content ?? "")}`).join("\n\n");
      const primary = successful[0];
      return this.storeRead(actor, {
        title: primary?.title ?? `Content from ${request.url}`, url: primary?.url ?? request.url,
        requestedUrl: request.url, finalUrl: primary?.url ?? request.url, representation: "crawl-aggregate",
        sourceOffset: 0, sourceComplete: !crawled.truncated, nextSourceOffset: null,
        extractor: "crawl4ai", mediaType: "text/markdown", normalizedContent: allContent,
      }, allContent, requestedChars, {
        engine: "crawl4ai", pageCount: crawled.pageCount,
        pages: crawled.pages.map((page) => ({ title: page.title, url: page.url, depth: page.depth, ok: page.ok })),
      }, retainContent);
    }
    const allSources = this.options.sources;
    const input = request as ReadRequest & { query?: string; view?: string; fields?: readonly string[]; itemOffset?: number; itemLimit?: number; contentOffset?: number };
    const specializedProjection = input.view === "raw" || input.fields !== undefined || input.itemOffset !== undefined || input.itemLimit !== undefined;
    let source = !specializedProjection && input.contentOffset === undefined ? allSources.find((item) => item.url === request.url) : undefined;
    const requestedChars = integer(request.maxChars ?? 1_000_000, "maxChars", 1, 1_000_000);
    const sourceChars = input.query !== undefined || (!specializedProjection && retainContent) ? 1_000_000 : requestedChars;
    if (source === undefined && this.options.readerUrl !== undefined) {
      const priorFreshness = readFreshness(prior);
      const response = await this.#localJson.request<{ url?: unknown; title?: unknown; content?: unknown; mediaType?: unknown; source?: unknown; truncated?: unknown; metadata?: unknown; notModified?: unknown }>(
        new URL("/v1/read", this.options.readerUrl),
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: request.url,
            query: undefined,
            view: specializedProjection ? input.view ?? "main" : "main",
            fields: specializedProjection ? input.fields ?? [] : [],
            itemOffset: specializedProjection ? integer(input.itemOffset ?? 0, "itemOffset", 0, 1_000_000) : 0,
            itemLimit: specializedProjection ? integer(input.itemLimit ?? 50, "itemLimit", 1, 500) : 500,
            contentOffset: integer(input.contentOffset ?? 0, "contentOffset", 0, 100_000_000),
            maxChars: sourceChars,
            etag: priorFreshness?.etag,
            lastModified: priorFreshness?.lastModified,
            validatorUrl: prior === undefined ? undefined : prior.metadata.finalUrl,
          }),
        },
        LOCAL_JSON_LIMITS.reader,
        signal,
      );
      if (!response.ok) {
        const failure = parseReaderFailure(response.status, response.bodyText);
        throw problem(failure.toolStatus, "read-failed", failure.message, failure.retryable);
      }
      const page = response.payload ?? {};
      const readerMetadata = typeof page.metadata === "object" && page.metadata !== null ? page.metadata as Record<string, unknown> : {};
      if (page.notModified === true) {
        if (prior === undefined) throw new Error("reader returned not-modified without reusable canonical content");
        return revalidatedRead(prior, readerMetadata, this.options.clock.now());
      }
      if (typeof page.content !== "string") throw new Error("reader returned no text content");
      const digest = createHash("sha256").update(`${request.url}\0${page.content}`).digest("hex");
      source = { hitId: `hit-${digest.slice(0, 20)}`, ownerPrincipalId: actor.principalId, title: typeof page.title === "string" ? page.title : request.url, url: typeof page.url === "string" ? page.url : request.url, content: page.content, visibility: "public" };
      const sourceOffset = integer(input.contentOffset ?? 0, "contentOffset", 0, 100_000_000);
      const provenNextSourceOffset = safeNextSourceOffset(readerMetadata.nextContentOffset, sourceOffset);
      const sourceComplete = readerMetadata.complete === true || (page.truncated !== true && provenNextSourceOffset === null);
      const representation: ContentRepresentation = page.source === "structured-json" ? "structured-projection" : specializedProjection ? input.view === "raw" ? "raw-projection" : "structured-projection" : "canonical-normalized";
      const extractor = typeof page.source === "string" ? page.source : typeof readerMetadata.resolvedVia === "string" ? readerMetadata.resolvedVia : "reader";
      const mediaType = typeof page.mediaType === "string" ? page.mediaType : typeof readerMetadata.originalMediaType === "string" ? readerMetadata.originalMediaType : "text/markdown";
      const stored = {
        title: source.title, url: source.url, requestedUrl: request.url, finalUrl: source.url,
        representation, sourceOffset, sourceComplete, nextSourceOffset: provenNextSourceOffset,
        extractor, mediaType, normalizedContent: source.content,
      };
      const presented = input.query !== undefined
        ? selectCanonicalPassage(source.content, input.query, Math.min(requestedChars, MAX_AGENT_READ_CONTENT_CHARS))
        : !specializedProjection && input.view === "outline" ? outlineContent(source.content) : source.content;
      const metadata = { requestedUrl: request.url, finalUrl: source.url, source: page.source, substituted: source.url !== request.url, reader: { ...readerMetadata, truncated: page.truncated === true } };
      return this.storeRead(actor, stored, presented, requestedChars, metadata, retainContent);
    }
    if (source === undefined || !canRead(actor, source.ownerPrincipalId, source.visibility)) throw problem(404, "not-found", "page was not found", false);
    const presented = input.query !== undefined
      ? selectCanonicalPassage(source.content, input.query, Math.min(requestedChars, MAX_AGENT_READ_CONTENT_CHARS))
      : input.view === "outline" ? outlineContent(source.content) : source.content;
    return this.storeRead(actor, {
      title: source.title, url: source.url, requestedUrl: request.url, finalUrl: source.url,
      representation: "canonical-normalized", sourceOffset: 0, sourceComplete: true, nextSourceOffset: null,
      extractor: "indexed-source", mediaType: "text/markdown", normalizedContent: source.content,
    }, presented, requestedChars, {}, retainContent);
  }

  private async storeRead(
    actor: AuthorityActor,
    source: {
      readonly title: string; readonly url: string; readonly requestedUrl: string; readonly finalUrl: string;
      readonly representation: ContentRepresentation; readonly sourceOffset: number; readonly sourceComplete: boolean;
      readonly nextSourceOffset: number | null; readonly extractor: string; readonly mediaType: string; readonly normalizedContent: string;
    },
    presentedContent: string,
    requestedChars: number,
    metadata: Readonly<Record<string, unknown>> = {},
    retainContent = true,
  ): Promise<BoundedContent> {
    let record: NormalizedContentRecord | undefined;
    if (retainContent) {
      try {
        record = await this.#content.put({
          ownerPrincipalId: actor.principalId, title: source.title, url: source.url,
          requestedUrl: source.requestedUrl, finalUrl: source.finalUrl, representation: source.representation,
          sourceOffset: source.sourceOffset, sourceComplete: source.sourceComplete, nextSourceOffset: source.nextSourceOffset,
          extractor: source.extractor, mediaType: source.mediaType, content: source.normalizedContent,
        });
      } catch (error) {
        if (error instanceof ContentEntryTooLargeError) throw problem(413, error.code, error.message, false);
        throw error;
      }
    }
    const storedCharacters = [...source.normalizedContent].length;
    const presentedCharacters = [...presentedContent].length;
    const passageLimit = Math.min(requestedChars, MAX_AGENT_READ_CONTENT_CHARS);
    const bounded = boundText(presentedContent, passageLimit);
    const returnedCharacters = [...bounded.text].length;
    const locallyTruncated = returnedCharacters < presentedCharacters;
    const selectionApplied = presentedContent !== source.normalizedContent;
    const provenance = record === undefined ? {
      requestedUrl: source.requestedUrl, finalUrl: source.finalUrl, representation: source.representation,
      sourceOffset: source.sourceOffset, sourceComplete: source.sourceComplete, nextSourceOffset: source.nextSourceOffset,
      extractor: source.extractor, mediaType: source.mediaType,
      contentSha256: createHash("sha256").update(source.normalizedContent).digest("hex"),
    } : recordProvenance(record);
    const contentMetadata = {
      ...(record === undefined ? {} : {
        contentId: record.contentId, storedCharacters, storedBytes: record.sizeBytes,
        createdAt: new Date(record.createdAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString(),
      }),
      ...provenance,
      returnedCharacters, totalCharacters: storedCharacters,
      complete: !locallyTruncated && source.sourceComplete,
      sourceComplete: source.sourceComplete,
      nextStoredOffset: record !== undefined && !selectionApplied && locallyTruncated ? returnedCharacters : null,
      nextContentOffset: !locallyTruncated && source.nextSourceOffset !== null ? source.nextSourceOffset : null,
      selectionApplied,
    };
    const identity = record === undefined ? {} : {
      contentId: record.contentId,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
    const reader = typeof metadata.reader === "object" && metadata.reader !== null ? metadata.reader as Record<string, unknown> : undefined;
    const timestamp = this.options.clock.now();
    const freshness = {
      fetchedAt: timestamp,
      validatedAt: timestamp,
      cacheAgeMs: 0,
      cache: "miss" as const,
      validation: "fetched" as const,
      ...boundedValidators(reader),
    };
    const mergedMetadata = reader === undefined
      ? { ...metadata, ...identity, ...provenance, freshness, reader: contentMetadata }
      : { ...metadata, ...identity, ...provenance, freshness, reader: { ...reader, ...contentMetadata } };
    return { title: source.title, url: source.url, untrustedContent: bounded.text, truncated: locallyTruncated || !source.sourceComplete, visibility: "public", metadata: mergedMetadata };
  }

  private async content(actor: AuthorityActor, request: ContentRequest): Promise<StoredContent> {
    requireScope(actor, "retrieval.read");
    assertContentRequest(request);
    const record = await this.#content.get(request.contentId, actor.principalId);
    if (record === undefined) throw problem(404, "content-not-found", "stored content was not found or has expired", false);
    const limit = integer(request.limit ?? MAX_STORED_CONTENT_RETRIEVAL_CHARS, "limit", 1, MAX_STORED_CONTENT_RETRIEVAL_CHARS);
    const points = [...record.content];
    let mode: StoredContent["metadata"]["mode"] = "exact";
    let text: string;
    let offset: number | undefined;
    let nextOffset: number | null | undefined;
    let matchOffset: number | undefined;
    if (request.findText !== undefined) {
      mode = "findText";
      const match = record.content.toLocaleLowerCase().indexOf(request.findText.toLocaleLowerCase());
      if (match < 0) throw problem(404, "content-no-match", "findText was not found in stored content", false);
      matchOffset = [...record.content.slice(0, match)].length;
      offset = Math.max(0, matchOffset - Math.floor(limit / 5));
      text = points.slice(offset, offset + limit).join("");
    } else if (request.query !== undefined) {
      mode = "query";
      text = selectCanonicalPassage(record.content, request.query, limit);
    } else {
      offset = integer(request.offset ?? 0, "offset", 0, points.length);
      text = points.slice(offset, offset + limit).join("");
      nextOffset = offset + [...text].length < points.length ? offset + [...text].length : null;
    }
    const returnedCharacters = [...text].length;
    const atLocalEof = mode === "exact" && nextOffset === null;
    const nextContentOffset = atLocalEof && !record.sourceComplete ? record.nextSourceOffset : null;
    return {
      title: record.title,
      url: record.url,
      untrustedContent: text,
      truncated: mode === "exact" ? nextOffset !== null || nextContentOffset !== null : returnedCharacters < points.length,
      visibility: "public",
      metadata: {
        contentId: record.contentId, mode, totalCharacters: points.length, returnedCharacters,
        ...recordProvenance(record),
        ...(offset === undefined ? {} : { offset }),
        ...(nextOffset === undefined ? {} : { nextOffset }),
        ...(mode === "exact" ? { nextContentOffset } : {}),
        ...(matchOffset === undefined ? {} : { matchOffset }),
        createdAt: new Date(record.createdAt).toISOString(),
        expiresAt: new Date(record.expiresAt).toISOString(),
      },
    };
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
    const response = await this.#localJson.request<Record<string, unknown>>(
      new URL("/v1/read-range", this.options.readerUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: request.url, offset, length, maxRedirects }),
      },
      LOCAL_JSON_LIMITS.reader,
      signal,
    );
    if (!response.ok) {
      const failure = parseReaderFailure(response.status, response.bodyText);
      throw problem(failure.toolStatus, "range-read-failed", failure.message, failure.retryable);
    }
    const value = response.payload ?? {};
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
      for (const session of sessions) this.#browserOwners.set(session.browserSessionId, { principalId: actor.principalId, agentId: actor.agentId });
      return ok({ sessions });
    }
    if (request.method === "POST" && segments.length === 3 && segments[2] === "sessions") {
      requireScope(actor, "browser.write");
      const input = body<BrowserSessionRequest>(request);
      if (!isBrowserPathId(input.pathId)) throw problem(400, "unsupported", "browser path is not supported", false);
      const session = await this.options.browser.createSession(actor, input, operationId(request), request.signal);
      if (session.pathId !== input.pathId) throw problem(502, "wrong-path", "browser daemon changed the selected path", false);
      this.#browserOwners.set(session.browserSessionId, { principalId: actor.principalId, agentId: actor.agentId });
      return ok(session, 201);
    }
    if (sessionId !== undefined && segments[2] === "sessions") {
      this.assertBrowserOwner(actor, sessionId);
      if (request.method === "GET" && segments.length === 4) { requireScope(actor, "browser.read"); return ok(await this.options.browser.getSession(actor, sessionId, request.signal)); }
      if (request.method === "DELETE" && segments.length === 4) { requireScope(actor, "browser.write"); await this.options.browser.close(actor, sessionId, operationId(request), request.signal); this.#browserOwners.delete(sessionId); return { status: 204, headers: jsonHeaders() }; }
      if (request.method === "POST" && segments.length === 5 && segments[4] === "tabs") { requireScope(actor, "browser.write"); const input = body<{ url?: string }>(request); return ok(await this.options.browser.createTab(actor, sessionId, input.url, operationId(request), request.signal), 201); }
      if (request.method === "POST" && segments[4] === "tabs" && segments[5] !== undefined && segments[6] === "focus") { requireScope(actor, "browser.write"); return ok(await this.options.browser.focusTab(actor, sessionId, segments[5], operationId(request), request.signal)); }
      if (request.method === "DELETE" && segments[4] === "tabs" && segments[5] !== undefined) { requireScope(actor, "browser.write"); await this.options.browser.closeTab(actor, sessionId, segments[5], operationId(request), request.signal); return { status: 204, headers: jsonHeaders() }; }
      if (request.method === "POST" && segments[4] === "observe") {
        requireScope(actor, "browser.read");
        const input = body<{ view?: string; mode?: string; maxChars?: number; maxNodes?: number; tabId?: string }>(request);
        if (typeof input.tabId !== "string") throw problem(400, "invalid-request", "explicit tabId is required", false);
        return ok(await this.options.browser.observe(actor, sessionId, input.mode ?? input.view ?? "screenshot", integer(input.maxNodes ?? input.maxChars ?? DEFAULT_CONTENT_CHARS, "observation bound", 1, MAX_CONTENT_CHARS), operationId(request), request.signal, input.tabId));
      }
      if (request.method === "GET" && segments.length === 9 && segments[4] === "tabs" && segments[6] === "observations" && segments[8] === "image") {
        requireScope(actor, "browser.read");
        const tabId = segments[5]; const observationId = segments[7];
        if (tabId === undefined || observationId === undefined) throw problem(400, "invalid-request", "exact tab and observation IDs are required", false);
        return ok(await this.options.browser.captureFrame(actor, sessionId, pathId(tabId), pathId(observationId), request.signal));
      }
      if (request.method === "POST" && segments[4] === "frame") {
        requireScope(actor, "browser.read");
        const input = body<{ tabId?: string; observationId?: string }>(request);
        if (typeof input.tabId !== "string" || typeof input.observationId !== "string") throw problem(400, "invalid-request", "explicit tabId and observationId are required", false);
        return ok(await this.options.browser.captureFrame(actor, sessionId, input.tabId, input.observationId, request.signal));
      }
      if (request.method === "POST" && segments[4] === "actions") {
        requireScope(actor, "browser.write");
        const input = body<{ action: BrowserAction; tabId?: string }>(request);
        if (typeof input.tabId !== "string") throw problem(400, "invalid-request", "explicit tabId is required", false);
        return ok(await this.options.browser.act(actor, sessionId, input.action, operationId(request), request.signal, input.tabId));
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
      return ok(await this.options.browser.cancel(actor, segments[3] ?? "", operationId(request), request.signal));
    }
    throw problem(404, "not-found", "browser operation was not found", false);
  }

  private rememberIdempotency(key: string, fingerprint: string, response: TransportResponse): void {
    const bytes = new TextEncoder().encode(JSON.stringify({ fingerprint, response })).byteLength;
    if (bytes > this.#idempotencyMaxBytes) return;
    const prior = this.#idempotency.get(key);
    if (prior !== undefined) this.removeIdempotency(key, prior);
    this.#idempotency.set(key, { fingerprint, response, expiresAt: Date.now() + this.#idempotencyTtlMs, bytes, policy: "durable-mutation" });
    this.#idempotencyBytes += bytes;
    this.pruneIdempotency();
    while (this.#idempotency.size > this.#idempotencyMaxEntries || this.#idempotencyBytes > this.#idempotencyMaxBytes) {
      const oldest = this.#idempotency.entries().next().value as [string, CachedResult] | undefined;
      if (oldest === undefined) break;
      this.removeIdempotency(oldest[0], oldest[1]);
    }
  }

  private pruneIdempotency(): void { for (const [key, entry] of this.#idempotency) if (entry.expiresAt <= Date.now()) this.removeIdempotency(key, entry); }

  private removeIdempotency(key: string, entry: CachedResult): void {
    if (!this.#idempotency.delete(key)) return;
    this.#idempotencyBytes -= entry.bytes;
  }

  private assertBrowserOwner(actor: AuthorityActor, sessionId: string): void {
    const owner = this.#browserOwners.get(sessionId);
    if (owner !== undefined && (owner.principalId !== actor.principalId || owner.agentId !== actor.agentId)) throw problem(404, "not-found", "browser session was not found", false);
  }
}

interface Flight<T> { readonly controller: AbortController; readonly promise: Promise<T>; waiters: number }
class InFlightCoalescer {
  readonly #flights = new Map<string, Flight<unknown>>();
  constructor(private readonly maxKeys: number) {}

  async run<T>(key: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
    let flight = this.#flights.get(key) as Flight<T> | undefined;
    const coalesced = flight !== undefined;
    if (flight === undefined) {
      if (this.#flights.size >= this.maxKeys) return { value: await operation(signal ?? new AbortController().signal), coalesced: false };
      const controller = new AbortController();
      const created: Flight<T> = { controller, waiters: 0, promise: Promise.resolve().then(() => operation(controller.signal)) };
      flight = created;
      this.#flights.set(key, created as Flight<unknown>);
      void created.promise.finally(() => { if (this.#flights.get(key) === created) this.#flights.delete(key); }).catch(() => undefined);
    }
    flight.waiters += 1;
    try { return { value: await waitForFlight(flight.promise, signal), coalesced }; }
    finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && this.#flights.get(key) === flight) {
        this.#flights.delete(key);
        flight.controller.abort();
      }
    }
  }
}

function waitForFlight<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("request was cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new DOMException("request was cancelled", "AbortError"));
    signal.addEventListener("abort", cancelled, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled)).catch(() => undefined);
  });
}

function safeNextSourceOffset(value: unknown, sourceOffset: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > sourceOffset && value <= 100_000_000 ? value : null;
}
function recordProvenance(record: NormalizedContentRecord) {
  return {
    requestedUrl: record.requestedUrl, finalUrl: record.finalUrl, representation: record.representation,
    sourceOffset: record.sourceOffset, sourceComplete: record.sourceComplete, nextSourceOffset: record.nextSourceOffset,
    extractor: record.extractor, mediaType: record.mediaType, contentSha256: record.contentSha256,
  };
}
function outlineContent(content: string): string {
  const headings = content.split(/\r?\n/u).filter((line) => /^#{1,6}\s+\S/u.test(line.trim()));
  return headings.length > 0 ? headings.join("\n") : content.split(/\r?\n{2,}/u).map((part) => part.trim().split(/\r?\n/u)[0] ?? "").filter(Boolean).slice(0, 200).join("\n");
}

function withSearchDelivery(value: SearchResponse, cache: "hit" | "miss", coalesced: boolean): SearchResponse {
  return { ...value, metadata: { ...value.metadata, delivery: { cache, coalesced } } };
}
function withReadDelivery<T extends BoundedContent>(value: T, cache: "hit" | "miss", coalesced: boolean, freshness: "cached" | "fetched" | "revalidated", deliveredAt: string): T {
  const metadata = typeof value.metadata === "object" && value.metadata !== null ? value.metadata : {};
  const priorFreshness = typeof metadata.freshness === "object" && metadata.freshness !== null ? metadata.freshness as ReadFreshness : undefined;
  const visibleFreshness = priorFreshness === undefined ? undefined : {
    ...priorFreshness,
    cacheAgeMs: cacheAgeMilliseconds(priorFreshness.fetchedAt, deliveredAt),
    cache: freshness === "cached" ? "hit" as const : freshness === "revalidated" ? "revalidated" as const : "miss" as const,
  };
  return { ...value, metadata: { ...metadata, ...(visibleFreshness === undefined ? {} : { freshness: visibleFreshness }), delivery: { cache, coalesced, freshness } } } as T;
}
function readFreshness(value: ReadContent | undefined): ReadFreshness | undefined {
  const freshness = value?.metadata.freshness;
  return typeof freshness === "object" && freshness !== null ? freshness : undefined;
}
function readValidation(value: ReadContent): ReadFreshness["validation"] | undefined { return readFreshness(value)?.validation; }
function boundedValidators(value: Readonly<Record<string, unknown>> | undefined): Pick<ReadFreshness, "etag" | "lastModified"> {
  const etag = boundedValidator(value?.etag, 1_024);
  const lastModified = boundedValidator(value?.lastModified, 128);
  return { ...(etag === undefined ? {} : { etag }), ...(lastModified === undefined ? {} : { lastModified }) };
}
function boundedValidator(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\r\n]/u.test(value) ? value : undefined;
}
function revalidatedRead(prior: ReadContent, readerMetadata: Readonly<Record<string, unknown>>, validatedAt: string): ReadContent {
  const previous = readFreshness(prior);
  if (previous === undefined) throw new Error("cached read has no freshness metadata");
  const responseValidators = boundedValidators(readerMetadata);
  const freshness: ReadFreshness = {
    fetchedAt: previous.fetchedAt,
    validatedAt,
    cacheAgeMs: cacheAgeMilliseconds(previous.fetchedAt, validatedAt),
    cache: "revalidated",
    validation: "not-modified",
    etag: responseValidators.etag ?? previous.etag,
    lastModified: responseValidators.lastModified ?? previous.lastModified,
  };
  return { ...prior, metadata: { ...prior.metadata, freshness } };
}
function cacheAgeMilliseconds(fetchedAt: string, observedAt: string): number {
  const fetched = Date.parse(fetchedAt);
  const observed = Date.parse(observedAt);
  return Number.isFinite(fetched) && Number.isFinite(observed) ? Math.max(0, observed - fetched) : 0;
}
function withoutRefresh(request: ReadRequest): ReadRequest {
  const { refresh, ...canonical } = request;
  void refresh;
  return canonical;
}
async function boundedOrderedFanOut<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await run(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
function assertReadRequest(request: ReadRequest): void {
  assertDirectReadRequest(request, new Set(["maxPages", "maxDepth", "sameDomain", "visibility"]));
  const value = request as unknown as Record<string, unknown>;
  if (value.maxPages !== undefined) integer(value.maxPages as number, "maxPages", 1, 20);
  if (value.maxDepth !== undefined) integer(value.maxDepth as number, "maxDepth", 0, 3);
  if (value.sameDomain !== undefined && typeof value.sameDomain !== "boolean") throw problem(400, "invalid-request", "sameDomain must be a boolean", false);
  if (value.visibility !== undefined && !["public", "internal", "private", "secret"].includes(String(value.visibility))) throw problem(400, "invalid-request", "visibility is invalid", false);
}
function assertReadBatchRequest(request: ReadBatchRequest): void {
  const value = request as unknown as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => key !== "items");
  if (unknown.length > 0) throw problem(400, "invalid-request", `unsupported read batch field: ${unknown[0]}`, false);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 5) throw problem(400, "invalid-request", "items must contain 1 to 5 direct read requests", false);
  for (const item of value.items) assertDirectReadRequest(item);
}
function assertDirectReadRequest(input: unknown, additionalAllowed = new Set<string>()): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw problem(400, "invalid-request", "each read request must be an object", false);
  const value = input as Record<string, unknown>;
  const allowed = new Set(["url", "query", "view", "fields", "itemOffset", "itemLimit", "maxChars", "contentOffset", "refresh", ...additionalAllowed]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw problem(400, "invalid-request", `unsupported read batch item field: ${unknown[0]}`, false);
  if (typeof value.url !== "string" || value.url.length < 1 || value.url.length > 8_192) throw problem(400, "invalid-request", "read batch item url is required", false);
  assertPublicUrlSyntax(value.url);
  if (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 8_192)) throw problem(400, "invalid-request", "query must contain at most 8192 characters", false);
  if (value.view !== undefined && value.view !== "main" && value.view !== "outline" && value.view !== "raw") throw problem(400, "invalid-request", "view must be main, outline, or raw", false);
  if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > 32 || value.fields.some((field) => typeof field !== "string" || field.length < 1 || field.length > 256))) throw problem(400, "invalid-request", "fields must contain at most 32 property names", false);
  if (value.itemOffset !== undefined) integer(value.itemOffset as number, "itemOffset", 0, 1_000_000);
  if (value.itemLimit !== undefined) integer(value.itemLimit as number, "itemLimit", 1, 500);
  if (value.maxChars !== undefined) integer(value.maxChars as number, "maxChars", 1, 1_000_000);
  if (value.contentOffset !== undefined) integer(value.contentOffset as number, "contentOffset", 0, 100_000_000);
  if (value.refresh !== undefined && typeof value.refresh !== "boolean") throw problem(400, "invalid-request", "refresh must be a boolean", false);
}
function publicProblem(error: unknown): WebxProblem {
  if (isAuthorityFailure(error)) return error.body;
  if (error instanceof BrowserPortError) return { code: error.code, message: error.message.slice(0, 300), retryable: error.retryable };
  return { code: "backend-failure", message: safeMessage(error), retryable: true };
}

function healthProbeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
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
function positiveOption(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive finite integer`); return value; }
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

function assertContentRequest(request: ContentRequest): void {
  const allowed = new Set(["contentId", "offset", "limit", "findText", "query"]);
  const unknown = Object.keys(request as unknown as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw problem(400, "invalid-request", `unsupported content field: ${unknown[0]}`, false);
  if (typeof request.contentId !== "string" || !/^cnt_[A-Za-z0-9_-]{32}$/u.test(request.contentId)) throw problem(400, "invalid-request", "contentId is invalid", false);
  const focused = Number(request.findText !== undefined) + Number(request.query !== undefined);
  if (focused > 1 || (focused > 0 && request.offset !== undefined)) throw problem(400, "invalid-request", "offset mode and focused mode are mutually exclusive", false);
  if (request.findText !== undefined && (typeof request.findText !== "string" || request.findText.length < 1 || request.findText.length > 8_192)) throw problem(400, "invalid-request", "findText must contain 1 to 8192 characters", false);
  if (request.query !== undefined && (typeof request.query !== "string" || request.query.trim().length < 1 || request.query.length > 8_192)) throw problem(400, "invalid-request", "query must contain 1 to 8192 characters", false);
}

function assertSearchRequestKeys(request: SearchRequest): void {
  const allowed = new Set(["query", "output", "domains", "visibility"]);
  const unknown = Object.keys(request as unknown as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw problem(400, "invalid-request", `unsupported search field: ${unknown[0]}`, false);
}

function normalizeSearchDomain(value: string): string {
  const domain = value.trim().toLocaleLowerCase().replace(/\.$/u, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) {
    throw problem(400, "invalid-request", `invalid search domain: ${value}`, false);
  }
  return domain;
}

function isSameOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function resolveSearchDomains(requested: readonly string[], fromQuery: readonly string[]): string[] {
  const explicit = [...new Set(requested.filter(Boolean).map(normalizeSearchDomain))];
  const query = [...new Set(fromQuery.filter(Boolean).map(normalizeSearchDomain))];
  if (explicit.length === 0) return query;
  if (query.length === 0) return explicit;
  const intersection = new Set<string>();
  for (const requestedDomain of explicit) {
    for (const queryDomain of query) {
      if (isSameOrSubdomain(requestedDomain, queryDomain)) intersection.add(requestedDomain);
      else if (isSameOrSubdomain(queryDomain, requestedDomain)) intersection.add(queryDomain);
    }
  }
  if (intersection.size === 0) throw problem(400, "invalid-request", "domains conflict with the query site: constraint", false);
  return [...intersection];
}

function searchDomains(query: string): string[] {
  return [...query.matchAll(/(?:^|\s)site:([A-Za-z0-9.-]+)(?:\/[^\s]*)?/giu)].map((match) => match[1] ?? "").filter(Boolean);
}

function stripSiteOperators(query: string): string {
  return query.replace(/(^|\s)site:([A-Za-z0-9.-]+(?:\/[^\s]*)?)/giu, "$1$2").replace(/\s+/gu, " ").trim();
}

function urlMatchesDomains(value: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase().replace(/\.$/u, "");
    return domains.some((domain) => isSameOrSubdomain(hostname, domain));
  } catch { return false; }
}

function normalizeSearchUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return undefined;
    url.hostname = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/iu.test(key) || /^(?:fbclid|gclid|dclid|msclkid|msockid|mc_cid|mc_eid|ref_src)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch { return undefined; }
}

function canonicalSearchUrl(value: string): string {
  const normalized = normalizeSearchUrl(value) ?? value;
  try {
    const url = new URL(normalized);
    url.hostname = url.hostname.replace(/^www\./u, "");
    return url.toString();
  } catch { return normalized; }
}

function searchHitId(url: string): string {
  return `search-${createHash("sha256").update(url).digest("hex").slice(0, 20)}`;
}

function searchTerms(query: string): string[] {
  const stop = new Set(["and", "are", "for", "from", "into", "official", "the", "this", "with"]);
  return [...new Set(query.toLocaleLowerCase().match(/[a-z0-9][a-z0-9.+-]{1,}/gu) ?? [])].filter((term) => !stop.has(term));
}

function textCoverage(value: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = value.toLocaleLowerCase();
  return terms.filter((term) => lower.includes(term)).length / terms.length;
}

function searchRelevanceScore(item: RawSearchHit, url: string, query: string): number {
  const cleanQuery = stripSiteOperators(query).toLocaleLowerCase();
  const terms = searchTerms(cleanQuery);
  const title = typeof item.title === "string" ? item.title : "";
  const content = typeof item.content === "string" ? item.content : "";
  const exact = cleanQuery.length <= 160 && title.toLocaleLowerCase().includes(cleanQuery) ? 2 : 0;
  return exact + textCoverage(title, terms) * 6 + textCoverage(url, terms) * 3 + textCoverage(content, terms);
}

function rankSearchCandidates(batches: readonly SearchBatch[], query: string): SearchCandidate[] {
  const merged = new Map<string, { item: RawSearchHit; url: string; score: number; firstIndex: number }>();
  let sequence = 0;
  for (const batch of batches) {
    const seenInBatch = new Set<string>();
    for (const [index, item] of batch.hits.entries()) {
      if (typeof item.url !== "string" || typeof item.title !== "string") continue;
      const url = normalizeSearchUrl(item.url);
      if (url === undefined) continue;
      const key = canonicalSearchUrl(url);
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      const existing = merged.get(key);
      const contribution = 1 / (60 + index + 1);
      if (existing === undefined) {
        merged.set(key, { item, url, score: contribution, firstIndex: sequence++ });
      } else {
        existing.score += contribution;
        const currentContent = typeof existing.item.content === "string" ? existing.item.content.length : 0;
        const nextContent = typeof item.content === "string" ? item.content.length : 0;
        if (nextContent > currentContent) existing.item = item;
      }
    }
  }
  const ranked = [...merged.values()].map((candidate) => ({
    ...candidate, score: candidate.score + searchRelevanceScore(candidate.item, candidate.url, query) / 4_000,
  })).sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex);
  const seenTitles = new Set<string>();
  const seenContent = new Set<string>();
  return ranked.filter((candidate) => {
    const hostname = new URL(candidate.url).hostname.replace(/^www\./u, "");
    const title = String(candidate.item.title).toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
    const titleKey = `${hostname}\0${title}`;
    const content = typeof candidate.item.content === "string" ? candidate.item.content.toLocaleLowerCase().replace(/\s+/gu, " ").trim() : "";
    const contentKey = content.length >= 80 ? `${hostname}\0${content}` : undefined;
    if (seenTitles.has(titleKey) || (contentKey !== undefined && seenContent.has(contentKey))) return false;
    seenTitles.add(titleKey);
    if (contentKey !== undefined) seenContent.add(contentKey);
    return true;
  });
}

function searxUnavailableEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) && typeof item[0] === "string" ? [`${item[0]}${typeof item[1] === "string" ? ` (${item[1]})` : ""}`] : []);
}

function header(request: TransportRequest, name: string): string | undefined { const entry = Object.entries(request.headers ?? {}).find(([key]) => key.toLocaleLowerCase() === name); return entry?.[1]; }
function pathId(value: string): string { try { return decodeURIComponent(value); } catch { throw problem(400, "invalid-request", "path identity encoding is invalid", false); } }
function operationId(request: TransportRequest): string { const value = header(request, "idempotency-key"); if (value === undefined) throw problem(400, "missing-idempotency-key", "idempotency key is required", false); return `operation:${createHash("sha256").update(value).digest("hex")}`; }
function idempotencyPolicy(request: TransportRequest): IdempotencyPolicy {
  const path = new URL(request.path, "http://webx.local").pathname;
  if (/^\/v1\/browser\/sessions\/[^/]+\/tabs\/[^/]+\/observations\/[^/]+\/image$/u.test(path) || /^\/v1\/browser\/sessions\/[^/]+\/frame$/u.test(path)) return "image-read";
  if (request.method === "POST" && /^\/v1\/browser\/sessions\/[^/]+\/observe$/u.test(path)) return "ephemeral-observation";
  return request.method === "POST" || request.method === "DELETE" ? "durable-mutation" : "none";
}
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
