import { lookup } from "node:dns/promises";
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
  readonly mode: "egress-bound" | "qualification-only";
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

const qualificationPaths = new Set(["/static", "/spa", "/visual-controls", "/workspace-states"]);

/**
 * This authority exists only for the isolated actual-qualification executable.
 * It permits exact non-redirecting fixture documents on 127.0.0.1. Production
 * main.ts never constructs it.
 */
export class IsolatedQualificationDestinationAuthority implements BrowserDestinationAuthority {
  constructor(private readonly resolver: DestinationResolver = new SystemDestinationResolver()) {}

  async authorize(request: BrowserDestinationRequest, signal?: AbortSignal): Promise<BrowserDestinationAuthorization> {
    const parsed = parseBrowserUrl(request.url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.search !== "" ||
      !qualificationPaths.has(parsed.pathname)
    ) {
      throw new BrowserPortError("WEBX_POLICY_QUALIFICATION_TARGET_DENIED", "qualification permits only an exact isolated fixture document", 403);
    }
    const addresses = await this.resolver.resolve(parsed.hostname.replace(/^\[|\]$/gu, ""), signal);
    if (addresses.length !== 1 || addresses[0] !== "127.0.0.1") {
      throw new BrowserPortError("WEBX_POLICY_QUALIFICATION_TARGET_DENIED", "qualification fixture resolution changed", 403);
    }
    return Object.freeze({
      mode: "qualification-only",
      normalizedUrl: parsed.toString(),
      asciiHostname: parsed.hostname,
      port: parsed.port === "" ? 80 : Number(parsed.port),
      resolvedAddresses: Object.freeze([...addresses]),
      redirectPolicy: Object.freeze({ revalidateEveryHop: true, maxRedirects: 0 }),
    });
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

function policyPortError(error: unknown): BrowserPortError {
  if (error instanceof PolicyError) return new BrowserPortError(error.code, error.message, 403);
  return new BrowserPortError("WEBX_POLICY_DENIED", "browser destination policy failed", 403);
}
