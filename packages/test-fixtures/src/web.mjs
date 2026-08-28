import { badCharsetBodies, compressedLargeBody, largeBody, sha256 } from "./content.mjs";

export const WEB_FIXTURE_SEED = "webx-web-failure-fixtures-v1";

export const mixedDnsCases = Object.freeze([
  Object.freeze({
    id: "mixed-dns-a-public-private",
    hostnameAscii: "mixed-a.fixture.invalid",
    resolvedAddresses: Object.freeze(["192.0.2.80", "10.0.0.80"]),
    expectedDecision: "deny",
    reasonCode: "network.resolved_set_denied",
  }),
  Object.freeze({
    id: "mixed-dns-aaaa-public-link-local",
    hostnameAscii: "mixed-aaaa.fixture.invalid",
    resolvedAddresses: Object.freeze(["2001:db8::80", "fe80::80"]),
    expectedDecision: "deny",
    reasonCode: "network.resolved_set_denied",
  }),
]);

const responseCases = Object.freeze([
  Object.freeze({ id: "slow", path: "/failure/slow?ms=25", expected: "delayed", delayMs: 25 }),
  Object.freeze({ id: "endless", path: "/failure/endless", expected: "client_timeout", prefix: "endless fixture prefix\n" }),
  Object.freeze({ id: "oversized", path: "/bounds/large", expected: "body_limit", sizeBytes: largeBody.length, contentSha256: sha256(largeBody) }),
  Object.freeze({ id: "compressed-expansion", path: "/bounds/compressed", expected: "expanded_body_limit", compressedBytes: compressedLargeBody.length, expandedBytes: largeBody.length, compressedSha256: sha256(compressedLargeBody), expandedSha256: sha256(largeBody) }),
  Object.freeze({ id: "partial-body", path: "/failure/partial-body", expected: "incomplete_body", declaredBytes: 64, sentBytes: 23 }),
  Object.freeze({ id: "disconnect", path: "/failure/disconnect", expected: "connection_failure" }),
  Object.freeze({ id: "status-503", path: "/failure/status/503", expected: "http_failure", status: 503 }),
]);

const redirectCases = Object.freeze([
  Object.freeze({ id: "loop-a", path: "/redirect/loop/a", location: "/redirect/loop/b", expected: "redirect_loop" }),
  Object.freeze({ id: "loop-b", path: "/redirect/loop/b", location: "/redirect/loop/a", expected: "redirect_loop" }),
  Object.freeze({ id: "private-address", path: "/redirect/private-address", location: "http://10.0.0.7/private", expected: "deny" }),
  Object.freeze({ id: "link-local", path: "/redirect/link-local", location: "http://169.254.169.254/latest/meta-data", expected: "deny" }),
  Object.freeze({ id: "non-http", path: "/redirect/non-http", location: "file:///webx-fixture/blocked", expected: "deny" }),
]);

const charsetCases = Object.freeze([
  Object.freeze({ id: "unknown", path: "/encoding/unknown", declaredCharset: "x-webx-invalid", contentSha256: sha256(badCharsetBodies.unknown), expected: "charset_error" }),
  Object.freeze({ id: "mismatch", path: "/encoding/mismatch", declaredCharset: "us-ascii", contentSha256: sha256(badCharsetBodies.mismatch), expected: "charset_mismatch" }),
  Object.freeze({ id: "malformed-utf8", path: "/encoding/malformed-utf8", declaredCharset: "utf-8", contentSha256: sha256(badCharsetBodies.malformedUtf8), expected: "decode_error" }),
]);

export function createWebManifest() {
  const cases = { responses: responseCases, redirects: redirectCases, mixedDns: mixedDnsCases, charsets: charsetCases };
  const manifestSha256 = sha256(JSON.stringify(cases));
  return Object.freeze({
    schemaVersion: "1.0.0",
    fixtureVersion: `1.0.0+sha256.${manifestSha256.slice(0, 16)}`,
    seed: WEB_FIXTURE_SEED,
    generatedAt: "2026-08-27T00:00:00Z",
    license: "CC0-1.0 generated; documentation-only DNS and redirect targets",
    ...cases,
    manifestSha256,
  });
}
