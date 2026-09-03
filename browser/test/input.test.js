const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PageInput } = require("../dist/page/input.js");

function inputFixture() {
  const events = [];
  const target = {
    contents: () => ({ sendInputEvent: (event) => events.push(event) }),
    scale: () => 1,
    focus: () => undefined,
    cdp: async () => undefined,
  };
  return { input: new PageInput(target), events };
}

const mods = { shift: false, alt: false, ctrl: false, super: false };

test("PageInput releases physical buttons without releasing programmatic buttons", () => {
  const { input, events } = inputFixture();
  input.programmaticPointer({ kind: "down", x: 10, y: 12, button: "left" });
  input.pointer({ kind: "down", x: 20, y: 22, button: "right", mods });
  input.releasePhysicalInput();

  assert.deepEqual(events.map(({ type, button }) => ({ type, button })), [
    { type: "mouseDown", button: "left" },
    { type: "mouseDown", button: "right" },
    { type: "mouseUp", button: "right" },
  ]);
  input.releaseProgrammaticButtons();
  assert.equal(events.at(-1)?.type, "mouseUp");
  assert.equal(events.at(-1)?.button, "left");
});

test("PageInput ignores an unmatched programmatic pointer up", () => {
  const { input, events } = inputFixture();
  input.programmaticPointer({ kind: "up", x: 10, y: 12, button: "left" });
  assert.deepEqual(events, []);
});
