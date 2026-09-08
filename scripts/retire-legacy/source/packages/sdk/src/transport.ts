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
export interface UnixActorIdentity {
  readonly principalId: string;
  readonly agentId: string;
}

export interface UnixActorBinding { readonly bindingId: string; readonly bindingSecret: string }

export class UnixSocketTransport implements WebxTransport {
  #binding?: UnixActorBinding;
  #bindingOwnerId?: string;
  #connection?: NdjsonConnection;
  #lane: Promise<void> = Promise.resolve();
  constructor(
    private readonly socketPath: string,
    private readonly connect: NdjsonConnectionFactory,
    private readonly actor?: UnixActorIdentity,
  ) {}

  bind(ownerId: string, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      if (this.#bindingOwnerId !== undefined && this.#bindingOwnerId !== ownerId) throw new Error("Unix actor binding owner mismatch");
      this.#bindingOwnerId = ownerId;
      if (this.#binding === undefined) await this.refreshBinding(signal);
    });
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if (this.#bindingOwnerId !== undefined && this.#binding === undefined) await this.refreshBinding(request.signal);
          const sentBinding = this.#binding;
          const response = await this.send(request, sentBinding);
          if (attempt === 0 && sentBinding !== undefined && isInvalidRuntimeBinding(response)) {
            await this.resetConnection();
            continue;
          }
          return response;
        } catch (error) {
          if (request.signal?.aborted || error instanceof ResponseLimitError || attempt > 0) throw error;
          await this.resetConnection();
        }
      }
      throw new Error("Unix actor binding recovery failed");
    });
  }

  close(): Promise<void> { return this.exclusive(async () => this.resetConnection()); }

  private async refreshBinding(signal?: AbortSignal): Promise<void> {
    const ownerId = this.#bindingOwnerId;
    if (ownerId === undefined) throw new Error("Unix actor binding owner is unavailable");
    const connection = await this.connection();
    const line = await connection.send(JSON.stringify({ bind: { ownerId } }), signal);
    const response = JSON.parse(line) as { bindingId?: unknown; bindingSecret?: unknown };
    if (typeof response.bindingId !== "string" || typeof response.bindingSecret !== "string") throw new TypeError("invalid Unix actor binding response");
    this.#binding = { bindingId: response.bindingId, bindingSecret: response.bindingSecret };
  }

  private async send(request: TransportRequest, binding: UnixActorBinding | undefined): Promise<TransportResponse> {
    const connection = await this.connection();
    const serializable = { ...request, signal: undefined };
    const wire = binding === undefined ? this.actor === undefined ? serializable : { actor: this.actor, request: serializable } : { binding, request: serializable };
    const line = await connection.send(JSON.stringify(wire), request.signal);
    if (new TextEncoder().encode(line).byteLength > request.maxResponseBytes) throw new ResponseLimitError(request.maxResponseBytes);
    const response = JSON.parse(line) as TransportResponse;
    if (!Number.isInteger(response.status)) throw new TypeError("invalid Unix transport response status");
    return response;
  }

  private async connection(): Promise<NdjsonConnection> { this.#connection ??= await this.connect(this.socketPath); return this.#connection; }
  private async resetConnection(): Promise<void> { const connection = this.#connection; this.#connection = undefined; this.#binding = undefined; if (connection !== undefined) await connection.close().catch(() => undefined); }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const result = this.#lane.then(operation, operation); this.#lane = result.then(() => undefined, () => undefined); return result; }
}

function isInvalidRuntimeBinding(response: TransportResponse): boolean {
  if (response.status !== 400 || typeof response.body !== "object" || response.body === null) return false;
  const body = response.body as { code?: unknown; message?: unknown };
  return body.code === "invalid-wire-request" && body.message === "runtime actor binding is invalid";
}

export class InProcessTransport implements WebxTransport {
  constructor(private readonly handler: (request: TransportRequest) => Promise<TransportResponse>) {}
  request(request: TransportRequest): Promise<TransportResponse> {
    return this.handler(request);
  }
}
