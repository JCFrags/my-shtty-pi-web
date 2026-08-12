import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROTOCOL_VERSION, RPC_EVENTS, RPC_METHODS, SUPPORTED_PATH_IDS,
  ProtocolValidationError, assertBinding, assertCurrentVisual, assertPointInViewport, assertProtocolAddress,
} from "../dist/index.js";

const root = new URL("../../../", import.meta.url);
const load = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof ProtocolValidationError && error.code === code);
}

test("schema is the protocol 2 authority and matches TypeScript constants", async () => {
  const schema = await load("schema/protocol.schema.json");
  assert.equal(schema.version, PROTOCOL_VERSION);
  assert.deepEqual(schema.supportedPaths, [...SUPPORTED_PATH_IDS]);
  assert.deepEqual(schema.methods, [...RPC_METHODS]);
  assert.deepEqual(schema.events, [...RPC_EVENTS]);
  assert.equal(new Set(schema.methods).size, schema.methods.length);
  assert.equal(schema.$defs.capabilities.properties.touch.const, false);
  assert.ok(!schema.$defs.actionKind.enum.some((kind) => kind.startsWith("touch")));
});

test("valid fixture binds principal, owner, path, generations, and epoch", async () => {
  const fixtures = await load("schema/conformance-fixtures.json");
  const { owner, path, address } = fixtures.valid;
  assert.doesNotThrow(() => assertProtocolAddress(address));
  assert.doesNotThrow(() => assertBinding(fixtures.authenticatedPrincipal, owner, address, path, address.controlEpoch));
});

test("malformed, wrong-owner, wrong-path, and stale fixtures fail closed", async () => {
  const fixtures = await load("schema/conformance-fixtures.json");
  const { owner, path, address } = fixtures.valid;
  const byName = Object.fromEntries(fixtures.invalid.map((item) => [item.name, item]));

  expectCode(byName["malformed-empty-session"].expectedCode, () => assertProtocolAddress(byName["malformed-empty-session"].address));
  expectCode(byName["wrong-owner"].expectedCode, () => assertBinding(
    { ...fixtures.authenticatedPrincipal, principalId: byName["wrong-owner"].principalId }, owner, address, path, address.controlEpoch,
  ));
  expectCode(byName["wrong-path"].expectedCode, () => assertBinding(
    fixtures.authenticatedPrincipal, owner, { ...address, pathId: byName["wrong-path"].requestedPathId }, path, address.controlEpoch,
  ));
  expectCode(byName["unsupported-path"].expectedCode, () => assertProtocolAddress({ ...address, pathId: byName["unsupported-path"].requestedPathId }));
  expectCode(byName["stale-host-generation"].expectedCode, () => assertBinding(
    fixtures.authenticatedPrincipal, owner, address, { ...path, hostGeneration: byName["stale-host-generation"].actualGeneration }, address.controlEpoch,
  ));
  expectCode(byName["stale-control-epoch"].expectedCode, () => assertBinding(
    fixtures.authenticatedPrincipal, owner, address, path, byName["stale-control-epoch"].actualControlEpoch,
  ));
});

test("visual actions reject stale screenshots and out-of-range CSS coordinates", async () => {
  const fixtures = await load("schema/conformance-fixtures.json");
  const guard = fixtures.valid.visualGuard;
  const screenshot = {
    artifactId: "artifact-a", sha256: guard.screenshotSha256, sequence: guard.screenshotSequence,
    capturedAt: "2026-08-12T07:00:00Z", pixelWidth: 1280, pixelHeight: 960,
    viewport: { viewportId: guard.viewportId, generation: guard.viewportGeneration + 1, cssWidth: 640, cssHeight: 480,
      deviceScaleFactor: 2, scrollX: 0, scrollY: 0, coordinateSpace: "css-viewport-top-left" },
  };
  expectCode("stale-visual", () => assertCurrentVisual(guard, screenshot));
  expectCode("invalid-request", () => assertPointInViewport({ x: 640, y: 120 }, screenshot.viewport));
});
