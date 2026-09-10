export const WEBX_API_VERSION = "3.0.0" as const;
export const WEBX_API_MAJOR = 3 as const;
export const BROWSER_PROTOCOL_VERSION = "3.0.0" as const;

export type Visibility = "public" | "internal" | "private" | "secret";
export type CapabilityId = "search" | "read" | "artifacts" | "browser";

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export interface TransportRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface WebxTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
  close?(): Promise<void>;
}

export interface VersionInfo {
  readonly apiVersion: string;
  readonly webxVersion: string;
  readonly browserProtocolVersion: string;
}

export interface Capability {
  readonly id: CapabilityId;
  readonly enabled: boolean;
  readonly healthy: boolean;
  readonly reason?: string;
}

export interface CapabilityCatalog {
  readonly apiVersion: string;
  readonly capabilities: readonly Capability[];
  readonly browserPaths: readonly BrowserPathCapability[];
}

export interface BrowserPathCapability {
  readonly pathId: never;
  readonly actions: readonly string[];
  readonly observations: readonly string[];
  readonly visual: boolean;
  readonly touch: false;
  readonly uploads: boolean;
  readonly downloads: boolean;
}

export interface SearchRequest {
  readonly query: string;
  readonly output?: "links" | "extracts";
  readonly visibility?: Visibility;
  readonly domains?: readonly string[];
}

export interface SearchHit {
  readonly hitId: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly rank: number;
  readonly visibility: Visibility;
}

export interface SearchResponse {
  readonly query: string;
  readonly output: "links" | "extracts";
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
  readonly metadata: {
    readonly searches: number;
    readonly fallbackUsed: boolean;
    readonly partial: boolean;
    readonly pagesRead: number;
    readonly readAttempts: number;
    readonly warning?: string;
    readonly migration?: string;
    readonly delivery?: { readonly cache: "hit" | "miss"; readonly coalesced: boolean };
  };
}

export interface ReadSaveOptions {
  readonly path: string;
  readonly overwrite?: boolean;
}

export interface ReadRequest {
  readonly url: string;
  readonly query?: string;
  readonly view?: "main" | "outline" | "raw";
  readonly fields?: readonly string[];
  readonly itemOffset?: number;
  readonly itemLimit?: number;
  readonly maxChars?: number;
  readonly contentOffset?: number;
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained until a separately announced removal. */
  readonly maxPages?: number;
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained until a separately announced removal. */
  readonly maxDepth?: number;
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained until a separately announced removal. */
  readonly sameDomain?: boolean;
  /** Bypass a fresh traffic-cache hit and validate the canonical source again. */
  readonly refresh?: boolean;
  readonly visibility?: Visibility;
}

export type DirectReadRequest = Pick<ReadRequest, "url" | "query" | "view" | "fields" | "itemOffset" | "itemLimit" | "maxChars" | "contentOffset" | "refresh">;

export interface ReadBatchRequest {
  readonly items: readonly DirectReadRequest[];
}

export type ReadBatchEnvelope =
  | { readonly index: number; readonly url: string; readonly ok: true; readonly result: ReadContent }
  | { readonly index: number; readonly url: string; readonly ok: false; readonly error: WebxProblem };

export interface ReadBatchResponse {
  readonly results: readonly ReadBatchEnvelope[];
  readonly metadata: { readonly requested: number; readonly succeeded: number; readonly failed: number; readonly maxConcurrency: 3 };
}

export interface ContentRequest {
  readonly contentId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly findText?: string;
  readonly query?: string;
}

export type ContentRepresentation = "canonical-normalized" | "raw-projection" | "structured-projection" | "crawl-aggregate";

export interface ContentProvenance extends Readonly<Record<string, unknown>> {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly representation: ContentRepresentation;
  readonly sourceOffset: number;
  readonly sourceComplete: boolean;
  readonly nextSourceOffset: number | null;
  readonly extractor: string;
  readonly mediaType: string;
  readonly contentSha256: string;
}

export interface ReadFreshness {
  readonly fetchedAt: string;
  readonly validatedAt: string;
  readonly cacheAgeMs: number;
  readonly cache: "hit" | "miss" | "revalidated";
  readonly validation: "fetched" | "not-modified";
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface ReadContent extends BoundedContent {
  readonly metadata: ContentProvenance & {
    readonly contentId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly reader: Readonly<Record<string, unknown>> & ContentProvenance;
    readonly freshness: ReadFreshness;
    readonly delivery?: { readonly cache: "hit" | "miss"; readonly coalesced: boolean; readonly freshness: "cached" | "fetched" | "revalidated" };
  };
}

export interface StoredContent extends BoundedContent {
  readonly metadata: ContentProvenance & {
    readonly contentId: string;
    readonly mode: "exact" | "findText" | "query";
    readonly totalCharacters: number;
    readonly returnedCharacters: number;
    readonly offset?: number;
    readonly nextOffset?: number | null;
    readonly nextContentOffset?: number | null;
    readonly matchOffset?: number;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

export interface RangeReadRequest {
  readonly url: string;
  readonly offset: number;
  readonly length: number;
  readonly maxRedirects?: number;
}

export interface RangeReadResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly statusCode: 206;
  readonly mediaType: string;
  readonly contentRange: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly totalBytes: number | null;
  readonly bodyBytes: number;
  readonly sha256: string;
  readonly artifactId: string;
  readonly redirectChain: readonly string[];
  readonly visibility: "internal";
  readonly integrityVerified: true;
}

export interface BoundedContent {
  readonly title: string;
  readonly url: string;
  readonly untrustedContent: string;
  readonly truncated: boolean;
  readonly visibility: Visibility;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SavedReadResponse {
  readonly saved: true;
  readonly path: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly characters: number;
  readonly sha256: string;
  readonly complete: boolean;
  readonly source: {
    readonly requestedUrl: string;
    readonly finalUrl: string;
    readonly title: string;
  };
}

export interface CrawlRequest {
  readonly url: string;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly maxChars?: number;
  readonly sameDomain?: boolean;
  readonly query?: string;
}

export interface CrawlPage {
  readonly url: string;
  readonly title?: string;
  readonly depth: number;
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
  readonly truncated?: boolean;
}

export interface CrawlResponse {
  readonly startUrl: string;
  readonly pages: readonly CrawlPage[];
  readonly pageCount: number;
  readonly truncated: boolean;
}

export interface ArtifactByteExcerpt {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bodyBase64: string;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly visibility: Visibility;
  readonly integrityVerified: true;
}

export interface WebxProblem {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
