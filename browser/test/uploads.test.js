const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { BrowserUploads } = require('../dist/agent/uploads.js');
const { BrowserAgentRuntime } = require('../dist/agent/runtime.js');
const { BrowserControl } = require('../dist/agent/control.js');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'browser-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(join(root, 'file.txt'), 'fixture');
  const contents = new EventEmitter();
  contents.debugger = new EventEmitter();
  const calls = [];
  const tree = { frameTree: { frame: { id: 'main', loaderId: 'document-1' } } };
  const uploads = new BrowserUploads(contents, async (method, params) => {
    calls.push({ method, params });
    if (options.send) await options.send(method, params);
    if (method === 'Page.getFrameTree') return tree;
    return {};
  });
  const opened = (params = {}) => { uploads.acceptChooserFromClick(); contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', backendNodeId: 12, mode: 'selectSingle', ...params }); };
  const cleanup = () => {
    assert.deepEqual(calls.at(-1), { method: 'Page.setInterceptFileChooserDialog', params: { enabled: false } });
    assert.equal(contents.debugger.listenerCount('message'), 0);
  };
  return { root, contents, calls, uploads, opened, cleanup, tree };
}

test('upload clicks before native chooser assignment and emits no file contents', async t => {
  const f = fixture(t);
  let clicked = false;
  await f.uploads.run(f.root, ['file.txt'], async () => { clicked = true; f.opened(); }, async () => {});
  assert.equal(clicked, true);
  const assign = f.calls.find(call => call.method === 'DOM.setFileInputFiles');
  assert.deepEqual(assign.params, { backendNodeId: 12, files: [join(f.root, 'file.txt')] });
  assert.equal(JSON.stringify(f.calls).includes('fixture'), false);
  f.cleanup();
});

test('chooser rejects wrong frame, changed document and multiple files on single input', async t => {
  for (const variant of ['frame', 'document', 'multiple']) {
    const f = fixture(t);
    let trees = 0;
    await assert.rejects(f.uploads.run(f.root, variant === 'multiple' ? ['file.txt', 'file.txt'] : ['file.txt'], async () => {
      f.opened(variant === 'frame' ? { frameId: 'other' } : {});
    }, async () => {
      if (variant === 'document' && ++trees > 3) throw new Error('page changed');
    }), /observed document|multiple|page changed/);
    assert.ok(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').every(call => call.params.files.length === 0));
    f.cleanup();
  }
});

test('takeover, navigation, context closure and debugger detach clean interception while waiting', async t => {
  for (const reason of ['control', 'navigation', 'close', 'detach']) {
    const f = fixture(t);
    await assert.rejects(f.uploads.run(f.root, ['file.txt'], async () => {
      if (reason === 'control') f.uploads.cancel();
      if (reason === 'navigation') f.contents.emit('did-start-navigation', {}, 'new', false, true);
      if (reason === 'close') f.contents.emit('destroyed');
      if (reason === 'detach') f.contents.debugger.emit('detach');
    }, async () => {}), /cancelled/);
    f.cleanup();
    assert.equal(f.calls.some(call => call.method === 'DOM.setFileInputFiles'), false);
  }
});

test('click failure and stale guard clear opened chooser without assigning files', async t => {
  for (const stale of [true, false]) {
    const f = fixture(t);
    let clicked = false;
    await assert.rejects(f.uploads.run(f.root, ['file.txt'], async () => {
      clicked = true;
      f.opened();
      if (!stale) throw new Error('click failed');
    }, async () => { if (clicked && stale) throw new Error('stale observation'); }), /click failed|stale/);
    assert.deepEqual(f.calls.find(call => call.method === 'DOM.setFileInputFiles').params.files, []);
    f.cleanup();
  }
});

test('unsafe files are rejected before interception or click', async t => {
  const f = fixture(t);
  await assert.rejects(f.uploads.run(f.root, ['../outside'], async () => assert.fail('clicked'), async () => {}), /outside/);
  assert.equal(f.calls.length, 0);
});

test('runtime upload uses the ActionService click and rejects stale observations', async t => {
  const f = fixture(t);
  const control = new BrowserControl();
  const clicks = [];
  const runtime = new BrowserAgentRuntime({ uploads: f.uploads, releaseAgentInput() {}, currentUrl: () => 'about:blank' }, {
    control,
    observer: {
      observe: async () => ({ documentId: 'document-1', snapshot: { viewport: { width: 100, height: 100 }, elements: [{ ref: 'input' }] } }),
      currentDocumentId: async () => 'document-1',
    },
    driver: {}, personaProvider: async () => ({}),
    actionServiceFactory: async () => ({ click: async target => { clicks.push(target); f.opened(); return { x: 10, y: 20 }; } }),
  });
  const observation = await runtime.observe();
  const request = { ref: 'input', files: ['file.txt'], observationId: observation.observationId, expectedControlEpoch: 1 };
  await assert.rejects(runtime.upload({ ...request, observationId: 'stale' }, f.root), /stale/);
  assert.equal(clicks.length, 0);
  await runtime.upload(request, f.root);
  assert.deepEqual(clicks, [{ ref: 'input' }]);
  f.cleanup();
});

test('chooser events before the native click are rejected and cleared', async t => {
  const f = fixture(t);
  await assert.rejects(f.uploads.run(f.root, ['file.txt'], async () => {
    f.contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', backendNodeId: 12, mode: 'selectSingle' });
  }, async () => {}), /cancelled/);
  assert.ok(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').every(call => call.params.files.length === 0));
  f.cleanup();
});

test('changed file paths and interception setup failure fail closed', async t => {
  const f = fixture(t);
  fs.symlinkSync('file.txt', join(f.root, 'alias'));
  await assert.rejects(f.uploads.run(f.root, ['alias'], async () => {
    fs.unlinkSync(join(f.root, 'alias'));
    fs.symlinkSync('../outside', join(f.root, 'alias'));
    f.opened();
  }, async () => {}), /upload/);
  assert.ok(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').every(call => call.params.files.length === 0));
  f.cleanup();
  const broken = fixture(t, { send(method, params) { if (method === 'Page.setInterceptFileChooserDialog' && params.enabled) throw new Error('interception failed'); } });
  await assert.rejects(broken.uploads.run(broken.root, ['file.txt'], async () => assert.fail('clicked'), async () => {}), /interception failed/);
  broken.cleanup();
});

test('chooser timeout cancels input before disabling interception', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const pending = f.uploads.run(f.root, ['file.txt'], async () => {}, async () => {}, () => { cancelled = true; });
  await new Promise(setImmediate);
  const failed = assert.rejects(pending, /cancelled/);
  t.mock.timers.tick(15000);
  await failed;
  assert.equal(cancelled, true);
  f.cleanup();
});
