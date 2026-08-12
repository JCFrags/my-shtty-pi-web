/* global fetch */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { AUTH_CANARY, compressedLargeBody, createManifest, largeBody, sha256 } from "../src/content.mjs";
import { createFixtureOrigin } from "../src/server.mjs";

async function withOrigin(run) {
  const fixture = createFixtureOrigin();
  const address = await fixture.start();
  try {
    await run(fixture, address.origin);
  } finally {
    await fixture.stop();
  }
}

test("manifest version and hashes are deterministic across starts", async () => {
  const first = createManifest();
  await withOrigin(async (_fixture, origin) => {
    const served = await fetch(`${origin}/manifest.json`).then((response) => response.json());
    assert.deepEqual(served, first);
  });
  await withOrigin(async (fixture) => {
    assert.deepEqual(fixture.manifest, first);
  });
});

test("origin accepts only explicit loopback listeners", async () => {
  assert.throws(() => createFixtureOrigin({ host: "0.0.0.0" }), /refuses non-loopback/);
  assert.throws(() => createFixtureOrigin({ host: "localhost" }), /refuses non-loopback/);
  await withOrigin(async (_fixture, origin) => assert.match(origin, /^http:\/\/127\.0\.0\.1:/));
});

test("representative routes are stable and local", async () => {
  await withOrigin(async (_fixture, origin) => {
    const staticResponse = await fetch(`${origin}/html/static`);
    assert.equal(staticResponse.status, 200);
    assert.equal(staticResponse.headers.get("etag"), '"webx-static-v1"');
    assert.match(await staticResponse.text(), /first canonical body/);
    assert.equal((await fetch(`${origin}/html/static`, { headers: { "if-none-match": '"webx-static-v1"' } })).status, 304);

    const changed = await fetch(`${origin}/html/changed/v2`).then((response) => response.text());
    assert.match(changed, /watched value is beta/);

    const redirect = await fetch(`${origin}/redirect/static`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/html/static");

    assert.match(await fetch(`${origin}/spa`).then((response) => response.text()), /subresources\/app\.js/);
    assert.match(await fetch(`${origin}/html/malformed`).then((response) => response.text()), /Open elements/);
    assert.match(await fetch(`${origin}/robots.txt`).then((response) => response.text()), /Disallow: \/crawl\/private/);
    assert.match(await fetch(`${origin}/feeds/rss.xml`).then((response) => response.text()), /item-v1/);
    assert.deepEqual(await fetch(`${origin}/api/items`).then((response) => response.json()), {
      fixture: "webx",
      seed: "webx-fixture-seed-v1",
      items: [{ id: "item-1", value: 7 }],
    });

    const compressed = Buffer.from(await fetch(`${origin}/bounds/compressed`).then((response) => response.arrayBuffer()));
    // fetch decompresses gzip. The resulting bytes must equal the stable generated body.
    assert.equal(sha256(compressed), sha256(largeBody));

    const authDenied = await fetch(`${origin}/auth/basic`);
    assert.equal(authDenied.status, 401);
    const deniedBody = await authDenied.text();
    assert.doesNotMatch(deniedBody, new RegExp(AUTH_CANARY));
    assert.match(deniedBody, /synthetic-basic-v1/);
    const authorization = `Basic ${Buffer.from(`fixture:${AUTH_CANARY}`).toString("base64")}`;
    assert.equal((await fetch(`${origin}/auth/basic`, { headers: { authorization } }).then((response) => response.json())).authenticated, true);

    assert.equal((await fetch(`${origin}/failure/status/503`)).status, 503);
    assert.equal(await fetch(`${origin}/failure/slow?ms=5`).then((response) => response.text()), "delayed 5ms\n");
    assert.equal((await fetch(`${origin}/failure/slow?ms=invalid`)).status, 400);
    await assert.rejects(fetch(`${origin}/failure/disconnect`));
  });
});

test("compressed bytes in the manifest expand to the declared stable body", () => {
  const manifest = createManifest();
  const compressedHash = manifest.routes.find((route) => route.id === "compressed")?.contentSha256;
  assert.equal(typeof compressedHash, "string");
  // Validate the checked-in generator, not fetch automatic decompression.
  const generated = manifest.routes.find((route) => route.id === "large")?.contentSha256;
  assert.equal(generated, sha256(largeBody));
  assert.notEqual(compressedHash, generated);
  assert.equal(gunzipSync(compressedLargeBody).length, largeBody.length);
});

test("protected packet counter starts at zero and counts explicit accesses exactly", async () => {
  await withOrigin(async (_fixture, origin) => {
    assert.deepEqual(await fetch(`${origin}/protected/counter`).then((response) => response.json()), { packets: 0 });
    assert.deepEqual(await fetch(`${origin}/protected/resource`).then((response) => response.json()), { protected: true, packet: 1 });
    assert.deepEqual(await fetch(`${origin}/protected/counter`).then((response) => response.json()), { packets: 1 });
  });
});

test("shutdown cancels delayed responses and closes cleanly", async () => {
  const fixture = createFixtureOrigin();
  const { origin } = await fixture.start();
  const pending = fetch(`${origin}/failure/slow?ms=2000`).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fixture.stop();
  assert.ok((await pending) instanceof Error);
});
