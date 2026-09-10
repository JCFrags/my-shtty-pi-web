const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  parseDragRequest,
  parseGetUrlRequest,
  parseHoverRequest,
  parseNavigateRequest,
  parsePressKeyRequest,
  parseScrollRequest,
  parseTypeRequest,
  parseWaitForRequest,
} = require("../dist/agent/protocol.js");

const observation = { observationId: "obs-1", expectedControlEpoch: 3 };

test("agent protocol parses bounded type, key, and scroll requests", () => {
  assert.deepEqual(parseTypeRequest({
    tab: 2,
    ref: "e1",
    text: "Ada",
    ...observation,
  }), {
    tab: 2,
    request: { ref: "e1", text: "Ada", replace: false, ...observation },
  });
  assert.equal(parseTypeRequest({
    tab: 2,
    ref: "e1",
    text: "",
    replace: true,
    ...observation,
  }).request.text, "");
  assert.equal(parsePressKeyRequest({
    tab: 2,
    key: "Ctrl+A",
    ...observation,
  }).request.key, "Ctrl+A");
  assert.deepEqual(parseScrollRequest({
    tab: 2,
    dy: -40,
    ...observation,
  }).request, { dx: 0, dy: -40, ...observation });
});

test("agent protocol parses hover and drag targets", () => {
  assert.deepEqual(parseHoverRequest({ tab: 1, ref: "e1", ...observation }).request, {
    target: { ref: "e1" }, ...observation,
  });
  assert.deepEqual(parseDragRequest({
    tab: 1, fromRef: "e1", toX: 20, toY: 30, button: "right", ...observation,
  }).request, {
    from: { ref: "e1" }, to: { x: 20, y: 30 }, button: "right", ...observation,
  });
  assert.throws(() => parseHoverRequest({ tab: 1, ref: "e1", x: 2, y: 3, ...observation }), /exactly one/);
  assert.throws(() => parseDragRequest({ tab: 1, fromX: 1, toRef: "e2", ...observation }), /x and y/);
});

test("agent protocol rejects malformed input bounds", () => {
  assert.throws(() => parseTypeRequest({ tab: 1, ref: "e1", text: "", ...observation }), /must not be empty/);
  assert.throws(() => parseTypeRequest({ tab: 1, ref: "e1", text: "x\0y", ...observation }), /NUL/);
  assert.throws(() => parseTypeRequest({ tab: 1, ref: "e1", text: "x", replace: "yes", ...observation }), /replace/);
  assert.throws(() => parsePressKeyRequest({ tab: 1, key: "Control", ...observation }), /non-modifier|key/);
  assert.throws(() => parseScrollRequest({ tab: 1, dy: 0, ...observation }), /nonzero/);
  assert.throws(() => parseScrollRequest({ tab: 1, dy: Infinity, ...observation }), /finite/);
  assert.throws(() => parseScrollRequest({ tab: 1, dy: 20_001, ...observation }), /too large/);
});

test("agent protocol validates navigation allowlist and get-url epoch", () => {
  assert.deepEqual(parseNavigateRequest({ tab: 1, url: "https://example.test/", expectedControlEpoch: 3 }), {
    tab: 1,
    request: { url: "https://example.test/", expectedControlEpoch: 3 },
  });
  assert.equal(parseGetUrlRequest({ tab: 1, expectedControlEpoch: 3 }).request.expectedControlEpoch, 3);
  for (const url of ["javascript:alert(1)", "data:text/html,x", "about:srcdoc", "   ", "https://x\n/"]) {
    assert.throws(() => parseNavigateRequest({ tab: 1, url, expectedControlEpoch: 3 }));
  }
});

test("agent protocol parses wait conditions and enforces their inputs", () => {
  assert.deepEqual(parseWaitForRequest({
    tab: 1,
    ref: "e1",
    condition: "visible",
    timeoutMs: 500,
    ...observation,
  }).request, {
    ref: "e1",
    condition: "visible",
    timeoutMs: 500,
    ...observation,
  });
  assert.deepEqual(parseWaitForRequest({
    tab: 1,
    text: "ready",
    timeoutMs: 0,
    ...observation,
  }).request, {
    text: "ready",
    timeoutMs: 0,
    ...observation,
  });
  for (const request of [
    { tab: 1, timeoutMs: 1, ...observation },
    { tab: 1, text: "", timeoutMs: 1, ...observation },
    { tab: 1, condition: "exists", text: "ready", timeoutMs: 1, ...observation },
    { tab: 1, ref: "e1", condition: "text", timeoutMs: 1, ...observation },
    { tab: 1, ref: "e1", timeoutMs: 60_001, ...observation },
  ]) {
    assert.throws(() => parseWaitForRequest(request));
  }
});
