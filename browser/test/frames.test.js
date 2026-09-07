const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { BrowserFrames } = require('../dist/agent/frames.js');

function fixture() {
  const contents = new EventEmitter();
  contents.debugger = new EventEmitter();
  contents.getZoomFactor = () => 1;
  const calls = [];
  const emit = (method, params, session = '') => contents.debugger.emit('message', {}, method, params, session);
  const context = (frameId, uniqueId, session = '', id = 1) => emit('Runtime.executionContextCreated', {
    context: { id, uniqueId, auxData: { frameId, isDefault: true } },
  }, session);
  const send = async (method, params, session = '') => {
    calls.push({ method, params, session });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: session ? 'child' : 'root', loaderId: 'loader-' + session, url: 'http://example.test/' } } };
    if (method === 'Runtime.enable') context(session ? 'child' : 'root', session ? 'child-document' : 'root-document', session);
    if (method === 'Runtime.evaluate') return { result: { value: 'evaluated' } };
    return {};
  };
  const frames = new BrowserFrames(contents, send, async session => { calls.push({ method: 'initialize-dialogs', session }); });
  return { contents, frames, emit, context, calls };
}

test('frame table uses default unique contexts and iframe-only recursive session attachment', async () => {
  const { frames, emit, context, calls } = fixture();
  await frames.initialize();
  emit('Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child', parentFrameId: 'root' }, waitingForDebugger: true });
  await frames.select('f2');
  assert.equal(frames.selectedFrame().session, 'child-session');
  assert.equal(await frames.evaluate('42'), 'evaluated');
  const evaluation = calls.find(call => call.method === 'Runtime.evaluate');
  assert.equal(evaluation.params.uniqueContextId, 'child-document');
  assert.equal(evaluation.session, 'child-session');
  assert.equal('contextId' in evaluation.params, false);
  context('child', 'isolated-not-default', 'unknown-session');
  assert.equal(frames.selectedFrame().context, 'child-document');
  const attached = calls.filter(call => call.method === 'Target.setAutoAttach');
  assert.equal(attached.length, 2);
  for (const call of attached) {
    assert.deepEqual(call.params.filter, [{ type: 'iframe', exclude: false }, { exclude: true }]);
    assert.equal(call.params.flatten, true);
    assert.equal(call.params.waitForDebuggerOnStart, true);
  }
  assert(calls.findIndex(call => call.method === 'initialize-dialogs') < calls.findIndex(call => call.method === 'Runtime.runIfWaitingForDebugger'));
});

test('ancestor changes invalidate selection while unrelated sibling changes do not', async () => {
  const { frames, emit, context } = fixture();
  await frames.initialize();
  emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
  context('child', 'child-document', '', 2);
  emit('Page.frameAttached', { frameId: 'nested', parentFrameId: 'child' });
  context('nested', 'nested-document', '', 3);
  emit('Page.frameAttached', { frameId: 'sibling', parentFrameId: 'root' });
  context('sibling', 'sibling-document', '', 4);
  await frames.select('f3');
  const document = frames.documentKey();
  let invalidated = 0;
  frames.subscribe(() => invalidated++);
  emit('Page.frameNavigated', { frame: { id: 'sibling', parentId: 'root', loaderId: 'new', url: 'http://other.test/' } });
  assert.equal(invalidated, 0);
  emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'http://example.test/#new' });
  assert.equal(invalidated, 1);
  context('child', 'replacement-document', '', 2);
  assert.notEqual(frames.documentKey(), document);
  emit('Page.frameDetached', { frameId: 'child', reason: 'remove' });
  assert.throws(() => frames.chain(), /ancestor changed/);
  await frames.select('main');
  assert.equal(frames.summaries().frames.some(frame => frame.ref === 'f3'), false);
});

test('late old-session detach cannot delete a replacement process context', async () => {
  const { frames, emit, context } = fixture();
  await frames.initialize();
  emit('Target.attachedToTarget', { sessionId: 'old-session', targetInfo: { type: 'iframe', targetId: 'child', parentFrameId: 'root' }, waitingForDebugger: false });
  await frames.select('f2');
  context('child', 'replacement-document', '', 2);
  emit('Target.detachedFromTarget', { sessionId: 'old-session' });
  assert.equal(frames.selectedFrame().context, 'replacement-document');
  assert.equal(frames.selectedFrame().session, '');
});

test('frame summaries stay bounded and never include native context identifiers', async () => {
  const { frames, emit, context } = fixture();
  await frames.initialize();
  for (let index = 0; index < 40; index++) {
    emit('Page.frameAttached', { frameId: 'frame-' + index, parentFrameId: 'root' });
    context('frame-' + index, 'native-context-' + index, '', index + 2);
  }
  const summary = frames.summaries();
  assert.equal(summary.frames.length, 24);
  assert.equal(summary.framesTruncated, true);
  assert.equal(JSON.stringify(summary).includes('native-context-'), false);
  assert.equal(JSON.stringify(summary).includes('frame-'), false);
});

test('failed drag cleanup cannot skip releasing the held button', async () => {
  const { TerminalBrowserDriver } = require('../dist/agent/terminal-browser-driver.js');
  const events = [];
  let released = 0;
  const driver = new TerminalBrowserDriver({
    viewportSize: () => ({ width: 800, height: 600 }),
    agentPointer: event => events.push(event),
    agentStartDrag: async () => {},
    agentFinishDrag: async () => { throw new Error('cleanup failed'); },
    releaseAgentInput: () => { released++; },
  }, {}, { sleep: async () => { throw new Error('input cancelled'); } });
  await assert.rejects(driver.drag({ mode: 'content', button: 'left', target: { x: 500, y: 300 },
    samples: [{ x: 400, y: 300, t: 0 }, { x: 500, y: 300, t: 1 }] }), /input cancelled/);
  assert(events.some(event => event.kind === 'down'));
  assert.equal(events.at(-1).kind, 'up');
  assert.equal(released, 1);
});
