export const WEBX_API_VERSION = "2.0.0" as const;
export const WEBX_API_MAJOR = 2 as const;
export const BROWSER_PROTOCOL_VERSION = "2.0.0" as const;
export const BROWSER_PATH_IDS = ["agent-browser/chrome", "pinchtab/chrome"] as const;

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
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly sameDomain?: boolean;
  readonly visibility?: Visibility;
}

export type DirectReadRequest = Pick<ReadRequest, "url" | "query" | "view" | "fields" | "itemOffset" | "itemLimit" | "maxChars" | "contentOffset">;

export interface ReadBatchRequest {
  readonly items: readonly DirectReadRequest[];
}

export type ReadBatchEnvelope =
  | { readonly index: number; readonly url: string; readonly ok: true; readonly result: BoundedContent }
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

export interface StoredContent extends BoundedContent {
  readonly metadata: {
    readonly contentId: string;
    readonly mode: "exact" | "findText" | "query";
    readonly totalCharacters: number;
    readonly returnedCharacters: number;
    readonly offset?: number;
    readonly nextOffset?: number | null;
    readonly matchOffset?: number;
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
  readonly visible?: boolean;
  readonly label?: string;
}

export interface BrowserSession {
  readonly sessionId: string;
  readonly tabId: string;
  readonly pathId: BrowserPathId;
  readonly ownerPrincipalId: string;
  readonly ownerAgentId: string;
  readonly state: "creating" | "ready" | "closing" | "closed" | "failed" | "recovering";
  readonly capabilities: BrowserPathCapability;
}

export interface BrowserAddress {
  readonly sessionId: string;
  readonly tabId: string;
  readonly pathId: BrowserPathId;
  readonly hostGeneration: number;
  readonly engineGeneration: number;
  readonly controlEpoch: number;
}

export interface VisualGuard {
  readonly viewportId: string;
  readonly viewportGeneration: number;
  readonly screenshotSha256: string;
  readonly screenshotSequence: number;
}

export type BrowserAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "mouse-move"; readonly x: number; readonly y: number; readonly visualGuard: VisualGuard }
  | { readonly kind: "mouse-down" | "mouse-up" | "click" | "double-click"; readonly x: number; readonly y: number; readonly button: "left" | "middle" | "right"; readonly visualGuard: VisualGuard }
  | { readonly kind: "click"; readonly ref?: string; readonly selector?: string }
  | { readonly kind: "wheel"; readonly deltaX: number; readonly deltaY: number; readonly visualGuard: VisualGuard }
  | { readonly kind: "drag"; readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number }; readonly visualGuard: VisualGuard }
  | { readonly kind: "key-press"; readonly key: string }
  | { readonly kind: "key-down" | "key-up"; readonly key: string; readonly code?: string; readonly modifiers?: number }
  | { readonly kind: "text-input"; readonly text: string }
  | { readonly kind: "fill" | "type"; readonly ref?: string; readonly selector?: string; readonly text: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "hover"; readonly ref?: string; readonly selector?: string }
  | { readonly kind: "scroll"; readonly direction: "up" | "down" | "left" | "right"; readonly amount?: number }
  | { readonly kind: "semantic-drag"; readonly ref: string; readonly targetRef: string }
  | { readonly kind: "select"; readonly ref?: string; readonly selector?: string; readonly values: readonly string[] }
  | { readonly kind: "download"; readonly ref: string }
  | { readonly kind: "wait"; readonly milliseconds?: number; readonly selector?: string; readonly text?: string }
  | { readonly kind: "tab-new"; readonly url?: string }
  | { readonly kind: "tab-close"; readonly tabId?: string }
  | { readonly kind: "tab-focus"; readonly tabId: string }
  | { readonly kind: "back" | "forward" | "reload" };

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

export interface BrowserObservation {
  readonly operationId: string;
  readonly observationId?: string;
  readonly address: BrowserAddress;
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly artifactId?: string;
  readonly screenshot?: {
    readonly artifactId: string;
    readonly sha256: string;
    readonly sequence: number;
    readonly viewportId: string;
    readonly viewportGeneration: number;
  };
}

export interface BrowserVisualFrame {
  readonly address: BrowserAddress;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly payloadBase64: string;
  readonly screenshotSha256: string;
  readonly screenshotSequence: number;
  readonly viewportId: string;
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
