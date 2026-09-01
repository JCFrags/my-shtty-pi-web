import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated webxd unit depends only on core search and reader services", async () => {
  const cutover = await readFile(new URL("./pi-web-cutover", import.meta.url), "utf8");
  const unit = cutover.match(/"webxd\.service": f"""([\s\S]*?)""",/)?.[1] ?? "";
  assert.match(unit, /Wants=pi-web-reader\.service pi-web-searxng\.service/);
  assert.doesNotMatch(unit, /Requires=/);
  assert.doesNotMatch(unit, /pi-browserd|pi-web-crawl|pi-web-docling|pi-web-egress-proxy/);
});

test("generated webxd unit owns its private runtime directory", async () => {
  const cutover = await readFile(new URL("./pi-web-cutover", import.meta.url), "utf8");
  const unit = cutover.match(/"webxd\.service": f"""([\s\S]*?)""",/)?.[1] ?? "";
  assert.match(unit, /\\nRuntimeDirectory=pi-web\\nRuntimeDirectoryMode=0700\\n/);
});

test("Fedora installer stages a reviewed candidate before live cutover", async () => {
  const installer = await readFile(new URL("../install-fedora.sh", import.meta.url), "utf8");
  assert.match(installer, /pi-web-profile/);
  assert.match(installer, /pi-web-stage/);
  assert.match(installer, /No live path changed/);
  assert.doesNotMatch(installer, /systemctl --user (?:enable|restart)/);
});

test("generated pi-web doctor and status use fixed classified diagnostics", async () => {
  const cutover = await readFile(new URL("./pi-web-cutover", import.meta.url), "utf8");
  assert.match(cutover, /doctor\) shift; PI_WEB_INSTALL_ROOT=.*pi-web-doctor\.mjs/);
  assert.match(cutover, /status\) shift; PI_WEB_INSTALL_ROOT=.*pi-web-doctor\.mjs.*--status/);
  assert.doesNotMatch(cutover, /status\) exec systemctl/u);
});
