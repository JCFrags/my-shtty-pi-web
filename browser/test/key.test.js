const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseAgentKey } = require("../dist/agent/key.js");

test("agent key parser normalizes named keys and modifier aliases", () => {
  assert.equal(parseAgentKey("Enter").canonical, "Enter");
  assert.equal(parseAgentKey("Shift+Tab").canonical, "Shift+Tab");
  assert.equal(parseAgentKey("Ctrl+ArrowLeft").canonical, "Control+ArrowLeft");
  assert.equal(parseAgentKey("Command+Enter").canonical, "Meta+Enter");
  assert.equal(parseAgentKey(" ").canonical, "Space");
  assert.equal(parseAgentKey("?").canonical, "?");
});

test("agent key parser rejects malformed and unsupported keys", () => {
  for (const value of [
    "",
    "Control",
    "Ctrl+Control+A",
    "A+B",
    "Enter+Tab",
    "NotAKey",
    "a b",
    "a\u0000",
    "\n",
    "F13",
  ]) {
    assert.throws(() => parseAgentKey(value));
  }
  assert.throws(() => parseAgentKey("a".repeat(129)), /too long/);
});

test("agent key parser permits one printable non-BMP code point", () => {
  const key = parseAgentKey("😀");
  assert.equal(key.canonical, "😀");
  assert.equal(key.character, "😀");
});
