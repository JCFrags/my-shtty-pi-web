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
export class ProxyBoundBrowserDestinationAuthority implements BrowserDestinationAuthority {
  constructor(
    private readonly proxyHost: string,
    private readonly proxyPort: number,
    private readonly resolver: DestinationResolver = new SystemDestinationResolver(),
  ) {
    if (proxyHost !== "127.0.0.1" && proxyHost !== "::1") throw new Error("browser egress proxy must use a loopback listener");
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("browser egress proxy port is invalid");
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
    await probeProxy(this.proxyHost, this.proxyPort, signal);
    return Object.freeze({
      mode: "egress-bound",
      normalizedUrl: destination.normalizedUrl,
      asciiHostname: destination.asciiHostname,
      port: destination.port,
      resolvedAddresses: Object.freeze([...addresses]),
      redirectPolicy: Object.freeze({ revalidateEveryHop: true, maxRedirects: 10 }),
      egressBindingId: `forward-proxy://${this.proxyHost}:${this.proxyPort}`,
    });
  }
}

export class FailClosedBrowserDestinationAuthority implements BrowserDestinationAuthority {
  constructor(private readonly resolver: DestinationResolver = new SystemDestinationResolver()) {}

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

export function actionDestination(action: BrowserAction): { operation: "navigate" | "new-tab"; url: string } | undefined {
  if (action.kind === "navigate") return { operation: "navigate", url: action.url };
  if (action.kind === "tab-new" && action.url !== undefined) return { operation: "new-tab", url: action.url };
  return undefined;
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
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new BrowserPortError("WEBX_EGRESS_UNAVAILABLE", "browser egress proxy is unavailable", 503, true));
    }, 1_000);
    const abort = () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new DOMException("egress probe was cancelled", "AbortError"));
    };
    const error = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new BrowserPortError("WEBX_EGRESS_UNAVAILABLE", "browser egress proxy is unavailable", 503, true));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", error);
    socket.once("connect", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.off("error", error);
      socket.end();
      resolve();
    });
  });
}

function policyPortError(error: unknown): BrowserPortError {
  if (error instanceof PolicyError) return new BrowserPortError(error.code, error.message, 403);
  return new BrowserPortError("WEBX_POLICY_DENIED", "browser destination policy failed", 403);
}
