import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import type { BrowserAction } from "../../../packages/sdk/src/index.js";
import { PolicyError, validatePublicDestination, type ValidatedDestination } from "../../../packages/policy/src/index.js";
import { BrowserPortError, type AuthorityActor } from "./ports.js";

export type BrowserDestinationOperation = "initial" | "navigate" | "new-tab";

export interface BrowserDestinationRequest {
  readonly actor: AuthorityActor;
  readonly operationId: string;
  readonly operation: BrowserDestinationOperation;
  readonly url: string;
}

export interface BrowserDestinationAuthorization {
  readonly mode: "egress-bound";
  readonly normalizedUrl: string;
  readonly asciiHostname: string;
  readonly port: number;
  readonly resolvedAddresses: readonly string[];
  readonly redirectPolicy: {
    readonly revalidateEveryHop: true;
    readonly maxRedirects: number;
  };
  readonly egressBindingId?: string;
}

export interface BrowserDestinationAuthority {
  readonly egressBindingId?: string;
  assertReady(signal?: AbortSignal): Promise<void>;
  authorize(request: BrowserDestinationRequest, signal?: AbortSignal): Promise<BrowserDestinationAuthorization>;
}

export interface DestinationResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly string[]>;
}

export class SystemDestinationResolver implements DestinationResolver {
  async resolve(hostname: string, signal?: AbortSignal): Promise<readonly string[]> {
    if (signal?.aborted) throw new DOMException("destination resolution was cancelled", "AbortError");
    try {
      const answers = await lookup(hostname, { all: true, verbatim: true });
      if (signal?.aborted) throw new DOMException("destination resolution was cancelled", "AbortError");
      return [...new Set(answers.map((answer) => answer.address))];
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new BrowserPortError("WEBX_DNS_FAILED", "browser destination resolution failed", 403);
    }
  }
}

/**
 * Production browser URLs fail closed until an egress authority binds the real
 * browser connection. URL parsing and DNS checks alone do not stop rebinding or
 * redirects, so this class never treats them as sufficient authority.
 */
export function proxyBoundDestinationAuthorityFromUrl(raw: string): ProxyBoundBrowserDestinationAuthority {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("WEBX_EGRESS_PROXY must be a plain loopback HTTP proxy URL"); }
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error("WEBX_EGRESS_PROXY must be a plain loopback HTTP proxy URL");
  const hostname = parsed.hostname === "[::1]" ? "::1" : parsed.hostname;
  return new ProxyBoundBrowserDestinationAuthority(hostname, parsed.port === "" ? 80 : Number(parsed.port));
}

export class ProxyBoundBrowserDestinationAuthority implements BrowserDestinationAuthority {
  readonly egressBindingId: string;

  constructor(
    private readonly proxyHost: string,
    private readonly proxyPort: number,
    private readonly resolver: DestinationResolver = new SystemDestinationResolver(),
  ) {
    if (proxyHost !== "127.0.0.1" && proxyHost !== "::1") throw new Error("browser egress proxy must use a loopback listener");
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("browser egress proxy port is invalid");
    this.egressBindingId = `forward-proxy://${proxyHost === "::1" ? "[::1]" : proxyHost}:${proxyPort}`;
  }

  async assertReady(signal?: AbortSignal): Promise<void> {
    await probeProxy(this.proxyHost, this.proxyPort, signal);
  }

  async authorize(request: BrowserDestinationRequest, signal?: AbortSignal): Promise<BrowserDestinationAuthorization> {
    const parsed = parseBrowserUrl(request.url);
    try {
      validatePublicDestination(request.url, ["8.8.8.8"]);
    } catch (error) {
      throw policyPortError(error);
    }
    const addresses = await this.resolver.resolve(parsed.hostname.replace(/^\[|\]$/gu, ""), signal);
    let destination: ValidatedDestination;
    try {
      destination = validatePublicDestination(request.url, addresses);
    } catch (error) {
      throw policyPortError(error);
    }
    await this.assertReady(signal);
    return Object.freeze({
      mode: "egress-bound",
      normalizedUrl: destination.normalizedUrl,
      asciiHostname: destination.asciiHostname,
      port: destination.port,
      resolvedAddresses: Object.freeze([...addresses]),
      redirectPolicy: Object.freeze({ revalidateEveryHop: true, maxRedirects: 10 }),
      egressBindingId: this.egressBindingId,
    });
  }
}

export class FailClosedBrowserDestinationAuthority implements BrowserDestinationAuthority {
  constructor(private readonly resolver: DestinationResolver = new SystemDestinationResolver()) {}

  async assertReady(): Promise<void> {
    throw new BrowserPortError(
      "WEBX_POLICY_EGRESS_REQUIRED",
      "browser session creation requires a healthy connection-bound egress route",
      503,
      true,
    );
  }

  async authorize(request: BrowserDestinationRequest, signal?: AbortSignal): Promise<BrowserDestinationAuthorization> {
    const parsed = parseBrowserUrl(request.url);
    try {
      validatePublicDestination(request.url, ["8.8.8.8"]);
    } catch (error) {
      throw policyPortError(error);
    }
    const addresses = await this.resolver.resolve(parsed.hostname.replace(/^\[|\]$/gu, ""), signal);
    let destination: ValidatedDestination;
    try {
      destination = validatePublicDestination(request.url, addresses);
    } catch (error) {
      throw policyPortError(error);
    }
    void destination;
    throw new BrowserPortError(
      "WEBX_POLICY_EGRESS_REQUIRED",
      "browser navigation requires connection-bound egress and per-hop redirect enforcement",
      403,
    );
  }
}

export function actionDestination(action: BrowserAction): { operation: "navigate"; url: string } | undefined {
  return action.kind === "navigate" ? { operation: "navigate", url: action.url } : undefined;
}

function parseBrowserUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new BrowserPortError("WEBX_URL_INVALID", "browser destination URL is invalid", 400);
  }
}

async function probeProxy(host: string, port: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("egress probe was cancelled", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const unavailable = () => new BrowserPortError("WEBX_EGRESS_UNAVAILABLE", "browser egress proxy failed its functional readiness probe", 503, true);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.destroy();
      if (error === undefined) resolve(); else reject(error);
    };
    const validate = () => {
      const response = Buffer.concat(chunks).toString("latin1");
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const lines = response.slice(0, boundary).split("\r\n");
      if (lines.shift() !== "HTTP/1.1 204 No Content") { finish(unavailable()); return; }
      const headers = new Map(lines.map((line) => { const index = line.indexOf(":"); return index <= 0 ? ["", ""] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]; }));
      if (headers.get("webx-egress-proxy") !== "secure-egress/1" || headers.get("content-length") !== "0" || response.length !== boundary + 4) { finish(unavailable()); return; }
      finish();
    };
    const timeout = setTimeout(() => finish(unavailable()), 1_000);
    timeout.unref?.();
    const abort = () => finish(new DOMException("egress probe was cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => finish(unavailable()));
    socket.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 4_096) { finish(unavailable()); return; } chunks.push(chunk); validate(); });
    socket.once("end", () => { if (!settled) validate(); if (!settled) finish(unavailable()); });
    socket.once("connect", () => socket.write("GET http://webx-egress.invalid/.well-known/webx-egress-health HTTP/1.1\r\nHost: webx-egress.invalid\r\nConnection: close\r\n\r\n"));
    if (signal?.aborted) abort();
  });
}

function policyPortError(error: unknown): BrowserPortError {
  if (error instanceof PolicyError) return new BrowserPortError(error.code, error.message, 403);
  return new BrowserPortError("WEBX_POLICY_DENIED", "browser destination policy failed", 403);
}
