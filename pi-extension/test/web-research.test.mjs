import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWebResearch } from "../dist/web-research.js";

test("Pi Web compatibility keeps research tools and retires its browser provider", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-research-"));
  const extensionPath = path.join(directory, "extension.mjs");
  await fs.writeFile(extensionPath, `
    export default function (pi) {
      pi.registerTool({ name: "web_search" });
      pi.registerTool({ name: "browser_open" });
      pi.registerTool({ name: "browser_debug" });
      pi.on("before_agent_start", () => {});
      pi.on("session_start", () => {});
      pi.setActiveTools(["web_search", "browser_open", "browser_debug"]);
    }
  `);

  const tools = [];
  const events = [];
  let active = ["browser_open"];
  const pi = {
    registerTool(tool) { tools.push(tool.name); },
    on(event) { events.push(event); },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
  };

  try {
    assert.equal(await loadWebResearch(pi, extensionPath), true);
    assert.deepEqual(tools, ["web_search"]);
    assert.deepEqual(events, ["session_start"]);
    assert.deepEqual(active.sort(), ["browser_open", "web_search"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("missing archived Pi Web is an optional no-op", async () => {
  assert.equal(await loadWebResearch({}, "/nonexistent/pi-web-extension.mjs"), false);
});
