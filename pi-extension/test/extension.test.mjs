import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/extension.js";

process.env.PI_WEB_SEARCH_READ_EXTENSION = "/nonexistent/pi-web-research-extension.mjs";

async function registeredTools() {
  const tools = [];
  await extension({ registerTool(tool) { tools.push(tool); } });
  return tools;
}

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
    "click", "type", "press_key", "scroll", "navigate", "get_url", "wait_for",
  ]);
});
