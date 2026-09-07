const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const { BrowserDialogs, PROMPT_SOURCE } = require('../../dist/agent/dialogs.js');
const { BrowserControl } = require('../../dist/agent/control.js');
const { PopupWindow } = require('../../dist/page/popup.js');
const { BrowserController } = require('../../dist/page/controller.js');
const { TabManager } = require('../../dist/session/tabs.js');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'terminal-browser-contexts-test-')));
app.commandLine.appendSwitch('disable-gpu');
const log = value => console.log(JSON.stringify(value));
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { const result = fn(); if (result) return result; await wait(10); }
  throw new Error('condition timed out');
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url.includes('strict')) res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'");
  if (req.url.startsWith('/manager')) {
    res.end(`<button id="ask" onclick="window.answer=prompt('manager question','default')">Ask name</button><button id="open" onclick="window.child=window.open('/child-strict','oauth')">Sign in</button><script>window.addEventListener('message',e=>window.received=e.data)</script>`);
    return;
  }
  if (req.url.startsWith('/child')) {
    res.end(`<script>window.early=prompt.name; window.answer=prompt('child first script','child default'); opener.postMessage({answer,early}, location.origin);</script><button onclick="window.close()">Close</button>`);
    return;
  }
  res.end(`<script>window.early=prompt.name;window.answer=prompt('first script','default');window.dismiss=prompt('dismiss','');window.addEventListener('message', e => {window.received=e.data});</script><button id="open" onclick="window.child=window.open('/child-strict','oauth')">Open</button>`);
});
(async () => {
  assert.equal(process.versions.electron, '43.3.0');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: false } });
  await root.loadURL('about:blank');
  root.webContents.debugger.attach('1.3');
  const send = (method, params) => root.webContents.debugger.sendCommand(method, params);
  const dialogs = new BrowserDialogs(root.webContents, send, 2000);
  const control = new BrowserControl();
  dialogs.configure(1, control);
  await dialogs.initialize();
  let count = 0;
  let automatic = true;
  dialogs.subscribe(() => {
    const dialog = dialogs.pending;
    if (!dialog || !automatic) return;
    log({ dialog });
    count++;
    setTimeout(() => dialogs.respond({ dialogId: dialog.id, expectedControlEpoch: dialog.controlEpoch, accept: dialog.message !== 'dismiss', ...(dialog.type === 'prompt' ? { text: 'custom text' } : {}) }).catch(error => log({ error: String(error) })), 80);
  });
  for (const path of ['/open', '/strict', '/strict-again']) {
    await root.loadURL(base + path);
    assert.deepEqual(await root.webContents.executeJavaScript('[early,answer,dismiss]'), ['terminalBrowserPrompt', 'custom text', null]);
  }
  assert.equal(count, 6);
  automatic = false;
  for (const [type, accept] of [['alert', false], ['confirm', false], ['confirm', true]]) {
    const result = root.webContents.executeJavaScript(`${type}('native ${type}')`, true);
    const dialog = await until(() => dialogs.pending);
    assert.equal(dialog.type, type);
    await assert.rejects(dialogs.respond({ dialogId: 'stale', expectedControlEpoch: 1, accept: true }), /stale/);
    control.takeHuman('keyboard');
    await assert.rejects(dialogs.respond({ dialogId: dialog.id, expectedControlEpoch: 1, accept: true }), /stale/);
    control.resume(control.controlEpoch);
    await dialogs.respond({ dialogId: dialog.id, expectedControlEpoch: control.controlEpoch, accept });
    assert.equal(await result, type === 'confirm' ? accept : undefined);
  }
  let popup;
  let popupCount = 0;
  root.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: false } }, createWindow: options => {
    log({ creatingPopup: true });
    const child = new BrowserWindow(options);
    popup = new PopupWindow(child, { clear() {}, present() {} }, { width: 400, height: 300 }, 1, () => 1, () => {}, () => {});
    popup.dialogs.configure(2, control);
    popup.dialogs.subscribe(() => {
      const dialog = popup.dialogs.pending;
      if (!dialog) return;
      popupCount++;
      log({ popupDialog: dialog });
      setTimeout(() => popup.dialogs.respond({ dialogId: dialog.id, expectedControlEpoch: control.controlEpoch, accept: true, text: 'oauth response' }).catch(error => log({ popupError: String(error) })), 80);
    });
    return child.webContents;
  } }));
  await root.webContents.executeJavaScript("document.getElementById('open').click()", true);
  log({ afterClick: await root.webContents.executeJavaScript('({child:!!window.child,closed:window.child?.closed})') });
  await until(() => popupCount === 1);
  await wait(150);
  assert.deepEqual(await root.webContents.executeJavaScript('received'), { answer: 'oauth response', early: 'terminalBrowserPrompt' });
  assert.equal(await popup.runJs('!!window.opener'), true);
  log({ stage: 'popup-close' });
  popup.close();
  await wait(100);
  log({ stage: 'after-close-timer', rootDestroyed: root.isDestroyed(), childDestroyed: popup.window.isDestroyed() });
  log({ rootAlive: await root.webContents.executeJavaScript('1') });
  assert.equal(await root.webContents.executeJavaScript('child.closed'), true);
  log({ stage: 'beforeunload-setup' });
  await root.webContents.executeJavaScript('window.onbeforeunload = () => false; true', true);
  dialogs.runIntent({ type: "reload", url: root.webContents.getURL() }, () => root.webContents.reload(), () => root.webContents.reload());
  const before = await until(() => dialogs.pending);
  log({ stage: 'beforeunload-dismiss', before });
  assert.equal(before.type, 'beforeunload');
  assert.equal(before.canAccept, true);
  await dialogs.respond({ dialogId: before.id, expectedControlEpoch: control.controlEpoch, accept: false });
  assert.equal(await root.webContents.executeJavaScript('typeof window.onbeforeunload'), 'function');
  dialogs.runIntent({ type: "reload", url: root.webContents.getURL() }, () => root.webContents.reload(), () => root.webContents.reload());
  const accepted = await until(() => dialogs.pending);
  log({ stage: 'beforeunload-accept', accepted });
  automatic = true;
  await dialogs.respond({ dialogId: accepted.id, expectedControlEpoch: control.controlEpoch, accept: true });
  await wait(400);
  assert.equal(await root.webContents.executeJavaScript('window.onbeforeunload'), null);
  automatic = false;
  log({ stage: 'timeout' });
  const timed = root.webContents.executeJavaScript("prompt('timeout','x')");
  await until(() => dialogs.pending);
  assert.equal(await timed, null);
  const forged = root.webContents.executeJavaScript(`const script=document.createElement('script');script.textContent=${JSON.stringify(PROMPT_SOURCE)};document.head.appendChild(script);prompt('forged','')`);
  assert.equal(await forged, null);
  assert.equal(dialogs.pending, null);
  dialogs.dispose();
  const surface = () => ({ clear() {}, close() {}, present(frame) { frame.released?.(); } });
  const managerControl = new BrowserControl();
  const manager = new TabManager({
    createController: (url, visible, onState) => new BrowserController(surface(), surface(), surface(), { x: 0, y: 0, width: 800, height: 600, scale: 1 }, url, {
      cwd: process.cwd(), background: '#222222', visible, partition: null, tabsAsPopups: false,
      clipboardRead: false, sessionKey: 'fixture', appTabId: null,
    }, onState),
    onActivated() {}, onActiveState() {}, onCursorChanged() {}, onDevtoolsChanged() {}, onDevtoolsAction() {}, onPageMenu() {},
    onTabsChanged() {}, requestAgentRender() {}, onTabOpened() {}, onTabClosed(id) { manager.removeClosed(id); },
    tabSwitchAllowed: () => true, agentTabSwitchAllowed: () => true, requestRender() {},
  }, 'about:blank', managerControl);
  const tab = manager.create(base + '/manager');
  await until(() => tab.state.url.endsWith('/manager') && !tab.state.loading);
  let observation = await manager.agentObserve(tab.id, { maxElements: 30, includeText: true, view: 'semantic', scope: 'viewport' });
  const ask = observation.snapshot.elements.find(element => element.name === 'Ask name') ?? observation.snapshot.elements.find(element => element.tag === 'button');
  assert(ask, 'ask button observed');
  const interrupted = await manager.agentClick(tab.id, { ref: ask.ref, observationId: observation.observationId, expectedControlEpoch: 1 });
  assert.equal(interrupted.completed, false);
  assert.equal(interrupted.dialog.type, 'prompt');
  assert.equal(managerControl.busy, true);
  await manager.respondDialog(tab.id, { dialogId: interrupted.dialog.id, expectedControlEpoch: 1, accept: true, text: 'manager answer' });
  await wait(100);
  assert.equal(await tab.controller.runJs('answer'), 'manager answer');
  observation = await manager.agentObserve(tab.id, { maxElements: 30, includeText: true, view: 'semantic', scope: 'viewport' });
  const open = observation.snapshot.elements.find(element => element.name === 'Sign in') ?? observation.snapshot.elements.filter(element => element.tag === 'button')[1];
  assert(open, 'sign-in button observed');
  const contextWait = manager.waitContexts(tab.id, 3000, 1);
  const opened = await manager.agentClick(tab.id, { ref: open.ref, observationId: observation.observationId, expectedControlEpoch: 1 });
  const contexts = await contextWait;
  assert(contexts.matched);
  const popupContext = contexts.tabs.find(context => context.kind === 'popup');
  assert.equal(popupContext.openerId, tab.id);
  const popupDialog = await until(() => manager.pendingDialog);
  await manager.respondDialog(popupContext.id, { dialogId: popupDialog.id, expectedControlEpoch: 1, accept: true, text: 'manager oauth' });
  await wait(100);
  assert.equal((await tab.controller.runJs('received')).answer, 'manager oauth');
  const popupObservation = await manager.agentObserve(popupContext.id, { maxElements: 30, includeText: true, view: 'semantic', scope: 'viewport' });
  assert.equal(popupObservation.contextId, popupContext.id);
  manager.close(popupContext.id);
  await until(() => !manager.has(popupContext.id));
  assert.equal(await tab.controller.runJs('child.closed'), true);
  for (const event of ['will-prevent-unload','did-start-navigation','did-stop-loading','did-navigate']) tab.controller.window.webContents.on(event, (_event, url) => log({ navigationEvent: event, url }));
  await tab.controller.runJs('window.onbeforeunload = () => false; true');
  let navigation = await manager.agentNavigate(tab.id, { url: base + '/manager-next', expectedControlEpoch: 1 }).catch(error => { log({ navigationError: String(error), pending: manager.pendingDialog }); throw error; });
  assert.equal(navigation.dialog.type, 'beforeunload');
  await manager.respondDialog(tab.id, { dialogId: navigation.dialog.id, expectedControlEpoch: 1, accept: false });
  assert.equal(tab.controller.currentUrl(), base + '/manager');
  navigation = await manager.agentNavigate(tab.id, { url: base + '/manager-next', expectedControlEpoch: 1 }).catch(error => { log({ secondNavigationError: String(error), pending: manager.pendingDialog }); throw error; });
  await manager.respondDialog(tab.id, { dialogId: navigation.dialog.id, expectedControlEpoch: 1, accept: true });
  await until(() => tab.state.url.endsWith('/manager-next') && !tab.state.loading);
  await tab.controller.runJs('window.onbeforeunload = () => false; true');
  tab.controller.back();
  const history = await until(() => manager.pendingDialog);
  assert.equal(history.intent.type, 'history');
  await manager.respondDialog(tab.id, { dialogId: history.id, expectedControlEpoch: 1, accept: false });
  tab.controller.back();
  const historyAccepted = await until(() => manager.pendingDialog);
  await manager.respondDialog(tab.id, { dialogId: historyAccepted.id, expectedControlEpoch: 1, accept: true });
  await until(() => tab.state.url.endsWith('/manager') && !tab.state.loading);
  await tab.controller.runJs('window.onbeforeunload = () => false; true');
  tab.controller.reload();
  const reload = await until(() => manager.pendingDialog);
  assert.equal(reload.intent.type, 'reload');
  await manager.respondDialog(tab.id, { dialogId: reload.id, expectedControlEpoch: 1, accept: true });
  await wait(150);
  await tab.controller.runJs('window.onbeforeunload = () => false; true');
  manager.close(tab.id);
  let closing = await until(() => manager.pendingDialog);
  assert.equal(closing.intent.type, 'close');
  await manager.respondDialog(tab.id, { dialogId: closing.id, expectedControlEpoch: 1, accept: false });
  assert(manager.has(tab.id));
  manager.close(tab.id);
  closing = await until(() => manager.pendingDialog);
  await manager.respondDialog(tab.id, { dialogId: closing.id, expectedControlEpoch: 1, accept: true });
  await until(() => !manager.has(tab.id));
  manager.stopAll();
  log({ PASS: true, count, popupCount, nativeManager: true, opened });
  root.destroy(); server.close(); app.quit();
})().catch(error => { console.error(error); server.close(); app.exit(1); });
setTimeout(() => { console.error('fixture timeout'); app.exit(2); }, 25000).unref();
