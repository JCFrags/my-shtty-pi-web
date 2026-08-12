import { ApiVersionError, asWebxError } from "./errors.js";
import {
  WEBX_API_MAJOR,
  type ArtifactExcerpt,
  type BoundedContent,
  type BrowserAction,
  type BrowserControlResult,
  type BrowserObservation,
  type BrowserOperationResult,
  type BrowserSession,
  type BrowserSessionRequest,
  type BrowserVisualFrame,
  type CapabilityCatalog,
  type ReadRequest,
  type RequestOptions,
  type ResearchRequest,
  type ResearchResponse,
  type SearchRequest,
  type SearchResponse,
  type TransportResponse,
  type VersionInfo,
  type WebxTransport,
} from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface WebxClientOptions {
  readonly maxResponseBytes?: number;
}

export class WebxClient {
  readonly #maxResponseBytes: number;
  #negotiated?: Promise<VersionInfo>;

  constructor(
    private readonly transport: WebxTransport,
    options: WebxClientOptions = {},
  ) {
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  version(signal?: AbortSignal): Promise<VersionInfo> {
    return this.call("GET", "/v1/version", undefined, { signal }, false);
  }

  async negotiate(signal?: AbortSignal): Promise<VersionInfo> {
    this.#negotiated ??= this.version(signal).then((version) => {
      const major = Number.parseInt(version.apiVersion.split(".", 1)[0] ?? "", 10);
      if (major !== WEBX_API_MAJOR) throw new ApiVersionError(WEBX_API_MAJOR, version.apiVersion);
      return version;
    }).catch((error: unknown) => {
      this.#negotiated = undefined;
      throw error;
    });
    return this.#negotiated;
  }

  capabilities(options: RequestOptions = {}): Promise<CapabilityCatalog> {
    return this.call("GET", "/v1/capabilities", undefined, options);
  }

  search(request: SearchRequest, options: RequestOptions): Promise<SearchResponse> {
    return this.call("POST", "/v1/search", request, requireIdempotency(options));
  }

  read(request: ReadRequest, options: RequestOptions): Promise<BoundedContent> {
    return this.call("POST", "/v1/read", request, requireIdempotency(options));
  }

  research(request: ResearchRequest, options: RequestOptions): Promise<ResearchResponse> {
    return this.call("POST", "/v1/research", request, requireIdempotency(options));
  }

  getPage(pageId: string, options: RequestOptions = {}): Promise<BoundedContent> {
    return this.call("GET", `/v1/pages/${encodeURIComponent(pageId)}`, undefined, options);
  }

  getArtifactExcerpt(artifactId: string, offset = 0, maxBytes = 16_384, options: RequestOptions = {}): Promise<ArtifactExcerpt> {
    const query = new URLSearchParams({ offset: String(offset), max_bytes: String(maxBytes) });
    return this.call("GET", `/v1/artifacts/${encodeURIComponent(artifactId)}/excerpt?${query}`, undefined, options);
  }

  createBrowserSession(request: BrowserSessionRequest, options: RequestOptions): Promise<BrowserSession> {
    return this.call("POST", "/v1/browser/sessions", request, requireIdempotency(options));
  }

  getBrowserSession(sessionId: string, options: RequestOptions = {}): Promise<BrowserSession> {
    return this.call("GET", `/v1/browser/sessions/${encodeURIComponent(sessionId)}`, undefined, options);
  }

  observeBrowser(sessionId: string, view: "main" | "interactive" | "visual" | "full" | "diff", maxChars: number, options: RequestOptions): Promise<BrowserObservation> {
    return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/observe`, { view, maxChars }, requireIdempotency(options));
  }

  getBrowserVisualFrame(sessionId: string, options: RequestOptions): Promise<BrowserVisualFrame> {
    return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/frame`, {}, requireIdempotency(options));
  }

  actBrowser(sessionId: string, action: BrowserAction, options: RequestOptions): Promise<BrowserOperationResult> {
    return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/actions`, { action }, requireIdempotency(options));
  }

  setBrowserControl(sessionId: string, controller: "human" | "agent", options: RequestOptions): Promise<BrowserControlResult> {
    return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/control`, { controller }, requireIdempotency(options));
  }

  cancelBrowserOperation(operationId: string, options: RequestOptions): Promise<BrowserOperationResult> {
    return this.call("POST", `/v1/browser/operations/${encodeURIComponent(operationId)}/cancel`, {}, requireIdempotency(options));
  }

  closeBrowserSession(sessionId: string, options: RequestOptions): Promise<void> {
    return this.call("DELETE", `/v1/browser/sessions/${encodeURIComponent(sessionId)}`, undefined, requireIdempotency(options));
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    options: RequestOptions,
    negotiate = true,
  ): Promise<T> {
    if (negotiate) await this.negotiate(options.signal);
    const response: TransportResponse = await this.transport.request({
      method,
      path,
      body,
      signal: options.signal,
      maxResponseBytes: this.#maxResponseBytes,
      headers: options.idempotencyKey === undefined ? undefined : { "idempotency-key": options.idempotencyKey },
    });
    if (response.status < 200 || response.status >= 300) throw asWebxError(response.status, response.body);
    return response.body as T;
  }
}

function requireIdempotency(options: RequestOptions): RequestOptions {
  if (options.idempotencyKey === undefined || options.idempotencyKey.length < 8) {
    throw new TypeError("an idempotency key of at least 8 characters is required");
  }
  return options;
}
