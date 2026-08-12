import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../../apps/workspace/src/App.tsx", import.meta.url), "utf8");
const viewport = await readFile(new URL("../../apps/workspace/src/components/Viewport.tsx", import.meta.url), "utf8");
const rpc = await readFile(new URL("../../apps/workspace/src/lib/rpc.ts", import.meta.url), "utf8");

test("first human input waits for compare-and-set takeover acknowledgement", () => {
  assert.match(viewport, /epochRef\.current = await onTakeover\(epochRef\.current\);\s*await send\(action\)/s);
  assert.match(rpc, /expectedControlEpoch/);
  assert.match(app, /controlState: "takeover-pending"/);
  assert.match(app, /controlState: "human"/);
});

test("return stops input, sends release cleanup, and keeps human state on failure", () => {
  assert.match(app, /await viewportRef\.current\?\.releasePressedInput\(\)/);
  assert.match(app, /setControl\(snapshot\.scopeId, lease, "agent", snapshot\.selected\.controlEpoch\)/);
  assert.match(app, /setSnapshot\(\{ \.\.\.snapshot, controlState: "human" \}\)/);
  assert.match(viewport, /type: "mouse_up"/);
  assert.match(viewport, /type: "key_up"/);
});

test("cancellation remains pending until the daemon sends a scoped update", () => {
  assert.match(app, /state: "cancelling"/);
  assert.match(rpc, /workspace\.cancelOperation/);
  assert.doesNotMatch(app, /state: "cancelled".*await rpc\.cancel/s);
});
