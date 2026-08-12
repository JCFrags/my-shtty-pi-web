import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../crates/backend-agent-browser/src/lib.rs", import.meta.url), "utf8");

test("agent-browser adapter preserves capability and explicit isolation", () => {
  assert.match(source, /AGENT_BROWSER_NAMESPACE/);
  assert.match(source, /AGENT_BROWSER_SESSION/);
  assert.match(source, /AGENT_BROWSER_IDLE_TIMEOUT_MS", "0"/);
  assert.match(source, /AGENT_BROWSER_DOWNLOAD_PATH/);
  assert.match(source, /operation_lock/);
  assert.match(source, /sync_tabs/);
  assert.match(source, /stream.*status/s);
  assert.match(source, /launch_args\.join\(","\)/);
  assert.doesNotMatch(source, /AGENT_BROWSER_HEADED.*runtime\.launch\.visible/s);
});

test("backend output remains artifact-recoverable and errors stay structured", () => {
  assert.match(source, /rawContent/);
  assert.match(source, /backend\.insert\("raw"/);
  assert.match(source, /structured: parsed/);
  assert.match(source, /BackendError::Unsupported/);
});

test("agent-browser implements the strict protocol v2 controller seam", () => {
  assert.match(source, /impl BrowserControllerV2 for AgentBrowserController/);
  assert.match(source, /BrowserPathId::AgentBrowserChrome/);
  assert.match(source, /PathIdentity/);
  assert.match(source, /ProtocolObservation/);
  assert.match(source, /ActionOutcomeV2/);
  assert.match(source, /DurableOperation/);
  assert.match(source, /cancel_operation/);
  assert.match(source, /VisualGuard/);
  assert.match(source, /read_owned_visual_artifact/);
  assert.match(source, /touch: false/);
  assert.doesNotMatch(source, /BrowserPathId::PinchtabChrome/);
});
