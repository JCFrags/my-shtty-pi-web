import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateBundle } from "../dist-manifest.mjs";

const root = fs.realpathSync(process.argv[2]);
const manifest = validateBundle(root);
assert.equal(manifest.identity.platform, "linux-x64", "this isolated smoke runner targets Fedora x64");
const inside = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cliCommand } from '/artifact/pi-extension/dist/launch.js';
const run = (command, args, extra = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, ...extra } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
};
assert(!fs.existsSync('/home/mainpc'));
assert(!fs.existsSync('/artifact/node_modules'));
const [command, args] = cliCommand(['help']);
assert.equal(command, '/artifact/bin/terminal-browser');
assert.match(run(command, args), /terminal-browser/);
assert.match(run('/bin/bash', ['/artifact/herdr-plugin/launch.sh', 'help']), /terminal-browser/);
assert(!fs.readFileSync('/artifact/herdr-plugin/herdr-plugin.toml', 'utf8').includes('[[build]]'));
assert.equal(run('/artifact/agent-browser/bin/agent-browser', ['--version']).trim(), 'agent-browser 0.33.0');
console.log(run('/artifact/electron/electron', ['/artifact/browser/dist/runtime-check.js', '--ozone-platform=headless', '--screen-info={8192x8192}']));
const daemon = spawn('/artifact/electron/electron', ['/artifact/browser/dist/main.js', '--daemon', '--ozone-platform=headless', '--screen-info={8192x8192}'], { stdio: ['ignore', 'ignore', 'pipe'] });
const daemonClosed = once(daemon, 'close');
let daemonError = '';
daemon.stderr.on('data', (chunk) => { daemonError = (daemonError + chunk).slice(-16000); });
try {
  const socket = '/tmp/runtime/terminal-browser-' + createHash('sha256').update('/artifact').digest('hex').slice(0, 8) + '/daemon.sock';
  for (let attempt = 0; !fs.existsSync(socket); attempt++) {
    assert(daemon.exitCode === null && daemon.signalCode === null && attempt < 200, 'daemon startup failed: ' + daemonError);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  console.log(JSON.stringify({ daemon: 'isolated startup', namespace: socket }));
} finally {
  daemon.kill('SIGTERM');
  await daemonClosed;
}
if (process.env.PI_ROOT) {
  const { loadExtensions } = await import(process.env.PI_ROOT + '/dist/core/extensions/loader.js');
  const loaded = await loadExtensions(['/artifact/pi-extension/dist/extension.js'], '/tmp');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0].tools.keys()], ['browser_open','browser_tabs','browser_observe','browser_act','browser_control']);
  console.log(JSON.stringify({ pi: JSON.parse(fs.readFileSync(process.env.PI_ROOT + '/package.json')).version, extension: 'loaded', tools: 5 }));
}
`;
const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/runtime", "--dir", "/home", "--dir", "/home/smoke", "--ro-bind", root, "/artifact", "--chdir", "/tmp", "/usr/bin/node", "--input-type=module", "-e", inside];
const result = spawnSync("bwrap", args, {
  encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  env: { PATH: "/usr/bin:/bin", HOME: "/home/smoke", XDG_DATA_HOME: "/home/smoke/data", XDG_STATE_HOME: "/home/smoke/state", XDG_CACHE_HOME: "/home/smoke/cache", XDG_CONFIG_HOME: "/home/smoke/config", XDG_RUNTIME_DIR: "/tmp/runtime", TERMINAL_BROWSER_DIST_ROOT: "/artifact", TERMINAL_BROWSER_SHM: "0", PI_WEB_SEARCH_READ_EXTENSION: "/absent", ...(process.env.TERMINAL_BROWSER_PI_ROOT ? { PI_ROOT: process.env.TERMINAL_BROWSER_PI_ROOT } : {}) },
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.ifError(result.error);
assert.equal(result.status, 0, "isolated extracted runtime smoke failed");
assert.equal(validateBundle(root).artifactId, manifest.artifactId);
console.log(`verified artifact ${manifest.artifactId}`);
