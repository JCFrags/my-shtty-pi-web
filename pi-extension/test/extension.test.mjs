import assert from "node:assert/strict";
import test from "node:test";

import extension, { observationResult } from "../dist/extension.js";
import { BrowserStartupError } from "../dist/client.js";

process.env.PI_WEB_SEARCH_READ_EXTENSION = "/nonexistent/pi-web-research-extension.mjs";

async function registeredTools(client = undefined) {
  const tools = [];
  const events = [];
  await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { assert.equal(typeof handler, "function"); events.push(event); } }, client);
  assert.deepEqual(events, ["session_start", "session_shutdown"]);
  return tools;
}

test("registered browser_open exposes complete structured startup diagnostics in the normal error message", async () => {
  const report = {
    version: 1, attempt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "failed",
    code: "PROFILE_OWNERSHIP_UNCERTAIN", message: "original ownership refusal", pane: "w1:p8",
    exitCode: 1, signal: null, doctorCommand: "terminal-browser doctor --json",
    cleanup: { status: "exited", nextStep: "Run terminal-browser doctor --json before explicit recovery." },
  };
  const tools = await registeredTools({ open: async () => { throw new BrowserStartupError(report); } });
  const open = tools.find((tool) => tool.name === "browser_open");
  const ctx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "session-a" } };
  await assert.rejects(open.execute("call", {}, undefined, undefined, ctx), (error) => {
    assert.deepEqual(JSON.parse(error.message), report);
    return true;
  });
});

test("visual tool results emit native image content without image data in text or details", () => {
  const imageData = Buffer.from("image bytes").toString("base64");
  const value = observationResult({
    url: "https://example.test/",
    visual: { width: 10, height: 8, bytes: 11 },
    image: { data: imageData, mimeType: "image/png" },
  });
  assert.deepEqual(value.content[1], { type: "image", data: imageData, mimeType: "image/png" });
  assert.equal(value.content[0].text.includes(imageData), false);
  assert.equal(JSON.stringify(value.details).includes(imageData), false);
});

test("extension registers only the five compact browser tools", async () => {
  assert.deepEqual((await registeredTools()).map((tool) => tool.name), [
    "browser_open",
    "browser_tabs",
    "browser_observe",
    "browser_act",
    "browser_control",
  ]);
});

test("tool schemas keep browser keys, sockets, observation ids, and control epochs internal", async () => {
  const tools = await registeredTools();
  const text = JSON.stringify(tools.map((tool) => tool.parameters));
  for (const hidden of ["browser_key", "socket", "observation_id", "control_epoch", "controlEpoch"]) {
    assert.equal(text.includes(hidden), false);
  }
  const act = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(act.parameters.properties.action.enum, [
    "upload", "click", "hover", "drag", "type", "press_key", "scroll", "navigate", "get_url", "wait_for", "dialog",
  ]);
  const observe = tools.find((tool) => tool.name === "browser_observe");
  assert.deepEqual(observe.parameters.properties.view.enum, ["semantic", "visual", "both"]);
  assert.deepEqual(observe.parameters.properties.scope.enum, ["viewport", "element"]);
});

test("dialog action requires an ID and explicit decision without a model-supplied epoch", async () => {
  const act = (await registeredTools()).find(tool => tool.name === "browser_act");
  const ctx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "session-a" } };
  for (const params of [{ action: "dialog", accept: true }, { action: "dialog", dialog_id: "pending" }]) {
    await assert.rejects(act.execute("call", params, undefined, undefined, ctx), /dialog requires dialog_id and accept/);
  }
  assert.equal(act.parameters.additionalProperties, false);
  assert.equal("control_epoch" in act.parameters.properties, false);
  assert.equal(act.description.includes("control_epoch"), false);
});

test('native locator schemas are bounded and keep all five tool names', async () => {
  const tools = await registeredTools();
  assert.equal(tools.length, 5);
  const properties = tools.find(tool => tool.name === 'browser_act').parameters.properties;
  for (const field of ['locator', 'from_locator', 'to_locator']) {
    assert.equal(properties[field].minItems, 1);
    assert.equal(properties[field].maxItems, 16);
  }
  assert(properties.condition.enum.includes('actionable'));
  assert.equal(tools.find(tool => tool.name === 'browser_observe').parameters.properties.filter.maxItems, 16);
});

test("frame selection stays concise without backend frame or session identifiers", async () => {
  const tools = await registeredTools();
  for (const name of ["browser_observe", "browser_act"]) {
    const properties = tools.find(tool => tool.name === name).parameters.properties;
    assert.equal(properties.frame.pattern, "^(main|f[1-9][0-9]{0,8})$");
    for (const hidden of ["frameId", "sessionId", "executionContextId", "uniqueContextId", "loaderId"]) assert.equal(hidden in properties, false);
  }
});
