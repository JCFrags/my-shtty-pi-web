import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const harness = await readFile(new URL("../../scripts/complete-browser-check.mjs", import.meta.url), "utf8");

test("qualification fixes exact path and ownership cases", () => {
  assert.match(harness, /agent-browser\/chrome/);
  assert.match(harness, /pinchtab\/chrome/);
  assert.match(harness, /three-principal ownership isolation/);
  assert.match(harness, /targetPrincipal/);
  assert.match(harness, /fallback unsupported action never changes path/);
  for (const unsupported of ["lightpanda", "rustwright", "camoufox", "ghost-chrome"]) assert.match(harness, new RegExp(unsupported));
});

test("qualification includes bounded cancellation, stale refusal, transfers, cleanup, diagnostics, workspace, and five journeys", () => {
  for (const phrase of ["bounded cancellation matrix", "stale refusal", "owned upload download", "protected cleanup matrix", "safe diagnostics", "workspace identity", "J1", "J2", "J3", "J4", "J5"]) assert.ok(harness.includes(phrase), phrase);
  assert.match(harness, /pending-fresh-model-review/);
  assert.match(harness, /seededNegativeSelector/);
});
