const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openStore } = require("../dist/client");

test("instance registry migration stores startup attempt correlation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-startup-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const opened = openStore(path.join(directory, "registry.db"));
  const columns = opened.sqlite.prepare("PRAGMA table_info(instances)").all();
  assert(columns.some((column) => column.name === "startup_attempt"));
  opened.sqlite.close();
});
