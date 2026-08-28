import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("webxd has soft optional service dependencies", async () => {
  const installer = await readFile(new URL("../install-fedora.sh", import.meta.url), "utf8");
  const unit = installer.match(/cat > "\$UNIT_DIR\/webxd\.service" <<EOF\n([\s\S]*?)\nEOF/)?.[1] ?? "";
  assert.match(unit, /Wants=pi-web-reader\.service pi-web-searxng\.service/);
  assert.doesNotMatch(unit, /^Requires=/m);
  assert.match(unit, /pi-browserd\.service/);
  assert.match(unit, /pi-web-crawl\.service/);
});

test("installer makes core search and read checks fatal but browser checks optional", async () => {
  const installer = await readFile(new URL("../install-fedora.sh", import.meta.url), "utf8");
  assert.match(installer, /is-active pi-web-reader pi-web-searxng webxd/);
  assert.doesNotMatch(installer, /is-active[^\n]*pi-browserd/);
  assert.match(installer, /for optional_unit in[^\n]*pi-browserd\.service/);
  assert.match(installer, /"\$BIN_DIR\/pi-web" doctor --json/);
  assert.doesNotMatch(installer, /pi-browserd" doctor --json \|\| true/);
});

test("pi-web doctor routes to the WebX authority doctor", async () => {
  const installer = await readFile(new URL("../install-fedora.sh", import.meta.url), "utf8");
  assert.match(installer, /doctor\) shift; exec \/usr\/bin\/node "\$INSTALL_ROOT\/scripts\/pi-web-doctor\.mjs"/);
});
