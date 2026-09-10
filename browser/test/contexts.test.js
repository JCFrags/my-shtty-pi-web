const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { BrowserDialogs } = require('../dist/agent/dialogs.js');
const { BrowserControl } = require('../dist/agent/control.js');
const { TabManager } = require('../dist/session/tabs.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let sequence = 1;
  const control = new BrowserControl();
  const target = () => {
    const contents = new EventEmitter();
    contents.debugger = new EventEmitter();
    contents.getURL = () => 'https://fixture.test/';
    return {
      contents, contentsId: sequence++,
      trackDownloads() {},
      dialogs: new BrowserDialogs(contents, async () => ({})),
      state: { url: 'https://fixture.test/', title: 'Fixture' },
      releases: 0, popup: null, devtoolsFocused: false,
      selectPopup(popup) { this.popup = popup; },
      setVisible() {}, focusContent() {}, focus() {}, targetId: async () => null,
      releaseAgentInput() { this.releases++; }, releaseAgentPointer() {}, releaseAllInput() { this.releases++; },
      stop() {}, requestClose() { this.onClosed?.(); }, close() {},
    };
  };
  const manager = new TabManager({
    createController: target,
    onActivated() {}, onActiveState() {}, onCursorChanged() {}, onDevtoolsChanged() {}, onDevtoolsAction() {}, onPageMenu() {},
    onTabsChanged() {}, requestAgentRender() {}, onTabOpened() {}, onTabClosed(id) { manager.removeClosed(id); },
    tabSwitchAllowed: () => true, agentTabSwitchAllowed: () => true, requestRender() {},
  }, 'about:blank', control);
  return { manager, control, target };
}

test('popup contexts share control, preserve opener IDs and invalidate old observations on switch and close', () => {
  const { manager, target } = fixture();
  const root = manager.create('https://fixture.test/');
  const popup = target();
  root.controller.onPopupCreated(popup, root.controller.contentsId);
  const contexts = manager.registryView();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].openerId, root.id);
  assert.equal(contexts[1].kind, 'popup');
  assert.equal(contexts[1].active, true);
  assert(root.controller.releases > 0);
  assert.equal(manager.agentActivate(root.id), true);
  assert(popup.releases > 0);
  root.controller.onPopupClosed(popup);
  assert.equal(manager.has(contexts[1].id), false);
  manager.stopAll();
});

test('context wait is event driven and does not hold mutation lane', async () => {
  const { manager, control, target } = fixture();
  const root = manager.create('https://fixture.test/');
  const pending = manager.waitContexts(root.id, 1000, 1);
  await control.runMutation(1, async () => {
    root.controller.onPopupCreated(target(), root.controller.contentsId);
  });
  assert.equal((await pending).matched, true);
  assert.equal(control.busy, false);
  manager.stopAll();
});

test('context wait cancels on takeover', async () => {
  const { manager, control } = fixture();
  manager.create('https://fixture.test/');
  const pending = manager.waitContexts(1, 1000, 1);
  control.takeHuman('keyboard');
  await assert.rejects(pending, /stale control epoch/);
  manager.stopAll();
});

test('dialog-interrupted action returns promptly and only exact response bypasses pending gate', async () => {
  const { manager, control } = fixture();
  const root = manager.create('https://fixture.test/');
  let complete;
  root.agentRuntime.click = async () => {
    root.controller.contents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    return new Promise(resolve => { complete = resolve; });
  };
  const outcome = await manager.agentClick(root.id, { ref: 'e1', observationId: 'o1', expectedControlEpoch: 1 });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.dialog.contextId, root.id);
  assert.equal(control.busy, true);
  assert(root.controller.releases > 0);
  await assert.rejects(manager.agentGetUrl(root.id, { expectedControlEpoch: 1 }), /dialog is pending/);
  await assert.rejects(manager.respondDialog(root.id, { dialogId: 'wrong', expectedControlEpoch: 1, accept: true }), /stale/);
  await manager.respondDialog(root.id, { dialogId: outcome.dialog.id, expectedControlEpoch: 1, accept: false });
  assert.equal(manager.pendingDialog, null);
  complete({ url: 'https://fixture.test/' });
  await tick();
  manager.stopAll();
});

test('release invalidates runtime observation and releases root and popup inputs', () => {
  const { manager, target } = fixture();
  const root = manager.create('https://fixture.test/');
  const popup = target();
  root.controller.onPopupCreated(popup, root.controller.contentsId);
  const before = popup.releases;
  manager.releaseAgentControl();
  assert(popup.releases > before);
  assert(root.controller.releases > 0);
  manager.stopAll();
});

test('active overlay activity follows root, popup motion, switch and popup closure', () => {
  const { manager, target } = fixture();
  assert.equal(manager.activeAgentActivity, null);
  const root = manager.create('https://fixture.test/');
  const rootActivity = { cursor: { x: 11, y: 22 }, target: null, pulse: false };
  root.agentRuntime.activityValue = rootActivity;
  assert.deepEqual(manager.activeAgentActivity, rootActivity);
  const popup = target();
  root.controller.onPopupCreated(popup, root.controller.contentsId);
  const popupId = manager.registryView().find(context => context.kind === 'popup').id;
  const runtime = manager.popups.get(popupId).agentRuntime;
  assert.equal(manager.activeAgentActivity, null);
  for (const x of [50, 75, 100]) {
    runtime.activityValue = { cursor: { x, y: 60 }, target: null, pulse: false };
    assert.deepEqual(manager.activeAgentActivity.cursor, { x, y: 60 });
    assert.notDeepEqual(manager.activeAgentActivity, root.agentRuntime.activity);
  }
  assert.equal(manager.agentActivate(root.id), true);
  assert.equal(manager.activeAgentActivity, null);
  root.agentRuntime.activityValue = rootActivity;
  assert.deepEqual(manager.activeAgentActivity, rootActivity);
  assert.equal(manager.agentActivate(popupId), true);
  assert.equal(manager.activeAgentActivity, null);
  runtime.activityValue = { cursor: { x: 150, y: 160 }, target: null, pulse: false };
  assert.deepEqual(manager.activeAgentActivity.cursor, { x: 150, y: 160 });
  root.controller.onPopupClosed(popup);
  assert.equal(manager.activeAgentActivity, null);
  root.agentRuntime.activityValue = rootActivity;
  assert.deepEqual(manager.activeAgentActivity, rootActivity);
  manager.stopAll();
});
