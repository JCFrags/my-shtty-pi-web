import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { sha256 } from "./content.mjs";

export const ADVERSARIAL_SEED = "webx-adversarial-fixtures-v1";

export const SECRET_CANARIES = Object.freeze({
  authorization: "WEBX_TEST_SECRET_authorization_67c20a1e",
  cookie: "WEBX_TEST_SECRET_cookie_f198e554",
  query: "WEBX_TEST_SECRET_query_bdc2792a",
  signedUrl: "WEBX_TEST_SECRET_signed_url_44735e6b",
  form: "WEBX_TEST_SECRET_form_d11c72aa",
  workerToken: "WEBX_TEST_SECRET_worker_token_194a093a",
  egressToken: "WEBX_TEST_SECRET_egress_token_6f3573c1",
  browserInput: "WEBX_TEST_SECRET_browser_input_73bac4de",
  parserError: "WEBX_TEST_SECRET_parser_error_e88c3204",
  hostileText: "WEBX_TEST_SECRET_hostile_text_a251d826",
});

export const ssrfCases = Object.freeze([
  ["ssrf-loopback-v4", "http://127.0.0.1:{protectedPort}/protected/resource", ["127.0.0.1"], "network.loopback_denied"],
  ["ssrf-loopback-v6", "http://[::1]:{protectedPort}/protected/resource", ["::1"], "network.loopback_denied"],
  ["ssrf-private-v4", "http://10.0.0.7/private", ["10.0.0.7"], "network.private_denied"],
  ["ssrf-link-local", "http://169.254.17.2/latest", ["169.254.17.2"], "network.link_local_denied"],
  ["ssrf-metadata-v4", "http://169.254.169.254/latest/meta-data", ["169.254.169.254"], "network.metadata_denied"],
  ["ssrf-cgnat", "http://100.64.0.1/resource", ["100.64.0.1"], "network.cgnat_denied"],
  ["ssrf-multicast", "http://224.0.0.1/resource", ["224.0.0.1"], "network.multicast_denied"],
  ["ssrf-unspecified", "http://0.0.0.0/resource", ["0.0.0.0"], "network.unspecified_denied"],
  ["ssrf-ipv4-mapped-v6", "http://[::ffff:127.0.0.1]/resource", ["::ffff:127.0.0.1"], "network.loopback_denied"],
  ["ssrf-decimal-ipv4", "http://2130706433/resource", ["127.0.0.1"], "network.encoded_address_denied"],
  ["ssrf-hex-ipv4", "http://0x7f000001/resource", ["127.0.0.1"], "network.encoded_address_denied"],
  ["ssrf-octal-ipv4", "http://0177.0.0.1/resource", ["127.0.0.1"], "network.encoded_address_denied"],
  ["ssrf-ipv6-zone", "http://[fe80::1%25eth0]/resource", ["fe80::1"], "network.zone_identifier_denied"],
  ["ssrf-mixed-answer", "http://mixed.fixture.invalid/resource", ["192.0.2.20", "127.0.0.1"], "network.resolved_set_denied"],
].map(([id, url, resolvedAddresses, reasonCode]) => Object.freeze({
  id,
  kind: "destination",
  url,
  resolvedAddresses: Object.freeze(resolvedAddresses),
  expectedDecision: "deny",
  reasonCode,
  expectedProtectedPackets: 0,
})));

export const dnsRebindingSequences = Object.freeze([
  Object.freeze({
    id: "dns-rebind-public-to-loopback",
    hostnameAscii: "rebind.fixture.invalid",
    answersByResolution: Object.freeze([
      Object.freeze(["192.0.2.40"]),
      Object.freeze(["127.0.0.1"]),
    ]),
    expectedDecision: "deny",
    reasonCode: "network.dns_answer_changed",
    expectedProtectedPackets: 0,
  }),
  Object.freeze({
    id: "dns-rebind-aaaa-public-to-link-local",
    hostnameAscii: "rebind-v6.fixture.invalid",
    answersByResolution: Object.freeze([
      Object.freeze(["2001:db8::40"]),
      Object.freeze(["fe80::1"]),
    ]),
    expectedDecision: "deny",
    reasonCode: "network.dns_answer_changed",
    expectedProtectedPackets: 0,
  }),
]);

export const redirectCases = Object.freeze([
  Object.freeze({
    id: "redirect-public-to-loopback",
    hops: Object.freeze([
      Object.freeze({ url: "https://public.fixture.invalid/start", addresses: Object.freeze(["192.0.2.50"]), decision: "allow" }),
      Object.freeze({ url: "http://127.0.0.1:{protectedPort}/protected/resource", addresses: Object.freeze(["127.0.0.1"]), decision: "deny" }),
    ]),
    reasonCode: "network.redirect_target_denied",
    expectedProtectedPackets: 0,
  }),
  Object.freeze({
    id: "redirect-public-to-metadata",
    hops: Object.freeze([
      Object.freeze({ url: "https://public.fixture.invalid/start", addresses: Object.freeze(["192.0.2.51"]), decision: "allow" }),
      Object.freeze({ url: "http://169.254.169.254/latest/meta-data", addresses: Object.freeze(["169.254.169.254"]), decision: "deny" }),
    ]),
    reasonCode: "network.metadata_denied",
    expectedProtectedPackets: 0,
  }),
  Object.freeze({
    id: "redirect-credential-origin-change",
    hops: Object.freeze([
      Object.freeze({ url: "https://auth.fixture.invalid/start", addresses: Object.freeze(["192.0.2.52"]), decision: "allow", credentialOrigin: "https://auth.fixture.invalid" }),
      Object.freeze({ url: "https://other.fixture.invalid/collect", addresses: Object.freeze(["192.0.2.53"]), decision: "deny", credentialOrigin: null }),
    ]),
    reasonCode: "credential.redirect_origin_denied",
    expectedProtectedPackets: 0,
  }),
]);

export const browserSubresourceCandidates = Object.freeze([
  ["browser-fetch-loopback", "fetch", "http://127.0.0.1:{protectedPort}/protected/resource"],
  ["browser-xhr-metadata", "xhr", "http://169.254.169.254/latest/meta-data"],
  ["browser-websocket-loopback", "websocket", "ws://127.0.0.1:{protectedPort}/protected/resource"],
  ["browser-iframe-private", "iframe", "http://10.0.0.9/private"],
  ["browser-service-worker-import", "service_worker", "http://127.0.0.1:{protectedPort}/subresources/app.js"],
  ["browser-media-segment", "media", "http://169.254.169.254/media/segment.ts"],
].map(([id, channel, url]) => Object.freeze({
  id,
  channel,
  url,
  expectedDecision: "deny",
  reasonCode: "network.browser_subresource_denied",
  expectedProtectedPackets: 0,
})));

function writeTarString(buffer, offset, length, value) {
  buffer.write(value.slice(0, length), offset, length, "utf8");
}

function tarEntry(name, type = "0", linkName = "", size = 0) {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, "0000600\0");
  writeTarString(header, 108, 8, "0000000\0");
  writeTarString(header, 116, 8, "0000000\0");
  writeTarString(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeTarString(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 157, 100, linkName);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export const generatedFiles = Object.freeze({
  traversalTar: Buffer.concat([tarEntry("../../outside.txt"), Buffer.alloc(1024)]),
  absolutePathTar: Buffer.concat([tarEntry("/etc/webx-fixture"), Buffer.alloc(1024)]),
  symlinkTar: Buffer.concat([tarEntry("safe/link", "2", "../../outside.txt"), Buffer.alloc(1024)]),
  malformedPdf: Buffer.from("%PDF-1.7\n1 0 obj<</Length 999999999>>stream\ntruncated", "ascii"),
  compressionBombGzip: gzipSync(Buffer.alloc(1024 * 1024, 0x41), { level: 9, mtime: 0 }),
});

export const archiveDocumentCases = Object.freeze([
  Object.freeze({ id: "archive-path-traversal", file: "traversalTar", format: "tar", expected: "deny", reasonCode: "archive.path_traversal", limits: Object.freeze({ maxEntries: 100, maxExpandedBytes: 1048576, maxDepth: 4 }) }),
  Object.freeze({ id: "archive-absolute-path", file: "absolutePathTar", format: "tar", expected: "deny", reasonCode: "archive.absolute_path", limits: Object.freeze({ maxEntries: 100, maxExpandedBytes: 1048576, maxDepth: 4 }) }),
  Object.freeze({ id: "archive-symlink-escape", file: "symlinkTar", format: "tar", expected: "deny", reasonCode: "archive.symlink", limits: Object.freeze({ maxEntries: 100, maxExpandedBytes: 1048576, maxDepth: 4 }) }),
  Object.freeze({ id: "archive-compression-ratio", file: "compressionBombGzip", format: "gzip", expected: "deny", reasonCode: "archive.compression_ratio", limits: Object.freeze({ maxExpandedBytes: 65536, maxCompressionRatio: 20 }) }),
  Object.freeze({ id: "document-malformed-pdf", file: "malformedPdf", format: "pdf", expected: "quarantine", reasonCode: "document.malformed", limits: Object.freeze({ maxBytes: 1048576, maxPages: 20, timeoutMs: 1000 }) }),
]);

const valueBytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), "utf8");

export function createAdversarialManifest() {
  const generatedFileHashes = Object.fromEntries(Object.entries(generatedFiles).map(([name, value]) => [name, Object.freeze({
    sizeBytes: value.length,
    sha256: sha256(value),
    license: "CC0-1.0 generated",
  })]));
  const sections = {
    ssrfCases,
    dnsRebindingSequences,
    redirectCases,
    browserSubresourceCandidates,
    archiveDocumentCases,
    secretCanaryIds: Object.keys(SECRET_CANARIES),
    generatedFileHashes,
  };
  return Object.freeze({
    schemaVersion: "1.0.0",
    fixtureVersion: `1.0.0+sha256.${sha256(valueBytes(sections)).slice(0, 16)}`,
    seed: ADVERSARIAL_SEED,
    generatedAt: "2026-08-09T00:00:00Z",
    license: "CC0-1.0 generated; no user data or real secrets",
    ...sections,
    manifestSha256: sha256(valueBytes(sections)),
  });
}

function replacePort(value, protectedPort) {
  return typeof value === "string" ? value.replaceAll("{protectedPort}", String(protectedPort)) : value;
}

export function denialHarnessCases(protectedPort) {
  return [
    ...ssrfCases.map((item) => ({ ...item, url: replacePort(item.url, protectedPort) })),
    ...dnsRebindingSequences,
    ...redirectCases.map((item) => ({ ...item, hops: item.hops.map((hop) => ({ ...hop, url: replacePort(hop.url, protectedPort) })) })),
    ...browserSubresourceCandidates.map((item) => ({ ...item, url: replacePort(item.url, protectedPort) })),
  ];
}

export async function runZeroPacketDenialHarness({ cases, decide, send, readProtectedPackets, signal }) {
  const before = await readProtectedPackets();
  if (before !== 0) throw new Error(`Protected counter must start at zero, got ${before}`);
  const results = [];
  for (const candidate of cases) {
    if (signal?.aborted) throw signal.reason ?? new Error("denial harness cancelled");
    const decision = await decide(candidate, { signal });
    if (decision !== "deny") {
      await send(candidate, { signal });
      throw new Error(`Denied fixture was not denied: ${candidate.id}`);
    }
    results.push(Object.freeze({ id: candidate.id, decision, packets: 0, reasonCode: candidate.reasonCode }));
  }
  const after = await readProtectedPackets();
  if (after !== 0) throw new Error(`Denied fixtures reached protected endpoint: ${after}`);
  return Object.freeze({ before, after, sent: 0, results: Object.freeze(results) });
}

function visitStrings(value, path, visit) {
  if (typeof value === "string" || Buffer.isBuffer(value)) return visit(value.toString("utf8"), path);
  if (Array.isArray(value)) return value.forEach((item, index) => visitStrings(item, `${path}/${index}`, visit));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) visitStrings(item, `${path}/${key}`, visit);
  }
}

export function scanSecretCanaries(surfaces, options = {}) {
  const allowedPaths = new Set(options.allowedPaths ?? []);
  const canaries = Object.entries(SECRET_CANARIES);
  const hits = [];
  visitStrings(surfaces, "", (text, path) => {
    if (allowedPaths.has(path)) return;
    for (const [canaryId, canary] of canaries) {
      if (text.includes(canary)) hits.push(Object.freeze({ path: path || "/", canaryId }));
    }
  });
  return Object.freeze(hits);
}
