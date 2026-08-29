export const WEBX_API_VERSION = "3.0.0" as const;
export const WEBX_API_MAJOR = 3 as const;
export const BROWSER_PROTOCOL_VERSION = "3.0.0" as const;
export const BROWSER_PATH_IDS = ["agentcursor/chrome", "agent-browser/chrome"] as const;

export type BrowserPathId = (typeof BROWSER_PATH_IDS)[number];
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
  readonly pathId: BrowserPathId;
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
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained through the current 0.x API line. */
  readonly maxPages?: number;
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained through the current 0.x API line. */
  readonly maxDepth?: number;
  /** @deprecated Compatibility field. Use search, readBatch, and content. Retained through the current 0.x API line. */
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

export interface BrowserSessionRequest {
  readonly pathId: BrowserPathId;
  readonly url?: string;
}

export interface BrowserTab {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly state: "attaching" | "ready" | "crashed" | "closed";
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly frameSequence: number;
}

export interface BrowserCursorSummary {
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: "cssViewport";
  readonly pathSequence: number;
  readonly sampleSequence: number;
  readonly visible: boolean;
}

export interface BrowserSession {
  readonly browserSessionId: string;
  readonly pathId: BrowserPathId;
  readonly controlEpoch: number;
  readonly state: "creating" | "ready" | "degraded" | "closing" | "closed" | "lost";
  readonly personaId?: string;
  readonly cursor?: BrowserCursorSummary;
  readonly tabs: readonly BrowserTab[];
}

export type BrowserCoordinateSpace = "imagePixels" | "cssViewport";
export interface BrowserPoint { readonly x: number; readonly y: number }

interface ScreenshotBoundAction {
  readonly observationId: string;
  readonly coordinateSpace?: BrowserCoordinateSpace;
}

export type BrowserAction =
  | ({ readonly kind: "move"; readonly x: number; readonly y: number } & ScreenshotBoundAction)
  | ({ readonly kind: "click" | "double-click"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right" } & ScreenshotBoundAction)
  | ({ readonly kind: "drag"; readonly from: BrowserPoint; readonly to: BrowserPoint } & ScreenshotBoundAction)
  | ({ readonly kind: "wheel"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number } & ScreenshotBoundAction)
  | { readonly kind: "text-input"; readonly text: string; readonly replace?: boolean }
  | { readonly kind: "key-press"; readonly key: string }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "dom-click" | "dom-double-click" | "dom-hover"; readonly domObservationId: string; readonly handle: string; readonly button?: "left" | "middle" | "right" }
  | { readonly kind: "dom-type" | "dom-fill"; readonly domObservationId: string; readonly handle: string; readonly text: string }
  | { readonly kind: "dom-key-press"; readonly domObservationId: string; readonly handle: string; readonly key: string };

export interface BrowserSessionList {
  readonly sessions: readonly BrowserSession[];
}

export type BrowserWorkspaceAction = "show" | "hide" | "list" | "attach" | "takeover" | "return";

export interface BrowserWorkspaceRequest {
  readonly action: BrowserWorkspaceAction;
  readonly sessionId?: string;
  readonly tabId?: string;
}

export interface BrowserWorkspaceResult {
  readonly action: BrowserWorkspaceAction;
  readonly data: unknown;
}

export type SafeBrowserDebugOperation = "console" | "network" | "html" | "pdf" | "record-start" | "record-stop";

export interface BrowserDebugRequest {
  readonly operation: SafeBrowserDebugOperation;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly maxChars?: number;
}

export interface BrowserDebugResult {
  readonly operationId: string;
  readonly operation: SafeBrowserDebugOperation;
  readonly ok: boolean;
  readonly data: unknown;
  readonly artifactId?: string;
}

export interface BrowserDomNode {
  readonly handle: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly state: Readonly<Record<string, string | number | boolean>>;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface BrowserScreenshotObservation {
  readonly kind: "screenshot";
  readonly operationId: string;
  readonly observationId: string;
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly frameSequence: number;
  readonly cssViewportWidth: number;
  readonly cssViewportHeight: number;
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly devicePixelRatio: number;
  readonly captureScale: number;
  readonly scroll: { readonly x: number; readonly y: number };
  readonly digest: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly cursor: BrowserCursorSummary;
  readonly validUntil: string;
  readonly artifactId: string;
}

export interface BrowserDomObservation {
  readonly kind: "dom";
  readonly operationId: string;
  readonly domObservationId: string;
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly documentGeneration: number;
  readonly observedAt: string;
  readonly truncated: boolean;
  readonly nodes: readonly BrowserDomNode[];
}

export type BrowserObservation = BrowserScreenshotObservation | BrowserDomObservation;

export interface BrowserVisualFrame {
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly observationId: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly payloadBase64: string;
  readonly digest: string;
  readonly frameSequence: number;
  readonly viewportGeneration: number;
}

export interface BrowserOperationResult {
  readonly operationId: string;
  readonly state: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  readonly observation?: BrowserObservation;
}

export interface BrowserControlResult {
  readonly sessionId: string;
  readonly tabId: string;
  readonly controller: "agent" | "human";
  readonly controlEpoch: number;
}

export interface WebxProblem {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
