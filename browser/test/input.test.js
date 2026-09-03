const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PageInput } = require("../dist/page/input.js");

function inputFixture(options = {}) {
  const events = [];
  const target = {
    contents: () => ({
      sendInputEvent: (event) => events.push(event),
      selectAll: () => events.push({ type: "selectAll" }),
      insertText: async (text) => events.push({ type: "insertText", text }),
    }),
    scale: () => 1,
    focus: options.focus || (() => undefined),
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

test("PageInput keeps physical and programmatic keys independent", async () => {
  const { input, events } = inputFixture();
  input.key({ kind: "press", key: "a", text: "a", mods });
  await input.programmaticKeyDown({
    canonical: "Control+A",
    identity: "Control+A",
    keyCode: "a",
    modifiers: ["ctrl"],
    character: null,
  });
  input.releasePhysicalInput();
  input.releaseProgrammaticKeys();
  assert.deepEqual(events.map(({ type, keyCode, modifiers }) => ({ type, keyCode, modifiers })), [
    { type: "rawKeyDown", keyCode: "a", modifiers: [] },
    { type: "char", keyCode: "a", modifiers: [] },
    { type: "rawKeyDown", keyCode: "a", modifiers: ["ctrl"] },
    { type: "keyUp", keyCode: "a", modifiers: [] },
    { type: "keyUp", keyCode: "a", modifiers: ["ctrl"] },
  ]);
});

test("PageInput programmatic key cycle dispatches down, character, and up", async () => {
  const { input, events } = inputFixture();
  const key = {
    canonical: "x",
    identity: "x",
    keyCode: "x",
    modifiers: [],
    character: "x",
  };
  await input.programmaticKeyDown(key);
  await input.programmaticKeyChar(key);
  input.programmaticKeyUp(key);
  input.programmaticKeyUp(key);
  assert.deepEqual(events.map(({ type, keyCode }) => ({ type, keyCode })), [
    { type: "rawKeyDown", keyCode: "x" },
    { type: "char", keyCode: "x" },
    { type: "keyUp", keyCode: "x" },
  ]);
});

test("PageInput releases a held programmatic key only once", async () => {
  const { input, events } = inputFixture();
  const key = {
    canonical: "Enter",
    identity: "Enter",
    keyCode: "return",
    modifiers: [],
    character: "\\r",
  };
  await input.programmaticKeyDown(key);
  input.releaseProgrammaticInput();
  input.programmaticKeyUp(key);
  assert.deepEqual(events.map(({ type }) => type), ["rawKeyDown", "keyUp"]);
});

test("PageInput selects all and inserts text through native editing methods", async () => {
  const { input, events } = inputFixture();
  await input.selectAllProgrammatic();
  await input.insertTextProgrammatic("Ada");
  assert.deepEqual(events, [
    { type: "selectAll" },
    { type: "insertText", text: "Ada" },
  ]);
});

test("PageInput cancels a programmatic key waiting for focus after release", async () => {
  let resolveFocus;
  const focus = new Promise((resolve) => { resolveFocus = resolve; });
  const { input, events } = inputFixture({ focus: () => focus });
  const key = {
    canonical: "x",
    identity: "x",
    keyCode: "x",
    modifiers: [],
    character: "x",
  };
  const pending = input.programmaticKeyDown(key);
  input.releaseProgrammaticInput();
  resolveFocus();
  await assert.rejects(pending, /agent input was released/);
  assert.deepEqual(events, []);
});
