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

test("tool schemas do not expose browser keys, sockets, epochs, or observation ids", async () => {
  const tools = await registeredTools();
  const text = JSON.stringify(tools.map((tool) => tool.parameters));
  for (const hidden of ["browser_key", "socket", "control_epoch", "observation_id"]) {
    assert.equal(text.includes(hidden), false);
  }
  const act = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(act.parameters.properties.action.enum, [
    "click", "hover", "drag", "type", "press_key", "scroll", "navigate", "get_url", "wait_for",
  ]);
  const observe = tools.find((tool) => tool.name === "browser_observe");
  assert.deepEqual(observe.parameters.properties.view.enum, ["semantic", "visual", "both"]);
  assert.deepEqual(observe.parameters.properties.scope.enum, ["viewport", "element"]);
});
