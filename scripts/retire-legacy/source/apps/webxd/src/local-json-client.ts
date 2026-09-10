const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface LocalJsonLimit {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export const LOCAL_JSON_LIMITS = Object.freeze({
  searxQuery: Object.freeze({ timeoutMs: 15_000, maxBodyBytes: 2 * 1024 * 1024 }),
  reader: Object.freeze({ timeoutMs: 45_000, maxBodyBytes: 4 * 1024 * 1024 }),
  health: Object.freeze({ timeoutMs: 2_000, maxBodyBytes: 2 * 1024 * 1024 }),
});

export interface LocalJsonResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly payload?: T;
  readonly bodyText: string;
}

export class LocalJsonClientError extends Error {
  constructor(
    readonly code: "invalid-local-url" | "body-too-large" | "invalid-json",
    message: string,
  ) {
    super(message);
    this.name = "LocalJsonClientError";
  }
}

/** A bounded client for the loopback JSON services that webxd owns. */
export class BoundedLocalJsonClient {
  async request<T>(url: URL, init: RequestInit, limit: LocalJsonLimit, callerSignal?: AbortSignal): Promise<LocalJsonResponse<T>> {
    assertLocalHttpUrl(url);
    const deadline = AbortSignal.timeout(limit.timeoutMs);
    const signal = callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    const response = await fetch(url, { ...init, signal, headers });
    const bodyBytes = await readBoundedBody(response, limit.maxBodyBytes);
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);
    if (bodyText.length === 0) return { ok: response.ok, status: response.status, bodyText };
    try {
      return { ok: response.ok, status: response.status, bodyText, payload: JSON.parse(bodyText) as T };
    } catch (error) {
      if (!response.ok) return { ok: false, status: response.status, bodyText };
      throw new LocalJsonClientError("invalid-json", `local service returned invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    }
  }
}

export function localHttpConfigurationError(rawUrl: string): string | undefined {
  try {
    assertLocalHttpUrl(new URL(rawUrl));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "local service URL is invalid";
  }
}

function assertLocalHttpUrl(url: URL): void {
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new LocalJsonClientError("invalid-local-url", "local service URL must use HTTP on a loopback host");
  }
  if (url.username !== "" || url.password !== "") {
    throw new LocalJsonClientError("invalid-local-url", "local service URL must not contain credentials");
  }
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("maxBodyBytes must be a positive safe integer");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBodyBytes) {
    await response.body?.cancel();
    throw new LocalJsonClientError("body-too-large", `local service response exceeded ${maxBodyBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new LocalJsonClientError("body-too-large", `local service response exceeded ${maxBodyBytes} bytes`);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
