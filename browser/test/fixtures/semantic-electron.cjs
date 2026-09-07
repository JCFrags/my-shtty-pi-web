const { app } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserController } = require('../../dist/page/controller.js');
const { BrowserAgentRuntime } = require('../../dist/agent/runtime.js');
const { BrowserControl } = require('../../dist/agent/control.js');
const { TerminalBrowserDriver } = require('../../dist/agent/terminal-browser-driver.js');
const { createSlowNaturalPersona } = require('../../dist/agent/interaction-profile.js');

app.setPath('userData', mkdtempSync(join(tmpdir(), 'terminal-browser-semantic-')));
app.commandLine.appendSwitch('disable-gpu');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>
body { margin: 10px; } button,input { margin: 8px; width: 150px; height: 32px; }
#nested { height: 90px; width: 300px; overflow: auto; margin-top: 15px; }
#inner { height: 240px; width: 260px; overflow: auto; } #deep { margin-top: 500px; }
</style><div id="scope"><label>Email<input id="first"></label><label>Email<input id="second"></label></div>
<button id="target" data-testid="target">Save</button><button id="delayed" disabled>Later</button>
<input id="decoy" aria-label="Decoy"><div id="shadow"></div>
<div id="nested"><div id="inner"><button id="deep">Deep action</button></div></div>
<script>
window.counts = {}; document.addEventListener('click', event => {
  const node = event.composedPath().find(node => node.tagName === 'BUTTON');
  if (node) counts[node.id] = (counts[node.id] || 0) + 1;
});
shadow.attachShadow({mode:'open'}).innerHTML = '<label>Shadow name<input id="shadowInput"></label><button id="shadowButton">Shadow action</button>';
window.ready = true;
</script>`);
});

(async () => {
  assert.equal(process.versions.electron, '43.3.0');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const surface = () => ({ clear() {}, close() {}, present(frame) { frame.released?.(); } });
  const controller = new BrowserController(surface(), surface(), surface(), { x: 0, y: 0, width: 800, height: 600, scale: 1 }, `http://127.0.0.1:${server.address().port}`, {
    cwd: tmpdir(), background: '#222222', visible: true, partition: null, tabsAsPopups: false,
    clipboardRead: false, sessionKey: 'semantic-fixture', appTabId: null,
  }, () => {});
  let runtime;
  const control = new BrowserControl({ onTransition: () => runtime?.invalidateControl() });
  const persona = createSlowNaturalPersona({ seed: 42 });
  runtime = new BrowserAgentRuntime(controller, { control, personaProvider: () => persona });
  controller.onMainFrameNavigationStart = () => runtime.invalidateDocument();
  const js = source => controller.runJs(source);
  for (let attempt = 0; ; attempt++) {
    if (await js('window.ready === true').catch(() => false)) break;
    if (attempt > 500) throw new Error('fixture load timed out');
    await wait(10);
  }
  const role = name => [{ kind: 'role', value: 'button', name }];
  const saved = [{ kind: 'testid', value: 'target' }];
  async function request(extra = {}) {
    const observation = await runtime.observe();
    return { observationId: observation.observationId, expectedControlEpoch: control.controlEpoch, ...extra };
  }
  const filtered = await runtime.observe({ filter: [{ kind: 'label', value: 'Email' }] });
  assert.equal(filtered.snapshot.elements.length, 2);
  const resolver = new TerminalBrowserDriver(controller, runtime.observer);
  const native = await resolver.resolveLocator(role('Save'), { timeoutMs: 0 });
  assert.equal(native.count, 1);
  assert.match(native.handle, /^e\d+$/);
  assert(native.rect.width > 0);
  assert.equal((await resolver.resolveLocator(role('Missing'), { timeoutMs: 0 })).count, 0);
  await assert.rejects(runtime.type(await request({ locator: [{ kind: 'label', value: 'Email' }], text: 'wrong', replace: true })), /ambiguous locator/);
  assert.deepEqual(await js('[first.value,second.value]'), ['', '']);
  await runtime.type(await request({ locator: [{ kind: 'css', value: '#scope' }, { kind: 'label', value: 'Email' }, { kind: 'nth', index: 1 }], text: 'selected', replace: true }));
  assert.deepEqual(await js('[first.value,second.value]'), ['', 'selected']);
  await js('setTimeout(() => delayed.disabled = false, 180)');
  await runtime.click(await request({ locator: role('Later') }));
  assert.equal(await js('counts.delayed'), 1);
  await runtime.type(await request({ locator: [{ kind: 'label', value: 'Shadow name' }], text: 'inside', replace: true }));
  assert.equal(await js("shadow.shadowRoot.querySelector('input').value"), 'inside');
  await runtime.click(await request({ locator: role('Shadow action') }));
  assert.equal(await js('counts.shadowButton'), 1);
  await runtime.click(await request({ locator: role('Deep action') }));
  assert.equal(await js('counts.deep'), 1);
  assert(await js('nested.scrollTop > 0 || inner.scrollTop > 0'));
  await js('document.addEventListener("mousemove", () => { target.outerHTML = target.outerHTML; }, {once:true})');
  const replaced = await runtime.click(await request({ locator: saved }));
  assert.equal(replaced.ref, (await runtime.observer.queryLocator(saved)).matches[0].ref);
  assert.equal(await js('counts.target'), 1);
  const stale = await request({ ref: (await runtime.observer.queryLocator(saved)).matches[0].ref });
  await js('document.addEventListener("mousemove", () => { target.outerHTML = target.outerHTML; }, {once:true})');
  await assert.rejects(runtime.click(stale), /stale or unknown ref/);
  assert.equal(await js('counts.target'), 1);
  await js('document.addEventListener("mousemove", () => { target.style.transform = "translateX(180px)"; }, {once:true})');
  await runtime.click(await request({ locator: saved }));
  assert.equal(await js('counts.target'), 2);
  await js(`document.addEventListener('mousemove', () => {
    const overlay = document.createElement('div'); overlay.id = 'cover';
    overlay.style = 'position:fixed;inset:0;background:white;z-index:99999'; document.body.append(overlay);
  }, {once:true})`);
  await assert.rejects(runtime.click(await request({ locator: saved })), /obstructed|timed out/);
  assert.equal(await js('counts.target'), 2);
  await js('cover.remove()');
  await js('first.addEventListener("click", () => decoy.focus(), {once:true})');
  await assert.rejects(runtime.type(await request({ locator: [{ kind: 'css', value: '#first' }], text: 'must not insert', replace: true })), /focus changed/);
  assert.equal(await js('decoy.value'), '');
  await js('delayed.disabled = true');
  const abort = new AbortController();
  const cancelled = runtime.click(await request({ locator: role('Later'), signal: abort.signal }));
  setTimeout(() => abort.abort(new Error('fixture cancellation')), 100);
  await assert.rejects(cancelled, /fixture cancellation/);
  await js('delayed.disabled = false');
  await wait(200);
  assert.equal(await js('counts.delayed'), 1);
  const takeover = runtime.click(await request({ locator: saved }));
  setTimeout(() => control.takeHuman('keyboard'), 100);
  await assert.rejects(takeover, /stale control epoch|human|page changed/);
  assert.equal(await js('counts.target'), 2);
  control.resume(control.controlEpoch);
  const actionable = await runtime.waitFor(await request({ locator: saved, condition: 'actionable', timeoutMs: 1000 }));
  assert.equal(actionable.matched, true);
  await runtime.click(await request({ locator: saved }));
  assert.equal(await js('counts.target'), 3);
  await js(`for (const [id,left] of [['dragSource',20],['dragDestination',300]]) {
    const node = document.createElement('div'); node.id = id; node.textContent = id;
    node.style = 'position:fixed;bottom:10px;width:100px;height:30px;background:white;z-index:100;left:' + left + 'px';
    document.body.append(node);
  }
  window.dragEvents = [];
  document.addEventListener('mousedown', event => dragEvents.push(['down',event.target.id]));
  document.addEventListener('mouseup', event => dragEvents.push(['up',event.target.id]));
  document.addEventListener('mousemove', () => { dragSource.style.left = '80px'; }, {once:true});`);
  await runtime.drag(await request({ from: { locator: [{ kind: 'css', value: '#dragSource' }] },
    to: { locator: [{ kind: 'css', value: '#dragDestination' }] }, button: 'left' }));
  assert.deepEqual(await js('dragEvents'), [['down','dragSource'],['up','dragDestination']]);
  await js('dragSource.remove();dragDestination.remove()');
  await js('const many = document.createElement("div"); many.innerHTML = "<button>other</button>".repeat(210); document.body.prepend(many)');
  const capped = await runtime.observe();
  assert.equal(capped.snapshot.elements.length, 200);
  assert.equal(capped.snapshot.elements.some(element => element.name === 'Save'), false);
  await runtime.click({ locator: saved, observationId: capped.observationId, expectedControlEpoch: control.controlEpoch });
  assert.equal(await js('counts.target'), 4);
  await js('setTimeout(() => { const button = document.createElement("button"); button.id = "late"; button.textContent = "Attached later"; document.body.append(button); }, 150)');
  await runtime.click(await request({ locator: role('Attached later') }));
  assert.equal(await js('counts.late'), 1);
  controller.stop();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ semantic: 'passed', electron: process.versions.electron, duplicateSideEffects: false }));
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
