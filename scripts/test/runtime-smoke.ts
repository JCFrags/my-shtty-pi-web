import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { BrowserController } from "../../browser/src/page/controller";
import { BrowserAgentRuntime } from "../../browser/src/agent/runtime";
import { BrowserControl } from "../../browser/src/agent/control";
import { createSlowNaturalPersona } from "../../browser/src/agent/interaction-profile";
import { bundledAsset } from "../../browser/src/assets";
import { highlight } from "../../engine/packages/pixel-react/src/native";
type Surface = ConstructorParameters<typeof BrowserController>[0];

app.commandLine.appendSwitch("disable-gpu");
void (async () => {
  assert.equal(process.versions.electron, "43.3.0");
  assert(highlight("const value = 1;", "javascript").length > 0);
  const sqlite = new DatabaseSync(":memory:");
  assert.equal(sqlite.prepare("select 42 as answer").get()?.answer, 42);
  sqlite.close();
  for (const asset of ["fonts/JetBrainsMono-Regular.ttf", "react-grab/index.global.js"]) {
    const file = bundledAsset(asset);
    assert(file && fs.statSync(file).size > 0);
  }
  const persona = await createSlowNaturalPersona({ seed: 42 });
  assert.equal(persona.base.speedFactor, 0.6);
  await app.whenReady();
  const surface = () => ({ clear() {}, close() {}, present(frame: { released?: () => void }) { frame.released?.(); } }) as unknown as Surface;
  const controller = new BrowserController(surface(), surface(), surface(), { x: 0, y: 0, width: 800, height: 600, scale: 1 }, "data:text/html," + encodeURIComponent('<button id="save" onclick="window.saved=(window.saved||0)+1">Save</button><label>Name<input id="name"></label><div style="height:2500px">Scroll</div>'), {
    cwd: process.cwd(), background: "#222222", visible: true, partition: null, tabsAsPopups: false,
    clipboardRead: false, sessionKey: "artifact-smoke", appTabId: null,
  }, () => {});
  let runtime: BrowserAgentRuntime;
  const control = new BrowserControl({ onTransition: () => runtime?.invalidateControl() });
  runtime = new BrowserAgentRuntime(controller, { control, personaProvider: async () => persona });
  for (let attempt = 0; ; attempt++) {
    if (await controller.runJs("Boolean(document.getElementById('save'))").catch(() => false)) break;
    assert(attempt < 500, "page load timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const request = async () => ({ observationId: (await runtime.observe()).observationId, expectedControlEpoch: control.controlEpoch });
  await runtime.click({ ...await request(), locator: [{ kind: "role", value: "button", name: "Save" }] });
  assert.equal(await controller.runJs("window.saved"), 1);
  await runtime.type({ ...await request(), locator: [{ kind: "label", value: "Name" }], text: "bundle", replace: true });
  assert.equal(await controller.runJs("document.getElementById('name').value"), "bundle");
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi, native: true, sqlite: true, assets: true, agentcursor: "slow-natural", click: true, type: true }));
  app.exit(0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
