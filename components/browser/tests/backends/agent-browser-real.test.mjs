import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentBrowserRunner,
  composeCuaCommands,
  startFixtureServer,
} from "../../scripts/lib/agent-browser.mjs";

const runReal = process.env.PI_WEB_REAL_BROWSER === "1";

test("real agent-browser/chrome binds screenshot geometry and coordinate input", { skip: !runReal, timeout: 120_000 }, async () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const work = await mkdtemp(join(tmpdir(), "pi-web-agent-browser-real-"));
  const screenshotPath = join(work, "current.png");
  const fixture = await startFixtureServer(root);
  const runner = new AgentBrowserRunner({
    namespace: `pi-web-real-${process.pid}-${Date.now()}`,
    session: `chrome-${process.pid}`,
  });
  try {
    runner.validateIdentity();
    runner.run(["open", `${fixture.baseUrl}/spa`]);
    runner.run(["set", "viewport", "640", "480"]);
    runner.run(["wait", "750"]);
    runner.run(["diff", "snapshot", "--compact"]);
    const geometryRecord = runner.run(["eval", "(()=>{const r=document.querySelector('#add').getBoundingClientRect();return {viewportWidth:innerWidth,viewportHeight:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY,x:r.x+r.width/2,y:r.y+r.height/2,browserProduct:navigator.userAgent}})()"]);
    const geometry = findObjectWith(geometryRecord.json, "viewportWidth");
    assert.ok(geometry, "runtime geometry must be structured");
    assert.equal(geometry.viewportWidth, 640);
    assert.equal(geometry.viewportHeight, 480);
    assert.match(geometry.browserProduct, /Chrom(?:e|ium)\/151\./);

    runner.run(["screenshot", screenshotPath, "--screenshot-format", "png"]);
    const screenshot = await readFile(screenshotPath);
    const imageWidth = screenshot.readUInt32BE(16);
    const imageHeight = screenshot.readUInt32BE(20);
    assert.ok(Math.abs(imageWidth - geometry.viewportWidth * geometry.deviceScaleFactor) <= 1);
    assert.ok(Math.abs(imageHeight - geometry.viewportHeight * geometry.deviceScaleFactor) <= 1);
    assert.equal(createHash("sha256").update(screenshot).digest("hex").length, 64);

    const commands = composeCuaCommands({ type: "click", x: geometry.x, y: geometry.y }, {
      viewportWidth: geometry.viewportWidth,
      viewportHeight: geometry.viewportHeight,
    });
    for (const command of commands) runner.run(command);
    const consequence = runner.run(["eval", "document.querySelector('#toast')?.textContent"]);
    assert.match(JSON.stringify(consequence.json), /Client creation dialog opened/);
    const semanticEvidence = runner.run(["read"]);
    assert.match(JSON.stringify(semanticEvidence.json), /Client creation dialog opened/);

    const rejected = runner.run(["mouse", "move", "640", "480"], { allowFailure: true });
    assert.equal(rejected.status, 0, "upstream permissiveness is expected; adapter prevalidation is the control");
  } finally {
    runner.close();
    await fixture.stop();
    await rm(work, { recursive: true, force: true });
  }
});

function findObjectWith(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return value;
  for (const child of Object.values(value)) {
    const found = findObjectWith(child, key);
    if (found) return found;
  }
  return undefined;
}
