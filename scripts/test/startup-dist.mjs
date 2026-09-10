import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, repository } from "./dist-sandbox.mjs";
import { preparePiHost } from "./pi-host.mjs";
import { validateBundle } from "../dist-manifest.mjs";

const root = fs.realpathSync(process.argv[2]);
const herdr = fs.realpathSync(process.argv[3]);
const manifest = validateBundle(root);
const pi = preparePiHost();
const inside = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const env = { ...process.env, HERDR_ENV: '1', HERDR_BIN_PATH: '/herdr', HERDR_SOCKET_PATH: '/tmp/h.sock', HERDR_CONFIG_PATH: '/tmp/herdr.toml', SHELL: '/bin/bash', TERM: 'xterm-kitty' };
fs.writeFileSync('/tmp/herdr.toml', '[experimental]\\nkitty_graphics = true\\n');
fs.mkdirSync('/tmp/project');
const namespace = 'terminal-browser-' + createHash('sha256').update('/artifact').digest('hex').slice(0, 8);
const profile = process.env.TERMINAL_BROWSER_APPDATA + '/' + namespace;
const lock = profile + '/terminal-browser.lock';
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(lock, 'isolated occupied fixture', { flag: 'wx' });
const lockBefore = fs.statSync(lock);
const daemonSocket = process.env.XDG_RUNTIME_DIR + '/' + namespace + '/daemon.sock';
const server = spawn('/herdr', ['server'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverError = '';
server.stderr.on('data', chunk => { serverError = (serverError + chunk).slice(-4096); });
const run = (command, args, extra = {}, stdio) => spawnSync(command, args, { env: { ...env, ...extra }, cwd: '/tmp/project', encoding: 'utf8', timeout: 30000, maxBuffer: 65536, ...(stdio ? { stdio } : {}) });
const h = args => { const result = run('/herdr', args); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).result; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const attempts = new Set();
const samples = [];
let pty;
let ttyFd;
function report(text) {
  const value = JSON.parse(text.replace(/^terminal-browser:\\s*/u, '').trim());
  assert.equal(value.state, 'failed');
  assert.match(value.code, /^[A-Z][A-Z0-9_]+$/);
  assert.match(value.message, /profile ownership is occupied or uncertain/);
  assert.equal(typeof value.attempt, 'string');
  assert(value.attempt.length > 10);
  assert(!attempts.has(value.attempt), 'attempt reused');
  attempts.add(value.attempt);
  assert.match(value.doctorCommand, /terminal-browser.*doctor --json/);
  assert(value.cleanup && typeof value.cleanup.status === 'string');
  return value;
}
try {
  for (let n = 0; n < 60 && !fs.existsSync('/tmp/h.sock'); n++) { assert.equal(server.exitCode, null, serverError); await pause(50); }
  assert(fs.existsSync('/tmp/h.sock'), serverError);
  h(['plugin', 'link', '/artifact/herdr-plugin']);
  const workspace = h(['workspace', 'create', '--cwd', '/tmp/project', '--label', 'startup-fixture', '--no-focus']);
  const pane = workspace.root_pane;
  const second = h(['tab', 'create', '--workspace', pane.workspace_id, '--cwd', '/tmp/project', '--no-focus']);
  const untouched = second.root_pane ?? second.pane;
  assert(untouched?.pane_id, JSON.stringify(second));
  const owner = { HERDR_WORKSPACE_ID: pane.workspace_id, HERDR_TAB_ID: pane.tab_id, HERDR_PANE_ID: pane.pane_id };
  const ids = () => h(['pane', 'list']).panes.map(p => p.pane_id).sort();
  const baseline = ids();
  assert.equal(baseline.length, 2);
  const identity = h(['pane', 'get', untouched.pane_id]).pane.terminal_id;
  const check = async (label, operation, paneExpected = true) => {
    const started = Date.now();
    const result = await operation();
    const elapsed = Date.now() - started;
    const failure = report(result);
    assert(elapsed < 6000, label + ' waited for registration deadline: ' + elapsed);
    if (paneExpected) assert.equal(typeof failure.pane, 'string');
    for (let n = 0; n < 60 && ids().length !== baseline.length; n++) await pause(50);
    assert.deepEqual(ids(), baseline, label + ' left a disposable pane or changed another owner');
    assert.equal(h(['pane', 'get', untouched.pane_id]).pane.terminal_id, identity);
    assert.equal(fs.existsSync(daemonSocket), false, 'ownership refusal started daemon');
    const after = fs.statSync(lock);
    assert.equal(after.ino, lockBefore.ino);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'isolated occupied fixture');
    samples.push({ label, elapsed, response: failure, paneCount: ids().length });
  };
  const cliFailure = (args, stdio) => {
    const result = run('/artifact/bin/terminal-browser', args, owner, stdio);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout);
    return result.stderr;
  };
  pty = spawn('python3', ['/test/pty-fixture.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [line] = await once(pty.stdout, 'data');
  ttyFd = fs.openSync(JSON.parse(line)[0], 'r+');
  await check('direct-tty', () => cliFailure(['open', '--no-merge'], [ttyFd, ttyFd, 'pipe']), false);
  for (let repeat = 0; repeat < 3; repeat++) {
    await check('split-' + repeat, () => cliFailure(['open', '--no-merge', '--split', 'right']));
    await check('new-tab-' + repeat, () => cliFailure(['new-tab']));
    await check('companion-' + repeat, () => cliFailure(['companion', 'open', '--no-focus']));
  }
  Object.assign(process.env, env, owner);
  const { loadExtensions } = await import(process.env.PI_ROOT + '/dist/core/extensions/loader.js');
  const loaded = await loadExtensions(['/artifact/pi-extension/dist/extension.js'], '/tmp/project');
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get('browser_open');
  assert(tool);
  const definition = tool.definition ?? tool;
  for (let repeat = 0; repeat < 3; repeat++) {
    await check('pi-' + repeat, async () => {
      try {
        const value = await definition.execute('startup-' + repeat, { focus: false }, undefined, undefined, { cwd: '/tmp/project', sessionManager: { getSessionId: () => 'startup-fixture' } });
        assert(value.isError, 'Pi unexpectedly succeeded');
        return value.content.filter(item => item.type === 'text').map(item => item.text).join('\\n');
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        return error.message;
      }
    });
  }
  console.log(JSON.stringify({ artifactId: JSON.parse(fs.readFileSync('/artifact/build-manifest.json')).artifactId, baselinePaneCount: baseline.length, finalPaneCount: ids().length, attempts: samples }, null, 2));
} finally {
  if (ttyFd !== undefined) fs.closeSync(ttyFd);
  if (pty) pty.stdin.end();
  if (fs.existsSync('/tmp/h.sock')) run('/herdr', ['server', 'stop']);
}
`;
sandbox(inside, [pi.binding, [root, "/artifact"], [herdr, "/herdr"], [path.join(repository, "scripts/test/pty-fixture.py"), "/test/pty-fixture.py"]], { TERMINAL_BROWSER_DIST_ROOT: "/artifact", PI_ROOT: pi.root });
assert.equal(validateBundle(root).artifactId, manifest.artifactId);
