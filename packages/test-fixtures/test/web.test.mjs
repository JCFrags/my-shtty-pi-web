/* global fetch */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { get } from "node:http";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { badCharsetBodies, compressedLargeBody, largeBody, sha256 } from "../src/content.mjs";
import { createFixtureOrigin } from "../src/server.mjs";
import { createWebManifest, mixedDnsCases } from "../src/web.mjs";

async function withOrigin(run) {
  const fixture = createFixtureOrigin();
  const address = await fixture.start();
  try {
    await run(fixture, address.origin);
  } finally {
    await fixture.stop();
  }
}

function rawRequest(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: true }));
      response.on("aborted", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: false }));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

test("web-only manifest is deterministic and covers every bounded failure class", async () => {
  const expected = createWebManifest();
  assert.deepEqual(createWebManifest(), expected);
  assert.deepEqual(expected.responses.map((item) => item.id), ["slow", "endless", "oversized", "compressed-expansion", "partial-body", "disconnect", "status-503"]);
  assert.deepEqual(expected.redirects.map((item) => item.id), ["loop-a", "loop-b", "private-address", "link-local", "non-http"]);
  assert.deepEqual(expected.charsets.map((item) => item.id), ["unknown", "mismatch", "malformed-utf8"]);
  assert.deepEqual(expected.mixedDns, mixedDnsCases);
  await withOrigin(async (fixture, origin) => {
    assert.deepEqual(fixture.webManifest, expected);
    assert.deepEqual(await fetch(`${origin}/web/manifest.json`).then((response) => response.json()), expected);
  });
});

test("slow and endless responses are locally controllable", { timeout: 3000 }, async () => {
  await withOrigin(async (_fixture, origin) => {
    assert.equal(await fetch(`${origin}/failure/slow?ms=5`).then((response) => response.text()), "delayed 5ms\n");
    await new Promise((resolve, reject) => {
      const request = get(`${origin}/failure/endless`, (response) => {
        response.once("data", (chunk) => {
          assert.equal(chunk.toString("utf8"), "endless fixture prefix\n");
          response.destroy();
          request.destroy();
          resolve();
        });
      });
      request.on("error", reject);
    });
  });
});

test("oversized and compressed responses have exact stable wire bytes", async () => {
  await withOrigin(async (_fixture, origin) => {
    const oversized = await rawRequest(`${origin}/bounds/large`);
    assert.equal(oversized.complete, true);
    assert.equal(Number(oversized.headers["content-length"]), largeBody.length);
    assert.equal(sha256(oversized.body), sha256(largeBody));

    const compressed = await rawRequest(`${origin}/bounds/compressed`);
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(sha256(compressed.body), sha256(compressedLargeBody));
    const expanded = gunzipSync(compressed.body);
    assert.equal(expanded.length, largeBody.length);
    assert.equal(sha256(expanded), sha256(largeBody));
  });
});

test("redirect loops and private or special targets require no external request", async () => {
  await withOrigin(async (_fixture, origin) => {
    const manifest = createWebManifest();
    for (const item of manifest.redirects) {
      const response = await fetch(`${origin}${item.path}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), item.location);
    }
    await assert.rejects(fetch(`${origin}/redirect/loop/a`), /redirect|fetch failed/i);
  });
});

test("mixed DNS cases contain one public documentation address and one denied address", () => {
  assert.deepEqual(mixedDnsCases.map((item) => item.hostnameAscii), ["mixed-a.fixture.invalid", "mixed-aaaa.fixture.invalid"]);
  assert.deepEqual(mixedDnsCases[0].resolvedAddresses, ["192.0.2.80", "10.0.0.80"]);
  assert.deepEqual(mixedDnsCases[1].resolvedAddresses, ["2001:db8::80", "fe80::80"]);
  assert.ok(mixedDnsCases.every((item) => item.expectedDecision === "deny" && item.reasonCode === "network.resolved_set_denied"));
});

test("bad charset routes preserve exact declared metadata and bytes", async () => {
  await withOrigin(async (_fixture, origin) => {
    for (const [id, path, charset, expectedBody] of [
      ["unknown", "/encoding/unknown", "x-webx-invalid", badCharsetBodies.unknown],
      ["mismatch", "/encoding/mismatch", "us-ascii", badCharsetBodies.mismatch],
      ["malformed", "/encoding/malformed-utf8", "utf-8", badCharsetBodies.malformedUtf8],
    ]) {
      const response = await rawRequest(`${origin}${path}`);
      assert.equal(response.complete, true, id);
      assert.match(response.headers["content-type"], new RegExp(`charset=${charset}$`), id);
      assert.deepEqual(response.body, expectedBody, id);
    }
  });
});

test("partial body advertises a larger body and terminates after the stable prefix", { timeout: 3000 }, async () => {
  await withOrigin(async (_fixture, origin) => {
    const response = await rawRequest(`${origin}/failure/partial-body`);
    assert.equal(response.complete, false);
    assert.equal(Number(response.headers["content-length"]), 64);
    assert.equal(response.body.toString("utf8"), "partial fixture prefix\n");
    assert.equal(response.body.length, 23);
  });
});
