import assert from "node:assert/strict";
import test from "node:test";

import extension, { observationResult } from "../dist/extension.js";

process.env.PI_WEB_SEARCH_READ_EXTENSION = "/nonexistent/pi-web-research-extension.mjs";

async function registeredTools() {
  const tools = [];
  await extension({ registerTool(tool) { tools.push(tool); } });
  return tools;
}

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
