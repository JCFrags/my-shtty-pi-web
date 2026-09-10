import { ApiVersionError, asWebxError } from "./errors.js";
import type { UnixSocketTransport } from "./transport.js";
import {
  WEBX_API_MAJOR,
  type ArtifactByteExcerpt,
  type CapabilityCatalog,
  type CrawlRequest,
  type CrawlResponse,
  type ContentRequest,
  type StoredContent,
  type RangeReadRequest,
  type RangeReadResponse,
  type ReadRequest,
  type ReadContent,
  type ReadBatchRequest,
  type ReadBatchResponse,
  type RequestOptions,
  type SearchRequest,
  type SearchResponse,
  type TransportResponse,
  type VersionInfo,
  type WebxTransport,
} from "./types.js";

// This includes the JSON and base64 envelope for one complete image of at most 4 MiB.
const DEFAULT_MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

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

  bind(ownerId: string, signal?: AbortSignal): Promise<void> {
    const transport = this.transport as WebxTransport & Partial<Pick<UnixSocketTransport, "bind">>;
    return transport.bind === undefined ? Promise.resolve() : transport.bind(ownerId, signal);
  }

  async close(): Promise<void> { await this.transport.close?.(); }

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

  read(request: ReadRequest, options: RequestOptions): Promise<ReadContent> {
    return this.call("POST", "/v1/read", request, requireIdempotency(options));
  }

  readBatch(request: ReadBatchRequest, options: RequestOptions): Promise<ReadBatchResponse> {
    return this.call("POST", "/v1/read-batch", request, requireIdempotency(options));
  }

  content(request: ContentRequest, options: RequestOptions): Promise<StoredContent> {
    return this.call("POST", "/v1/content", request, requireIdempotency(options));
  }

  crawl(request: CrawlRequest, options: RequestOptions): Promise<CrawlResponse> {
    return this.call("POST", "/v1/crawl", request, requireIdempotency(options));
  }

  readRange(request: RangeReadRequest, options: RequestOptions): Promise<RangeReadResponse> {
    return this.call("POST", "/v1/read-range", request, requireIdempotency(options));
  }

  getArtifactBytes(artifactId: string, offset = 0, maxBytes = 49_152, options: RequestOptions = {}): Promise<ArtifactByteExcerpt> {
    const query = new URLSearchParams({ offset: String(offset), max_bytes: String(maxBytes) });
    return this.call("GET", `/v1/artifacts/${encodeURIComponent(artifactId)}/bytes?${query}`, undefined, options);
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
