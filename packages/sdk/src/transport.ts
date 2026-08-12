import { ResponseLimitError } from "./errors.js";
import type { TransportRequest, TransportResponse, WebxTransport } from "./types.js";

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly retryCount?: number;
}

export class HttpTransport implements WebxTransport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #retryCount: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryCount = options.retryCount ?? 1;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retryCount; attempt += 1) {
      try {
        const response = await this.#fetch(new URL(request.path, this.options.baseUrl), {
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
            ...(this.options.bearerToken === undefined ? {} : { authorization: `Bearer ${this.options.bearerToken}` }),
            ...request.headers,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: request.signal,
        });
        const bytes = await readBoundedBody(response, request.maxResponseBytes);
        const text = new TextDecoder().decode(bytes);
        const contentType = response.headers.get("content-type") ?? "";
        const body = text.length === 0 ? undefined : contentType.includes("json") ? JSON.parse(text) as unknown : text;
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
      } catch (error) {
        if (request.signal?.aborted || error instanceof ResponseLimitError) throw error;
        lastError = error;
        if (attempt === this.#retryCount) break;
      }
    }
    throw lastError;
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new ResponseLimitError(limit);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new ResponseLimitError(limit);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface NdjsonConnection {
  send(line: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

export type NdjsonConnectionFactory = (socketPath: string) => Promise<NdjsonConnection>;

/**
 * Unix transport uses a supplied NDJSON socket connector. This keeps host-path
 * and socket access outside the SDK while retaining strict framing and bounds.
 */
export class UnixSocketTransport implements WebxTransport {
  constructor(
    private readonly socketPath: string,
    private readonly connect: NdjsonConnectionFactory,
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    const connection = await this.connect(this.socketPath);
    try {
      const line = await connection.send(JSON.stringify(request), request.signal);
      if (new TextEncoder().encode(line).byteLength > request.maxResponseBytes) {
        throw new ResponseLimitError(request.maxResponseBytes);
      }
      const response = JSON.parse(line) as TransportResponse;
      if (!Number.isInteger(response.status)) throw new TypeError("invalid Unix transport response status");
      return response;
    } finally {
      await connection.close();
    }
  }
}

export class InProcessTransport implements WebxTransport {
  constructor(private readonly handler: (request: TransportRequest) => Promise<TransportResponse>) {}
  request(request: TransportRequest): Promise<TransportResponse> {
    return this.handler(request);
  }
}
