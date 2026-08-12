import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const rpc = await readFile(new URL("../src/lib/rpc.ts", import.meta.url), "utf8");
const viewport = await readFile(new URL("../src/components/Viewport.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("workspace uses a daemon-scoped snapshot and event stream", () => {
  assert.match(rpc, /workspace\.openScoped/);
  assert.match(rpc, /workspace\.getScoped/);
  assert.match(rpc, /workspace\.selectOwnedTab/);
  assert.match(rpc, /authenticated HTTP/);
  assert.doesNotMatch(rpc, /searchParams\.set\(["']token/);
  assert.doesNotMatch(rpc, /new WebSocket/);
  for (const globalCall of ["agent.list", "browser.list", "profile.list", "artifact.list"]) assert.doesNotMatch(app + rpc, new RegExp(globalCall.replace(".", "\\.")));
});

test("normal workspace excludes global profile, artifact, and raw debug features", () => {
  for (const forbidden of ["Profiles & extensions", "Downloads & artifacts", "Cookies", "Storage", "browser.debug", "dataDir", "launchArgs", "artifact.path"]) assert.equal(app.includes(forbidden), false, forbidden);
});

test("selected viewport binds lease, viewport generation, control epoch, and ordered input", () => {
  assert.match(rpc, /workspace\.acquireViewportLease/);
  assert.match(rpc, /workspace\.compareSetControl/);
  assert.match(viewport, /viewportGeneration/);
  assert.match(viewport, /controlEpoch/);
  assert.match(viewport, /\+\+inputSequence\.current/);
  assert.match(rpc, /screenshotSha256: frame\.screenshotSha256/);
  assert.match(viewport, /acceptFrame/);
  assert.match(viewport, /releasePressedInput/);
  assert.doesNotMatch(viewport, /input_touch/);
});

test("workspace has visible control, operation, cancellation, stale, and failure states", () => {
  for (const label of ["Return to agent", "Cancellation pending", "Takeover pending", "Stale", "Workspace notice", "Scoped events"]) assert.match(app, new RegExp(label));
  assert.match(styles, /@media \(max-width: 850px\)/);
  assert.match(styles, /@media \(max-width: 560px\)/);
});
