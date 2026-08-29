import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BrowserProtocolError } from "./errors.js";

export interface NavigationAuthorizationClaims {
  readonly version: 1;
  readonly runtimeInstanceId: string;
  readonly principalId: string;
  readonly agentSessionId: string;
  readonly operationId: string;
  readonly normalizedUrl: string;
  readonly egressBindingId: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface NavigationAuthorizationInput {
  readonly runtimeInstanceId: string;
  readonly principalId: string;
  readonly agentSessionId: string;
  readonly operationId: string;
  readonly normalizedUrl: string;
  readonly egressBindingId: string;
  readonly expiresAt: string;
  readonly nonce?: string;
}

export function signNavigationAuthorization(input: NavigationAuthorizationInput, signingSecret: string): string {
  assertSecret(signingSecret);
  const claims: NavigationAuthorizationClaims = {
    version: 1,
    runtimeInstanceId: input.runtimeInstanceId,
    principalId: input.principalId,
    agentSessionId: input.agentSessionId,
    operationId: input.operationId,
    normalizedUrl: normalizeHttpUrl(input.normalizedUrl),
    egressBindingId: input.egressBindingId,
    expiresAt: input.expiresAt,
    nonce: input.nonce ?? randomBytes(18).toString("base64url"),
  };
  validateClaims(claims);
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signature(payload, signingSecret)}`;
}

export function verifyNavigationAuthorization(
  token: string,
  expected: Omit<NavigationAuthorizationInput, "expiresAt" | "nonce"> & { readonly nowMs?: number },
  signingSecret: string,
): NavigationAuthorizationClaims {
  assertSecret(signingSecret);
  const separator = token.indexOf(".");
  if (separator < 1 || token.indexOf(".", separator + 1) !== -1) throw denied();
  const payload = token.slice(0, separator);
  const received = token.slice(separator + 1);
  const wanted = signature(payload, signingSecret);
  const left = Buffer.from(received);
  const right = Buffer.from(wanted);
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) throw denied();
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw denied(); }
  validateClaims(claims);
  const normalizedUrl = normalizeHttpUrl(expected.normalizedUrl);
  if (claims.runtimeInstanceId !== expected.runtimeInstanceId || claims.principalId !== expected.principalId || claims.agentSessionId !== expected.agentSessionId || claims.operationId !== expected.operationId || claims.normalizedUrl !== normalizedUrl || claims.egressBindingId !== expected.egressBindingId) throw denied();
  const now = expected.nowMs ?? Date.now();
  const expires = Date.parse(claims.expiresAt);
  if (!Number.isFinite(expires) || expires <= now || expires - now > 60_000) throw denied();
  return claims;
}

function signature(payload: string, signingSecret: string): string {
  return createHmac("sha256", Buffer.from(signingSecret, "base64url")).update(payload).digest("base64url");
}

function validateClaims(value: unknown): asserts value is NavigationAuthorizationClaims {
  if (!isRecord(value) || value.version !== 1 || !validId(value.runtimeInstanceId) || !validId(value.principalId) || !validId(value.agentSessionId) || !validId(value.operationId) || typeof value.normalizedUrl !== "string" || value.normalizedUrl.length > 8192 || typeof value.egressBindingId !== "string" || value.egressBindingId.length < 1 || value.egressBindingId.length > 256 || typeof value.expiresAt !== "string" || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce)) throw denied();
  normalizeHttpUrl(value.normalizedUrl);
}

function assertSecret(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new BrowserProtocolError("AUTH_FAILED", "Navigation signing secret is invalid.");
}
function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw denied(); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") throw denied();
  return parsed.href;
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function denied(): BrowserProtocolError { return new BrowserProtocolError("NAVIGATION_DENIED", "Navigation authorization is invalid or expired."); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
