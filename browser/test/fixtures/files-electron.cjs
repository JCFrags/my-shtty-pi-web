const { app } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserController } = require('../../dist/page/controller.js');
const { TabManager } = require('../../dist/session/tabs.js');
const { BrowserControl } = require('../../dist/agent/control.js');
const { parseAgentKey } = require('../../dist/agent/key.js');
const root = fs.mkdtempSync(join(tmpdir(), 'terminal-browser-files-electron-'));
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 600; i++) { const result = await fn(); if (result) return result; await wait(10); }
  throw new Error('condition timed out');
}
let uploadCount = 0;
const streams = new Set();
const server = http.createServer((req, res) => {
  if (req.url === '/upload') {
    let bytes = 0;
    req.on('data', data => { bytes += data.length; });
    req.on('end', () => { assert(bytes > 10); uploadCount++; res.end('ok'); });
    return;
  }
  if (req.url.startsWith('/download')) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="same.txt"');
    if (req.url.includes('slow') || req.url.includes('fail')) {
      res.setHeader('Content-Length', '1000000');
      res.write(Buffer.alloc(1000));
      if (req.url.includes('fail')) setTimeout(() => res.destroy(), 80);
      else { const timer = setInterval(() => res.write(Buffer.alloc(1000)), 100); streams.add(timer); res.on('close', () => { clearInterval(timer); streams.delete(timer); }); }
    } else res.end('download fixture');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<style>button,a,label { display: block; width: max-content; margin: 8px; }</style><label>Direct<input aria-label="Direct" id="direct" type="file"></label>
<input hidden id="hidden" type="file" multiple><button id="choose" onclick="document.getElementById('hidden').click()">Choose files</button>
<button onclick="window.answer=prompt('Workflow question','default')">Ask name</button>
<button onclick="window.child=window.open('/page','child')">Open popup</button>
<button onclick="opener.postMessage('popup returned',location.origin);window.close()">Return to opener</button>
<a href="/download">Download</a><a href="/download?slow">Slow download</a><a href="/download?fail">Failed download</a>
<script>window.addEventListener('message',event=>window.received=event.data);for(const input of [direct,hidden]) input.onchange=async()=>{if(!input.files.length)return;const form=new FormData();for(const file of input.files)form.append('file',file);await fetch('/upload',{method:'POST',body:form});window.uploaded=true;};</script>`);
});
const managers = [];
function manager(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(join(project, 'sample.txt'), 'upload fixture');
  const surface = () => ({ clear() {}, close() {}, present(frame) { frame.released?.(); } });
  const control = new BrowserControl({ onTransition: () => tabs.invalidateAgentControl() });
  const tabs = new TabManager({
    owner: { workspaceId: 'files', tabId: 'fixture', paneId: `owner-${managers.length}`, sessionId: null, projectDir: project },
    projectRoot: project,
    createController: (url, visible, onState) => new BrowserController(surface(), surface(), surface(), { x: 0, y: 0, width: 800, height: 600, scale: 1 }, url, {
      cwd: project, background: '#222222', visible, partition: null, tabsAsPopups: false,
      clipboardRead: false, sessionKey: 'files-fixture', appTabId: null,
    }, onState),
    onActivated() {}, onActiveState() {}, onCursorChanged() {}, onDevtoolsChanged() {}, onDevtoolsAction() {}, onPageMenu() {},
    onTabsChanged() {}, requestAgentRender() {}, onTabOpened() {}, onTabClosed(id) { tabs.removeClosed(id); },
    tabSwitchAllowed: () => true, agentTabSwitchAllowed: () => true, requestRender() {},
  }, 'about:blank', control);
  managers.push(tabs);
  return { tabs, control, project };
}
async function observed(manager, id, name) {
  const observation = await manager.tabs.agentObserve(id, { maxElements: 30, includeText: true, view: 'semantic', scope: 'viewport' });
  const element = observation.snapshot.elements.find(element => element.name === name);
  assert(element, `missing fixture control ${name}`);
  return { ref: element.ref, observationId: observation.observationId, expectedControlEpoch: manager.control.controlEpoch };
}
async function downloadClick(manager, id, name) {
  const before = manager.tabs.downloads.list(id).length;
  const result = await click(manager, id, name);
  assert.equal(result.completed, undefined);
  assert.ok(result.point);
  await until(() => manager.tabs.downloads.list(id).length > before);
  assert.equal(manager.tabs.downloads.list(id).length, before + 1);
  return result;
}
async function click(manager, id, name) {
  return manager.tabs.agentClick(id, await observed(manager, id, name));
}
(async () => {
  assert.equal(process.versions.electron, '43.3.0');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = manager(join(root, 'owner-a'));
  const b = manager(a.project);
  const tab = a.tabs.create(base + '/page');
  const other = b.tabs.create(base + '/page');
  await until(() => !tab.state.loading && tab.state.url === base + '/page' && !other.state.loading && other.state.url === base + '/page');
  const prompt = await click(a, tab.id, 'Ask name');
  assert.equal(prompt.completed, false);
  assert.equal(prompt.dialog.type, 'prompt');
  assert.equal(b.tabs.pendingDialog, null);
  assert.equal(b.control.busy, false);
  await a.tabs.respondDialog(tab.id, { dialogId: prompt.dialog.id, expectedControlEpoch: a.control.controlEpoch, accept: true, text: 'workflow answer' });
  await until(async () => (await tab.controller.runJs('window.answer')) === 'workflow answer');
  const contextWait = a.tabs.waitContexts(tab.id, 5000, a.control.controlEpoch);
  await click(a, tab.id, 'Open popup');
  const contexts = await contextWait;
  assert.equal(contexts.matched, true);
  const child = contexts.tabs.find(context => context.kind === 'popup');
  assert.equal(child.openerId, tab.id);
  assert.equal(b.tabs.registryView().some(context => context.kind === 'popup'), false);
  await until(async () => (await a.tabs.popups.get(child.id).controller.runJs('document.readyState')) === 'complete');
  await click(a, child.id, 'Return to opener').catch(error => {
    if (!/closed|page changed|destroyed/.test(error.message)) throw error;
  });
  await until(() => !a.tabs.has(child.id));
  await until(async () => (await tab.controller.runJs('window.received')) === 'popup returned');
  assert.equal(await tab.controller.runJs('child.closed'), true);
  assert.equal(a.tabs.activeController, tab.controller);
  assert.equal(b.tabs.activeController, other.controller);
  for (const [name, files] of [['Direct', ['sample.txt']], ['Choose files', ['sample.txt', 'sample.txt']]]) {
    const request = { ...await observed(a, tab.id, name), files };
    await a.tabs.agentUpload(tab.id, request);
    await until(() => uploadCount === (name === 'Direct' ? 1 : 2));
  }
  assert.equal(await tab.controller.runJs('direct.files.length'), 1);
  assert.equal(await tab.controller.runJs('hidden.files.length'), 2);
  await tab.controller.runJs('direct.value = ""');
  await tab.controller.runJs("window.releasedKey=false;window.addEventListener('keyup',event=>{if(event.key==='F8')window.releasedKey=true;})");
  await tab.controller.agentKeyDown(parseAgentKey('F8'));
  const takeoverUpload = { ...await observed(a, tab.id, 'Direct'), files: ['sample.txt'] };
  assert.equal(await tab.controller.runJs('window.releasedKey'), false);
  const debuggerApi = tab.controller.window.webContents.debugger;
  const sendCommand = debuggerApi.sendCommand.bind(debuggerApi);
  const chooserCommands = [];
  debuggerApi.sendCommand = (method, params) => {
    if (method === 'Page.setInterceptFileChooserDialog' || method === 'DOM.setFileInputFiles') chooserCommands.push({ method, params });
    return sendCommand(method, params);
  };
  const releaseInput = tab.controller.releaseAgentInput.bind(tab.controller);
  let inputReleases = 0;
  tab.controller.releaseAgentInput = () => { inputReleases++; releaseInput(); };
  const listenerCount = debuggerApi.listenerCount('message');
  const onChooser = (_event, method) => { if (method === 'Page.fileChooserOpened') a.control.takeHuman('keyboard'); };
  tab.controller.window.webContents.debugger.on('message', onChooser);
  await assert.rejects(a.tabs.agentUpload(tab.id, takeoverUpload), /stale|control|page changed|cancelled/);
  tab.controller.window.webContents.debugger.off('message', onChooser);
  assert.equal(await tab.controller.runJs('direct.files.length'), 0);
  assert(inputReleases > 0);
  await until(async () => (await tab.controller.runJs('window.releasedKey')) === true);
  assert.equal(a.control.busy, false);
  assert.equal(debuggerApi.listenerCount('message'), listenerCount);
  assert.deepEqual(chooserCommands.at(-1), { method: 'Page.setInterceptFileChooserDialog', params: { enabled: false } });
  assert(chooserCommands.some(command => command.method === 'DOM.setFileInputFiles' && command.params.files.length === 0));
  debuggerApi.sendCommand = sendCommand;
  tab.controller.releaseAgentInput = releaseInput;
  a.control.resume(a.control.controlEpoch);
  await assert.rejects(a.tabs.agentUpload(tab.id, takeoverUpload), /stale/);
  await a.tabs.agentUpload(tab.id, { ...await observed(a, tab.id, 'Direct'), files: ['sample.txt'] });
  await until(() => uploadCount === 3);
  await click(a, tab.id, 'Open popup');
  const popup = await until(() => a.tabs.registryView().find(context => context.kind === 'popup'));
  const popupController = a.tabs.popups.get(popup.id).controller;
  await until(async () => (await popupController.runJs('document.readyState')) === 'complete');
  await a.tabs.agentUpload(popup.id, { ...await observed(a, popup.id, 'Direct'), files: ['sample.txt'] });
  await until(() => uploadCount === 4);
  await downloadClick(a, popup.id, 'Download');
  await until(() => a.tabs.downloads.list(popup.id)[0]?.state === 'completed');
  a.tabs.close(popup.id);
  await until(() => !a.tabs.has(popup.id));
  assert.equal(a.tabs.downloads.list(popup.id)[0].state, 'completed');
  await Promise.all([downloadClick(a, tab.id, 'Download'), downloadClick(b, other.id, 'Download')]);
  await until(() => a.tabs.downloads.list(tab.id)[0]?.state === 'completed' && b.tabs.downloads.list(other.id)[0]?.state === 'completed');
  const own = a.tabs.downloads.list(tab.id)[0];
  const foreign = b.tabs.downloads.list()[0];
  assert.equal(fs.readFileSync(join(a.project, own.savePath), 'utf8'), 'download fixture');
  assert.ok(own.savePath.startsWith('.terminal-browser-downloads/'));
  assert.ok(fs.existsSync(join(b.project, foreign.savePath)));
  assert.notEqual(join(a.project, own.savePath), join(b.project, foreign.savePath));
  assert.equal(own.contextId, tab.id);
  assert.equal(foreign.contextId, other.id);
  assert.equal(a.tabs.downloads.list().some(item => item.id === foreign.id), false);
  assert.equal(b.tabs.downloads.list().some(item => item.id === own.id), false);
  assert.throws(() => a.tabs.downloads.cancel(foreign.id), /unknown/);
  assert.throws(() => b.tabs.downloads.cancel(own.id), /unknown/);
  await downloadClick(a, tab.id, 'Slow download');
  let slow = await until(() => a.tabs.downloads.list().find(item => item.state === 'progressing'));
  assert(slow);
  assert.equal(b.tabs.downloads.list().some(item => item.id === slow.id), false);
  assert.throws(() => b.tabs.downloads.cancel(slow.id), /unknown/);
  assert.equal(a.tabs.downloads.list().find(item => item.id === slow.id).state, 'progressing');
  const waiting = a.tabs.downloads.wait(slow.id, 5000, a.control, a.control.controlEpoch);
  a.tabs.downloads.cancel(slow.id);
  assert.equal((await waiting).state, 'cancelled');
  await downloadClick(a, tab.id, 'Failed download');
  await until(() => a.tabs.downloads.list().some(item => item.state === 'interrupted'));
  await downloadClick(a, tab.id, 'Slow download');
  slow = await until(() => a.tabs.downloads.list().find(item => item.state === 'progressing'));
  const takeoverWait = a.tabs.downloads.wait(slow.id, 5000, a.control, a.control.controlEpoch);
  a.control.takeHuman('keyboard');
  await assert.rejects(takeoverWait, /stale|human/);
  a.control.resume(a.control.controlEpoch);
  a.tabs.close(tab.id);
  await until(() => a.tabs.downloads.list().find(item => item.id === slow.id)?.state === 'interrupted');
  console.log(JSON.stringify({ PASS: true, nativeUploads: uploadCount, integratedWorkflow: true, takeoverRelease: true, ownerAttribution: true, popupAttribution: true, downloads: 'completed,cancelled,interrupted', electron: process.versions.electron }));
  managers.forEach(manager => manager.stopAll());
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  app.quit();
})().catch(error => { console.error(error); managers.forEach(manager => manager.stopAll()); server.close(); app.exit(1); });
setTimeout(() => { console.error('files fixture timeout'); app.exit(2); }, 45000).unref();
