import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("protocol never defines a global current browser field", async () => {
  const schema = await readFile(new URL("../../schema/protocol.schema.json", import.meta.url), "utf8");
  for (const forbidden of ["currentBrowser", "currentAgent", "globalTab", "globalSession"]) assert.equal(schema.includes(forbidden), false, forbidden);
});
