// Change this versioned file name when the vendored facade changes so /reload imports new bytes.
import { WebxFacadeClient } from "../vendor/sdk/facade-live-search-reader-v1.js";

export const SUPPORTED_API_MAJOR = 1;

export interface WebxCapabilities {
  apiVersion: string;
  daemon: "ready" | "unavailable";
  groups: {
    web: boolean;
    browser: boolean;
    browserDebug: boolean;
    artifacts: boolean;
  };
  browserPathIds: readonly [string, string];
}

export interface WebxRequestOptions {
  signal: AbortSignal;
  idempotencyKey: string;
  ownerId: string;
  cwd: string;
}

export interface WebxArtifactPayload {
  artifactId: string;
  mediaType: string;
  dataBase64: string;
  size: number;
  complete: boolean;
  mode: "image" | "raw";
  offset?: number;
  nextOffset?: number | null;
  eof?: boolean;
}

export interface WebxApprovalDescriptor {
  id: string;
  operation: string;
  target: string;
  capability: string;
  budget: string;
  credentialRef?: string;
  reason: string;
  duration: string;
}

export interface WebxResult {
  title?: string;
  url?: string;
  summary: string;
  data?: unknown;
  artifacts?: readonly { id: string; kind?: string }[];
  artifactPayload?: WebxArtifactPayload;
  approval?: WebxApprovalDescriptor;
  trust?: "untrusted-external" | "local";
}

export interface WebxSdk {
  start(options: { signal: AbortSignal; ownerId: string; cwd: string }): Promise<void>;
  capabilities(options: { signal: AbortSignal; ownerId: string }): Promise<WebxCapabilities>;
  /** Aborting the signal must cancel any job created by this request. */
  request(operation: string, input: unknown, options: WebxRequestOptions): Promise<WebxResult>;
  decideApproval(approvalId: string, decision: "allow-once" | "deny", options: WebxRequestOptions): Promise<WebxResult>;
  stop(options: { ownerId: string }): Promise<void>;
}

export type WebxSdkFactory = () => WebxSdk;

export function createSdkClient(): WebxSdk {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory === undefined || runtimeDirectory.length === 0) {
    throw new Error("XDG_RUNTIME_DIR is required for the same-user WebX runtime.");
  }
  return new WebxFacadeClient(process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`);
}

export function apiMajor(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  if (!match?.[1]) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : undefined;
}
