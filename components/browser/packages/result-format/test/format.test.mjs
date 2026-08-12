import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Source-level conformance test runs without installing pnpm dependencies in the
// reconstruction environment. The production CI imports and type-checks the module.
test("formatter keeps TOON at the model presentation boundary", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /formatModelResult/);
  assert.match(source, /await import\("@toon-format\/toon"\)/);
  assert.doesNotMatch(source, /JSON-RPC.*TOON/i);
});
