import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  PINCHTAB_PATH_ID,
  PINCHTAB_PROVIDER,
  PINCHTAB_VERSION,
  redactSecrets,
  validatePinchTabProvider,
  validatePinchTabRoute,
} from "../../scripts/lib/pinchtab.mjs";

const source = await readFile(new URL("../../crates/backend-pinchtab/src/lib.rs", import.meta.url), "utf8");

// These checks protect the explicit selection boundary during protocol-lane rebases.
test("PinchTab adapter keeps one exact provider and no silent fallback", () => {
  assert.equal(PINCHTAB_PATH_ID, "pinchtab/chrome");
  assert.equal(PINCHTAB_PROVIDER, "chrome");
  assert.equal(PINCHTAB_VERSION, "0.15.1");
  assert.equal(validatePinchTabProvider("chrome"), "chrome");
  assert.throws(() => validatePinchTabProvider("agent-browser"), /unsupported PinchTab provider/);
  assert.throws(() => validatePinchTabProvider("ghost-chrome"), /unsupported PinchTab provider/);
  assert.match(source, /const PATH_ID: &str = "pinchtab\/chrome"/);
  assert.match(source, /const SUPPORTED_VERSION: &str = "=0\.15\.1"/);
  assert.match(source, /validate_instance_provider/);
  assert.doesNotMatch(source, /fallbackOrder|browser-fallback/);
  assert.doesNotMatch(source, /Command::new\([^)]*agent-browser/);
});

test("routed responses fail closed on missing, changed, or escalated provider", () => {
  const valid = { route: { requestedProvider: "chrome", usedProvider: "chrome", escalated: false } };
  assert.equal(validatePinchTabRoute(valid), valid);
  assert.throws(() => validatePinchTabRoute({ success: true }), /omitted provider identity/);
  assert.throws(() => validatePinchTabRoute({ route: { requestedProvider: "chrome", usedProvider: "cloak", escalated: false } }), /provider mismatch/);
  assert.throws(() => validatePinchTabRoute({ route: { requestedProvider: "chrome", usedProvider: "chrome", escalated: true } }), /provider mismatch/);
});

test("protocol v2 ownership, cancellation, settlement, and cleanup stay explicit", () => {
  assert.match(source, /impl BrowserControllerV2 for PinchTabController/);
  assert.match(source, /BrowserPathId::PinchtabChrome/);
  assert.match(source, /ChromeProvider::Chrome/);
  assert.match(source, /BackendOperationRequest<BrowserActionV2>/);
  assert.match(source, /DurableOperation/);
  assert.match(source, /ProtocolObservation/);
  assert.match(source, /ActionOutcomeV2/);
  assert.match(source, /validate_v2_request/);
  assert.match(source, /pinch_session_id/);
  assert.match(source, /instance_id/);
  assert.match(source, /cancel_host_operation/);
  assert.match(source, /cancel_notify/);
  assert.match(source, /kill_on_drop\(true\)/);
  assert.match(source, /settled_tabs/);
  assert.match(source, /settled_hosts/);
  assert.match(source, /settled_v2_tabs/);
  assert.match(source, /settled_v2_sessions/);
  assert.match(source, /duplicate active PinchTab owner session requires explicit close/);
  assert.match(source, /session.*revoke/s);
  assert.match(source, /instance.*stop/s);
  assert.match(source, /remove_dir_all/);
});

test("secret fields are redacted from harness results", () => {
  assert.deepEqual(
    redactSecrets({ id: "session", sessionToken: "private", nested: { cookieValue: "private" } }),
    { id: "session", sessionToken: "<redacted>", nested: { cookieValue: "<redacted>" } },
  );
});
