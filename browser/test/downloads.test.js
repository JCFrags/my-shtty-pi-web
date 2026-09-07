const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { BrowserDownloads, registerDownloadSource } = require('../dist/agent/downloads.js');
const { BrowserControl } = require('../dist/agent/control.js');
const owner = { workspaceId: 'workspace', tabId: 'tab', paneId: 'pane' };
const historyName = 'history-' + require('node:crypto').createHash('sha256').update(JSON.stringify(Object.values(owner))).digest('hex') + '.json';

class Item extends EventEmitter {
  constructor(name = 'file.txt') { super(); this.name = name; this.received = 0; this.total = 100; this.cancelled = false; }
  getFilename() { return this.name; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  setSavePath(path) { this.path = path; }
  cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled'); }
}

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'browser-downloads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = new BrowserControl();
  const tracker = new BrowserDownloads(root, owner);
  t.after(() => tracker.stop());
  return { root, control, tracker };
}

test('one session dispatcher routes each source to exact owner and context, not first callback', t => {
  const { root, tracker } = fixture(t);
  const other = new BrowserDownloads(root, { ...owner, paneId: 'other' });
  t.after(() => other.stop());
  const session = new EventEmitter();
  const sources = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
  for (const source of sources) source.session = session;
  registerDownloadSource(sources[0], tracker, 1);
  registerDownloadSource(sources[1], other, 1);
  registerDownloadSource(sources[2], tracker, 2);
  assert.equal(session.listenerCount('will-download'), 1);
  const items = [new Item(), new Item(), new Item()];
  sources.forEach((source, i) => session.emit('will-download', {}, items[i], source));
  assert.deepEqual(tracker.list().map(item => item.contextId), [1, 2]);
  assert.equal(other.list().length, 1);
  assert.notEqual(items[0].path, items[1].path);
  const foreignId = other.list()[0].id;
  assert.throws(() => tracker.cancel(foreignId), /unknown/);
  assert.throws(() => tracker.cancel(tracker.list()[0].id, 2), /unknown/);
  let prevented = false;
  session.emit('will-download', { preventDefault() { prevented = true; } }, new Item(), new EventEmitter());
  assert.equal(prevented, true);
  sources[2].emit('destroyed');
  assert.equal(tracker.list(2)[0].state, 'interrupted');
  assert.equal(tracker.list(1)[0].state, 'progressing');
});

test('event-driven waits preserve progress and completed history across callers', async t => {
  const { tracker, control } = fixture(t);
  const item = new Item();
  tracker.start(item, 3);
  const id = tracker.list()[0].id;
  const waiting = tracker.wait(id, 1000, control, 1);
  assert.equal(control.busy, false);
  item.received = 40;
  item.emit('updated', {}, 'progressing');
  assert.equal(tracker.list()[0].received, 40);
  item.received = 100;
  item.emit('done', {}, 'completed');
  assert.equal((await waiting).state, 'completed');
  assert.equal((await tracker.wait(id, 0, control, 1)).received, 100);
  const snapshot = tracker.list();
  snapshot[0].state = 'failed';
  assert.equal(tracker.list()[0].state, 'completed');
  assert.equal(item.listenerCount('updated'), 0);
});

test('cancel exact ID, context closure, interruption and shutdown settle waits', async t => {
  const { tracker, control } = fixture(t);
  const items = Array.from({ length: 4 }, () => new Item());
  items.forEach((item, i) => tracker.start(item, i + 1));
  const ids = tracker.list().map(item => item.id);
  const waits = ids.map(id => tracker.wait(id, 1000, control, 1));
  tracker.cancel(ids[0]);
  tracker.interruptContext(2);
  items[2].emit('updated', {}, 'interrupted');
  tracker.stop();
  assert.deepEqual((await Promise.all(waits)).map(item => item.state), ['cancelled', 'interrupted', 'interrupted', 'interrupted']);
  await new Promise(setImmediate);
  assert.ok(items.every(item => item.cancelled));
  assert.ok(items.every(item => item.listenerCount('updated') === 0));
});

test('download failures and takeover-aware wait timeout do not hold mutation lane', async t => {
  const { tracker, control } = fixture(t);
  const bad = new Item();
  bad.setSavePath = () => { throw new Error('disk failure'); };
  tracker.start(bad, 1);
  assert.equal(tracker.list()[0].state, 'failed');
  const item = new Item();
  tracker.start(item, 1);
  const id = tracker.list()[1].id;
  assert.equal((await tracker.wait(id, 0, control, 1)).state, 'progressing');
  const waiting = tracker.wait(id, 1000, control, 1);
  await control.runMutation(1, async () => { control.takeHuman('keyboard'); });
  await assert.rejects(waiting, /stale|human/);
  assert.equal(tracker.list()[1].state, 'progressing');
  assert.equal(control.busy, false);
  control.resume(control.controlEpoch);
  tracker.cancel(id);
  assert.equal((await tracker.wait(id, 0, control, control.controlEpoch)).state, 'cancelled');
});

test('download history and concurrent active transfers are bounded', t => {
  const { tracker } = fixture(t);
  for (let i = 0; i < 80; i++) {
    const item = new Item();
    tracker.start(item, 1);
    item.emit('done', {}, 'completed');
  }
  assert.equal(tracker.list().length, 64);
  const active = Array.from({ length: 33 }, () => new Item());
  active.forEach(item => tracker.start(item, 2));
  assert.equal(tracker.list(2).length, 32);
  assert.equal(active[32].cancelled, true);
  assert.equal(tracker.list().length, 64);
});

test('unsafe download destination records a failed transfer without a save path', t => {
  const { root, tracker } = fixture(t);
  fs.symlinkSync(root, join(root, '.terminal-browser-downloads'));
  const item = new Item();
  tracker.start(item, 1);
  assert.equal(item.cancelled, true);
  assert.equal(tracker.list()[0].state, 'failed');
  assert.equal(tracker.list()[0].savePath, '');
});

test('private atomic history survives reconnect and restart with stable terminal IDs', async t => {
  const { root, tracker, control } = fixture(t);
  const items = Array.from({ length: 4 }, () => new Item());
  items.forEach((item, i) => tracker.start(item, i + 1));
  items[0].received = 100;
  items[0].emit('done', {}, 'completed');
  tracker.cancel(tracker.list()[1].id);
  items[2].emit('done', {}, 'failed');
  tracker.interruptContext(4);
  const before = tracker.list();
  assert.deepEqual(tracker.list(), before);
  const history = join(root, '.terminal-browser-downloads', historyName);
  assert.equal(fs.statSync(history).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(join(root, '.terminal-browser-downloads')).filter(name => name.startsWith('.history-')), []);
  tracker.stop();
  const restored = new BrowserDownloads(root, owner);
  t.after(() => restored.stop());
  assert.deepEqual(restored.list(), before);
  for (const value of before) {
    assert.deepEqual(await restored.wait(value.id, 1000, control, 1, value.contextId), value);
    assert.deepEqual(restored.cancel(value.id), value);
  }
});

test('hard restart converts persisted progressing state to interrupted and flushes throttled progress', async t => {
  const { root, tracker, control } = fixture(t);
  const item = new Item();
  tracker.start(item, 7);
  const history = join(root, '.terminal-browser-downloads', historyName);
  const id = tracker.list()[0].id;
  item.received = 40;
  item.emit('updated', {}, 'progressing');
  assert.equal(JSON.parse(fs.readFileSync(history))[0].received, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(JSON.parse(fs.readFileSync(history))[0].received, 40);
  const restored = new BrowserDownloads(root, owner);
  t.after(() => restored.stop());
  assert.equal((await restored.wait(id, 1000, control, 1)).state, 'interrupted');
  assert.equal(restored.list()[0].received, 40);
  assert.equal(restored.cancel(id).state, 'interrupted');
  assert.equal(item.cancelled, false);
  assert.equal(JSON.parse(fs.readFileSync(history))[0].state, 'interrupted');
  tracker.stop();
  assert.equal(tracker.persistTimer, undefined);
  assert.equal(item.listenerCount('updated'), 0);
});

test('restart ignores malformed fields, traversal and symlink paths without exposing metadata', t => {
  const { root, tracker } = fixture(t);
  const item = new Item();
  tracker.start(item, 1);
  item.emit('done', {}, 'completed');
  const value = tracker.list()[0];
  const history = join(root, '.terminal-browser-downloads', historyName);
  const { randomUUID } = require('node:crypto');
  const mutations = [
    { id: 'bad' }, { contextId: -1 }, { contextId: 1.5 }, { name: '../secret' },
    { name: '' }, { received: -1 }, { total: '100' }, { state: 'unknown' },
    { received: Number.MAX_SAFE_INTEGER + 1 }, { savePath: '../outside' },
    { savePath: '/etc/passwd' }, { savePath: '.terminal-browser-downloads/item-ab/../../outside' },
    { savePath: '' }, { extra: 'private data' },
  ];
  const link = join(root, '.terminal-browser-downloads', 'item-link');
  fs.symlinkSync(root, link);
  mutations.push({ savePath: `.terminal-browser-downloads/item-link/${value.name}` });
  fs.writeFileSync(history, JSON.stringify([null, [], ...mutations.map(change => ({ ...value, id: randomUUID(), ...change })), value]));
  assert.deepEqual(new BrowserDownloads(root, owner).list(), [value]);
  for (const malformed of ['{not json', '{}', 'x'.repeat(128 * 1024 + 1)]) {
    fs.writeFileSync(history, malformed);
    assert.deepEqual(new BrowserDownloads(root, owner).list(), []);
  }
  fs.unlinkSync(history);
  const outside = join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify([value]), { mode: 0o600 });
  fs.symlinkSync(outside, history);
  assert.deepEqual(new BrowserDownloads(root, owner).list(), []);
  tracker.stop();
  assert.equal(fs.readFileSync(outside, 'utf8'), JSON.stringify([value]));
});

test('restart prunes oversized history to latest 64 validated records and tolerates missing files', t => {
  const { root, tracker } = fixture(t);
  const item = new Item();
  tracker.start(item, 1);
  item.emit('done', {}, 'completed');
  const value = tracker.list()[0];
  const { randomUUID } = require('node:crypto');
  const records = Array.from({ length: 80 }, () => ({ ...value, id: randomUUID() }));
  const history = join(root, '.terminal-browser-downloads', historyName);
  fs.writeFileSync(history, JSON.stringify(records));
  const restored = new BrowserDownloads(root, owner);
  assert.deepEqual(restored.list(), records.slice(-64));
  assert.deepEqual(JSON.parse(fs.readFileSync(history)), records.slice(-64));
  for (let i = 0; i < 10; i++) {
    const next = new Item();
    restored.start(next, 2);
    next.emit('done', {}, 'completed');
  }
  restored.stop();
  assert.equal(new BrowserDownloads(root, owner).list().length, 64);
});

test('abrupt process death recovers durable start and terminal metadata without shutdown hooks', async t => {
  const { root, control } = fixture(t);
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', `
    const { EventEmitter } = require('node:events');
    const { BrowserDownloads } = require(${JSON.stringify(require.resolve('../dist/agent/downloads.js'))});
    class Item extends EventEmitter {
      getFilename() { return 'restart.txt'; }
      getReceivedBytes() { return 0; }
      getTotalBytes() { return 100; }
      setSavePath() {}
      cancel() {}
    }
    const tracker = new BrowserDownloads(process.argv[1], ${JSON.stringify(owner)});
    tracker.start(new Item(), 10);
    const completed = new Item();
    tracker.start(completed, 11);
    completed.emit('done', {}, 'completed');
    process.kill(process.pid, 'SIGKILL');
  `, root], { timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL');
  const history = join(root, '.terminal-browser-downloads', historyName);
  const persisted = JSON.parse(fs.readFileSync(history));
  assert.deepEqual(persisted.map(value => value.state), ['progressing', 'completed']);
  const recovered = new BrowserDownloads(root, owner);
  t.after(() => recovered.stop());
  assert.deepEqual(recovered.list().map(value => value.id), persisted.map(value => value.id));
  assert.equal((await recovered.wait(persisted[0].id, 1000, control, 1)).state, 'interrupted');
  assert.equal((await recovered.wait(persisted[1].id, 1000, control, 1)).state, 'completed');
});

test('same-project owners have isolated persisted IDs across every owner tuple field', async t => {
  const { root, tracker, control } = fixture(t);
  const item = new Item();
  tracker.start(item, 1);
  item.emit('done', {}, 'completed');
  const original = tracker.list()[0];
  for (const field of ['workspaceId', 'tabId', 'paneId']) {
    const otherOwner = { ...owner, [field]: 'other' };
    const other = new BrowserDownloads(root, otherOwner);
    assert.deepEqual(other.list(), []);
    assert.throws(() => other.wait(original.id, 0, control, 1), /unknown/);
    assert.throws(() => other.cancel(original.id), /unknown/);
    const otherItem = new Item();
    other.start(otherItem, 1);
    otherItem.emit('done', {}, 'completed');
    const foreign = other.list()[0];
    other.stop();
    const restoredOther = new BrowserDownloads(root, otherOwner);
    assert.deepEqual(restoredOther.list(), [foreign]);
    assert.throws(() => restoredOther.cancel(original.id), /unknown/);
    assert.throws(() => restoredOther.wait(original.id, 0, control, 1), /unknown/);
    const restored = new BrowserDownloads(root, { ...owner, sessionId: 'new-pi-session' });
    assert.deepEqual(restored.list(), [original]);
    assert.throws(() => restored.cancel(foreign.id), /unknown/);
    assert.throws(() => restored.wait(foreign.id, 0, control, 1), /unknown/);
    assert.deepEqual(await restored.wait(original.id, 0, control, 1), original);
    restored.stop();
    restoredOther.stop();
  }
  const files = fs.readdirSync(join(root, '.terminal-browser-downloads')).filter(name => name.startsWith('history-'));
  assert.equal(files.length, 4);
  assert.ok(files.every(name => /^history-[0-9a-f]{64}\.json$/.test(name)));
  const unowned = new BrowserDownloads(root, null);
  assert.deepEqual(unowned.list(), []);
  const rejected = new Item();
  unowned.start(rejected, 1);
  assert.equal(rejected.cancelled, true);
  assert.deepEqual(unowned.list(), []);
});
