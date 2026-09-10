const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { BrowserDialogs, PROMPT_SOURCE } = require('../dist/agent/dialogs.js');
const { BrowserControl } = require('../dist/agent/control.js');

function fixture(timeout = 60000) {
  const contents = new EventEmitter();
  contents.debugger = new EventEmitter();
  contents.getURL = () => 'https://fixture.test/';
  const commands = [];
  const control = new BrowserControl();
  const dialogs = new BrowserDialogs(contents, async (method, params) => {
    commands.push({ method, params });
    if (method === 'Debugger.evaluateOnCallFrame' && !params.expression.startsWith('promptResult')) return { result: { value: { message: 'Question', defaultValue: 'Default' } } };
    return {};
  }, timeout);
  dialogs.configure(7, control);
  const event = (method, params) => contents.debugger.emit('message', {}, method, params);
  const native = () => event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Question' });
  return { contents, commands, control, dialogs, event, native };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('dialogs require exact identity and current control; duplicate responses fail', async () => {
  const f = fixture();
  f.native();
  const pending = f.dialogs.pending;
  assert.equal(pending.contextId, 7);
  await assert.rejects(f.dialogs.respond({ dialogId: 'wrong', expectedControlEpoch: 1, accept: true }), /stale/);
  f.control.takeHuman('keyboard');
  await assert.rejects(f.dialogs.respond({ dialogId: pending.id, expectedControlEpoch: 1, accept: true }), /stale/);
  f.control.resume(2);
  await f.dialogs.respond({ dialogId: pending.id, expectedControlEpoch: 3, accept: false });
  assert.deepEqual(f.commands.at(-1), { method: 'Page.handleJavaScriptDialog', params: { accept: false } });
  await assert.rejects(f.dialogs.respond({ dialogId: pending.id, expectedControlEpoch: 3, accept: true }), /stale/);
  f.dialogs.dispose();
});

test('beforeunload cancels first and replays only one exact known intent', async () => {
  const f = fixture();
  let allows = 0;
  let replays = 0;
  const event = { preventDefault() { allows++; } };
  const replay = () => { replays++; f.contents.emit('will-prevent-unload', event); };
  f.dialogs.runIntent({ type: 'navigate', url: 'https://next.test/' }, replay, () => f.contents.emit('will-prevent-unload', event));
  const first = f.dialogs.pending;
  f.contents.emit('did-stop-loading');
  assert.equal(allows, 0);
  assert.deepEqual(first.intent, { type: 'navigate', url: 'https://next.test/' });
  await f.dialogs.respond({ dialogId: first.id, expectedControlEpoch: 1, accept: true });
  await tick();
  assert.equal(replays, 1);
  assert.equal(allows, 1);
  f.contents.emit('will-prevent-unload', event);
  assert.equal(allows, 1);
  assert.equal(f.dialogs.pending.canAccept, false);
  await assert.rejects(f.dialogs.respond({ dialogId: f.dialogs.pending.id, expectedControlEpoch: 1, accept: true }), /unknown beforeunload/);
  await f.dialogs.cancel();
  f.dialogs.dispose();
});

test('navigation mismatch and timeout never grant beforeunload permission', async () => {
  const f = fixture(5);
  let replayed = false;
  f.dialogs.runIntent({ type: 'navigate', url: 'https://next.test/' }, () => { replayed = true; }, () => {});
  f.contents.emit('did-start-navigation', {}, 'https://other.test/', false, true);
  f.contents.emit('will-prevent-unload', { preventDefault() { throw new Error('must not allow'); } });
  assert.equal(f.dialogs.pending.canAccept, false);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.dialogs.pending, null);
  assert.equal(replayed, false);
  f.dialogs.dispose();
});

test('prompt provenance rejects same-name and identical-source script clones', async () => {
  const f = fixture();
  const parsed = { url: 'terminal-browser-prompt.js', executionContextId: 3, hash: createHash('sha256').update(PROMPT_SOURCE).digest('hex'), startLine: 0, endLine: 9 };
  f.event('Debugger.scriptParsed', { ...parsed, scriptId: 'trusted' });
  f.event('Debugger.scriptParsed', { ...parsed, scriptId: 'clone' });
  const pause = scriptId => f.event('Debugger.paused', { callFrames: [{ callFrameId: 'frame', functionName: 'terminalBrowserPrompt', location: { scriptId, lineNumber: 5, columnNumber: 2 } }] });
  pause('ordinary');
  await tick();
  assert.equal(f.dialogs.pending, null);
  pause('clone');
  await tick();
  assert.equal(f.dialogs.pending, null);
  assert.equal(f.commands.at(-1).method, 'Debugger.resume');
  pause('trusted');
  await tick();
  const pending = f.dialogs.pending;
  assert.equal(pending.type, 'prompt');
  await f.dialogs.respond({ dialogId: pending.id, expectedControlEpoch: 1, accept: true, text: 'quote "\n' });
  assert.equal(f.commands.at(-2).params.expression, 'promptResult = "quote \\"\\n"');
  assert.equal(f.commands.at(-1).method, 'Debugger.resume');
  f.dialogs.dispose();
});

test('detach and destruction clear dialog state without reading destroyed WebContents', () => {
  const f = fixture();
  f.native();
  f.contents.debugger.emit('detach');
  assert.equal(f.dialogs.pending, null);
  Object.defineProperty(f.contents, 'debugger', { get() { throw new Error('destroyed'); } });
  assert.doesNotThrow(() => f.contents.emit('destroyed'));
});
