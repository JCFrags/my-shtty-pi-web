import assert from "node:assert/strict";
import test from "node:test";
import { acceptFrame, mapViewportPoint, safeFailure, selectOwnedTab } from "../src/model.ts";
import { fixtureData } from "../src/fixtures.ts";

const fixture = fixtureData("live");
const lease = fixture.lease;

function frame(overrides = {}) {
  return {
    viewportId: lease.identity.viewportId,
    viewportGeneration: lease.identity.viewportGeneration,
    sequence: 4,
    capturedAt: "2026-08-12T07:00:00.000Z",
    mediaType: "image/png",
    width: 1280,
    height: 960,
    coordinateSpace: "css-viewport",
    payload: "public-fixture-bytes",
    screenshotSha256: "a".repeat(64),
    controlEpoch: lease.identity.controlEpoch,
    geometry: lease.geometry,
    ...overrides,
  };
}

test("frames require the selected viewport, generation, geometry, and increasing sequence", () => {
  assert.equal(acceptFrame(frame(), lease, 3), "accept");
  assert.equal(acceptFrame(frame({ sequence: 3 }), lease, 3), "stale");
  assert.equal(acceptFrame(frame({ viewportGeneration: 6 }), lease, 3), "stale");
  assert.equal(acceptFrame(frame({ viewportId: "another-viewport" }), lease, 3), "stale");
  assert.equal(acceptFrame(frame({ width: 640 }), lease, 3), "invalid");
  assert.equal(acceptFrame(frame({ mediaType: "text/html" }), lease, 3), "invalid");
});

test("coordinate mapping uses CSS viewport pixels at DPR 2 and rejects out-of-range points", () => {
  const rect = { left: 100, top: 50, width: 640, height: 480 };
  assert.deepEqual(mapViewportPoint(420, 290, rect, lease.geometry), { x: 320, y: 240 });
  assert.deepEqual(mapViewportPoint(100, 50, rect, lease.geometry), { x: 0, y: 0 });
  assert.equal(mapViewportPoint(99, 290, rect, lease.geometry), undefined);
  assert.equal(mapViewportPoint(420, 531, rect, lease.geometry), undefined);
});

test("owned tab selection cannot return a tab outside the scoped session list", () => {
  const snapshot = fixture.snapshot;
  assert.equal(selectOwnedTab(snapshot, "tab-public-fixture")?.title, "Public fixture page");
  const injected = { ...snapshot, tabs: [...snapshot.tabs, { ...snapshot.tabs[0], tabId: "unrelated", browserSessionId: "foreign-session" }] };
  assert.equal(selectOwnedTab(injected, "unrelated"), undefined);
});

test("failure rendering ignores raw backend text, paths, URLs, and invalid diagnostic references", () => {
  const result = safeFailure({ code: "operation_failed", message: "token=secret /home/person/private", diagnosticRef: "../../private" });
  assert.deepEqual(result, { code: "operation_failed", message: "The browser operation failed.", recovery: "retry" });
  assert.equal(safeFailure({ code: "unknown", message: "https://private.invalid" }).message, "The browser operation failed.");
});

test("all deterministic public fixture states contain no private exposure fields", () => {
  for (const state of ["no-session", "connecting", "live", "takeover-pending", "human", "return-pending", "stale", "unsupported", "queued", "cancelling", "cancelled", "crashed", "failed"]) {
    const serialized = JSON.stringify(fixtureData(state));
    for (const forbidden of ["dataDir", "extensions", "launchArgs", "cookie", "storage", "artifactPath", "engineSessionId"]) assert.equal(serialized.includes(forbidden), false, `${state} contains ${forbidden}`);
  }
});
