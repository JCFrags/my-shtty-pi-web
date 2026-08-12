/* global AbortController, fetch */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveDocumentCases,
  browserSubresourceCandidates,
  createAdversarialManifest,
  denialHarnessCases,
  dnsRebindingSequences,
  generatedFiles,
  redirectCases,
  runZeroPacketDenialHarness,
  scanSecretCanaries,
  SECRET_CANARIES,
  ssrfCases,
} from "../src/adversarial.mjs";
import { sha256 } from "../src/content.mjs";
import { createFixtureOrigin } from "../src/server.mjs";

async function withOrigin(run) {
  const fixture = createFixtureOrigin();
  const address = await fixture.start();
  try {
    await run(fixture, address);
  } finally {
    await fixture.stop();
  }
}

function tarName(buffer) {
  return buffer.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
}

function tarType(buffer) {
  return buffer.subarray(156, 157).toString("ascii");
}

function tarLink(buffer) {
  return buffer.subarray(157, 257).toString("utf8").replace(/\0.*$/s, "");
}

test("adversarial manifest and generated hashes are stable", async () => {
  const first = createAdversarialManifest();
  const second = createAdversarialManifest();
  assert.deepEqual(second, first);
  assert.match(first.fixtureVersion, /^1\.0\.0\+sha256\.[0-9a-f]{16}$/);
  assert.equal(first.license, "CC0-1.0 generated; no user data or real secrets");
  for (const [name, file] of Object.entries(generatedFiles)) {
    assert.equal(first.generatedFileHashes[name].sha256, sha256(file));
    assert.equal(first.generatedFileHashes[name].sizeBytes, file.length);
  }
  await withOrigin(async (fixture, { origin }) => {
    assert.deepEqual(await fetch(`${origin}/security/manifest.json`).then((response) => response.json()), first);
    assert.deepEqual(fixture.adversarialManifest, first);
  });
});

test("SSRF and DNS fixtures contain exact address evidence without host DNS changes", () => {
  assert.ok(ssrfCases.length >= 14);
  assert.ok(ssrfCases.every((item) => item.expectedDecision === "deny" && item.expectedProtectedPackets === 0));
  assert.ok(ssrfCases.some((item) => item.url.includes("2130706433")));
  assert.ok(ssrfCases.some((item) => item.resolvedAddresses.includes("::ffff:127.0.0.1")));
  assert.ok(ssrfCases.some((item) => item.resolvedAddresses.length > 1));

  assert.deepEqual(dnsRebindingSequences[0].answersByResolution, [["192.0.2.40"], ["127.0.0.1"]]);
  assert.deepEqual(dnsRebindingSequences[1].answersByResolution, [["2001:db8::40"], ["fe80::1"]]);
  assert.ok(dnsRebindingSequences.every((item) => item.hostnameAscii.endsWith(".invalid")));
});

test("redirect and browser subresource candidates retain reason-coded evidence", async () => {
  assert.ok(redirectCases.every((item) => item.hops.at(-1).decision === "deny"));
  assert.deepEqual(new Set(browserSubresourceCandidates.map((item) => item.channel)), new Set([
    "fetch", "xhr", "websocket", "iframe", "service_worker", "media",
  ]));

  await withOrigin(async (_fixture, { origin }) => {
    const start = await fetch(`${origin}/security/redirect/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("location"), "/security/redirect/private");
    const privateHop = await fetch(`${origin}/security/redirect/private`, { redirect: "manual" });
    assert.equal(privateHop.headers.get("location"), "/protected/resource");
    assert.deepEqual(await fetch(`${origin}/protected/counter`).then((response) => response.json()), { packets: 0 });
    const page = await fetch(`${origin}/security/browser-subresources`).then((response) => response.text());
    assert.match(page, /169\.254\.169\.254/);
    assert.match(page, /127\.0\.0\.1/);
    assert.match(page, /websocket/);
  });
});

test("zero-packet denial harness never calls transport and protected counter stays zero", async () => {
  await withOrigin(async (_fixture, { origin, port }) => {
    await fetch(`${origin}/protected/reset`, { method: "POST" });
    let sends = 0;
    const readProtectedPackets = async () => (await fetch(`${origin}/protected/counter`).then((response) => response.json())).packets;
    const result = await runZeroPacketDenialHarness({
      cases: denialHarnessCases(port),
      decide: async (candidate) => {
        assert.equal(candidate.expectedDecision ?? candidate.hops?.at(-1)?.decision, "deny");
        return "deny";
      },
      send: async () => {
        sends += 1;
        await fetch(`${origin}/protected/resource`);
      },
      readProtectedPackets,
    });
    assert.equal(result.before, 0);
    assert.equal(result.after, 0);
    assert.equal(result.sent, 0);
    assert.equal(sends, 0);
    assert.equal(result.results.length, denialHarnessCases(port).length);
  });
});

test("denial harness cancellation stops before policy or transport work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  let decisions = 0;
  let sends = 0;
  await assert.rejects(runZeroPacketDenialHarness({
    cases: ssrfCases,
    decide: async () => { decisions += 1; return "deny"; },
    send: async () => { sends += 1; },
    readProtectedPackets: async () => 0,
    signal: controller.signal,
  }), /fixture cancellation/);
  assert.equal(decisions, 0);
  assert.equal(sends, 0);
});

test("archive and document fixtures expose bounded hostile structures without expansion", () => {
  assert.equal(tarName(generatedFiles.traversalTar), "../../outside.txt");
  assert.equal(tarName(generatedFiles.absolutePathTar), "/etc/webx-fixture");
  assert.equal(tarType(generatedFiles.symlinkTar), "2");
  assert.equal(tarLink(generatedFiles.symlinkTar), "../../outside.txt");
  assert.match(generatedFiles.malformedPdf.toString("ascii"), /^%PDF-1\.7/);
  assert.ok(generatedFiles.compressionBombGzip.length < 2048);
  assert.equal(archiveDocumentCases.find((item) => item.id === "archive-compression-ratio")?.limits.maxExpandedBytes, 65536);
  assert.ok(archiveDocumentCases.every((item) => item.expected === "deny" || item.expected === "quarantine"));
});

test("synthetic canary scanner covers logs, artifacts, indexes, wiki, traces, and evidence", () => {
  const safeSurfaces = {
    logs: [{ event: "request denied", authorization: "[REDACTED]" }],
    receipts: [{ outcome: "policy_denied", requestedUrl: "https://fixture.invalid/?token=REDACTED" }],
    markdown: "Untrusted fixture excerpt with no secret value.",
    events: [{ code: "WEBX_EGRESS_DESTINATION_DENIED" }],
    index: [{ id: "fixture-page", text: "safe text" }],
    wiki: [{ delivery: "fixture-delivery", content: "safe text" }],
    screenshotMetadata: [{ artifactId: "fixture-screenshot" }],
    traces: [{ span: "fixture.fetch", token: "[REDACTED]" }],
    diagnostics: [{ reason: "synthetic denial" }],
    evidence: [{ fixture: "secret scan", result: "no matches" }],
  };
  assert.deepEqual(scanSecretCanaries(safeSurfaces), []);

  for (const [canaryId, canary] of Object.entries(SECRET_CANARIES)) {
    const hits = scanSecretCanaries({ logs: [{ message: `leak:${canary}` }] });
    assert.deepEqual(hits, [{ path: "/logs/0/message", canaryId }]);
  }

  const protectedInput = { fixtureInput: SECRET_CANARIES.authorization, output: "[REDACTED]" };
  assert.deepEqual(scanSecretCanaries(protectedInput, { allowedPaths: ["/fixtureInput"] }), []);
  assert.deepEqual(scanSecretCanaries({ index: SECRET_CANARIES.query }), [{ path: "/index", canaryId: "query" }]);
});

test("adversarial origin rejects non-loopback listeners and shuts down cleanly", async () => {
  assert.throws(() => createFixtureOrigin({ host: "0.0.0.0" }), /refuses non-loopback/);
  assert.throws(() => createFixtureOrigin({ host: "localhost" }), /refuses non-loopback/);
  const fixture = createFixtureOrigin({ host: "::1" });
  const { origin } = await fixture.start();
  assert.match(origin, /^http:\/\/\[::1\]:/);
  await fixture.stop();
  await assert.rejects(fetch(`${origin}/health`));
});
