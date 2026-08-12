import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createFixtureServer } from "../src/server.mjs";

async function fixture(t) {
  const cleanRoot = await mkdtemp(join(tmpdir(), "pi-web-fixture-test-"));
  const server = createFixtureServer({ uploadRoot: join(cleanRoot, "uploads") }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(cleanRoot, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, cleanRoot };
}

test("fixture server exposes deterministic pages, auth, and artifact bytes", async (t) => {
  const { base } = await fixture(t);
  assert.match(await (await fetch(`${base}/static`)).text(), /main-content fixture/);
  assert.match(await (await fetch(`${base}/visual-controls`)).text(), /Deterministic visual controls/);
  assert.match(await (await fetch(`${base}/workspace-states`)).text(), /agent-browser\/chrome/);
  assert.equal((await fetch(`${base}/docs.md`)).headers.get("content-type"), "text/markdown; charset=utf-8");
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "pi", password: "browser" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await (await fetch(`${base}/api/clients`, { headers: { cookie } })).json()).connected, 48);
  const download = await fetch(`${base}/api/download`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(download.headers.get("x-content-sha256"), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(download.headers.get("content-disposition"), "attachment; filename=pi-web-complete-fixture.txt");
  assert.match((await (await fetch(`${base}/artifacts/pdf`)).text()), /^%PDF-1.4/);
});

test("uploads return an opaque deterministic record and never expose a path", async (t) => {
  const { base, cleanRoot } = await fixture(t);
  const input = Buffer.from("fixed upload bytes\n");
  const response = await fetch(`${base}/api/upload`, { method: "POST", body: input });
  const record = await response.json();
  assert.deepEqual(record, {
    ok: true,
    uploadId: "fixture-upload-0001",
    size: input.length,
    sha256: createHash("sha256").update(input).digest("hex"),
  });
  assert.equal("path" in record, false);
  assert.deepEqual(await readFile(join(cleanRoot, "uploads", "upload-0001.bin")), input);
});

test("never-completing requests record one bounded disconnect", async (t) => {
  const { base } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/never`, { signal: controller.signal });
  const requestId = response.headers.get("x-fixture-request-id");
  assert.equal(requestId, "fixture-request-0001");
  controller.abort();
  await assert.rejects(response.text(), /abort/i);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await (await fetch(`${base}/api/request-status?id=${requestId}`)).json();
    if (state.disconnectCount === 1) {
      assert.equal(state.completed, false);
      return;
    }
    await sleep(25);
  }
  assert.fail("fixture did not record the request disconnect");
});
