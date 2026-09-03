import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/extension.js";

function registeredTools() {
  const tools = [];
  extension({ registerTool(tool) { tools.push(tool); } });
  return tools;
}

test("extension registers only the five compact browser tools", () => {
  assert.deepEqual(registeredTools().map((tool) => tool.name), [
    "browser_open",
    "browser_tabs",
    "browser_observe",
    "browser_act",
    "browser_control",
  ]);
});

test("tool schemas do not expose browser keys, sockets, epochs, or observation ids", () => {
  const text = JSON.stringify(registeredTools().map((tool) => tool.parameters));
  for (const hidden of ["browser_key", "socket", "control_epoch", "observation_id"]) {
    assert.equal(text.includes(hidden), false);
  }
  const act = registeredTools().find((tool) => tool.name === "browser_act");
  assert.deepEqual(act.parameters.properties.action.enum, [
    "click", "type", "press_key", "scroll", "navigate", "get_url", "wait_for",
  ]);
});
