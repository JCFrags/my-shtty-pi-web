import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const corpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));

test("observation benchmark corpus covers the intended TOON candidates", () => {
  assert.deepEqual(corpus.map((entry) => Object.keys(entry.value)[0]), ["results", "controls", "tabs", "requests", "downloads"]);
  for (const entry of corpus) {
    const rows = Object.values(entry.value)[0];
    assert.ok(Array.isArray(rows) && rows.length >= 2);
  }
});

test("model-facing formatter has bounded full-result artifact support", async () => {
  const formatter = await readFile(new URL("../../packages/result-format/src/index.ts", import.meta.url), "utf8");
  const coordinator = await readFile(new URL("../../crates/browserd/src/coordinator.rs", import.meta.url), "utf8");
  assert.match(formatter, /minimumSavings/);
  assert.match(formatter, /artifactId/);
  assert.match(coordinator, /artifact_store/);
  assert.match(coordinator, /max_chars/);
});
