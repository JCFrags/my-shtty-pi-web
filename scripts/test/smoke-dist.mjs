import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, repository } from "./dist-sandbox.mjs";
import { preparePiHost } from "./pi-host.mjs";
import { validateBundle } from "../dist-manifest.mjs";

const root = fs.realpathSync(process.argv[2]);
const pi = preparePiHost();
const manifest = validateBundle(root);
assert.equal(manifest.identity.platform, "linux-x64", "this isolated smoke runner targets Fedora x64");
const inside = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cliCommand } from '/artifact/pi-extension/dist/launch.js';
const run = (command, args, extra = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, ...extra } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
};
fs.chmodSync('/tmp/runtime', 0o700);
assert(!fs.existsSync('/home/mainpc'));
assert(!fs.existsSync('/checkout'));
assert(!fs.existsSync('/test/node_modules'));
assert(!fs.existsSync('/usr/local/lib/node_modules'));
assert(!fs.existsSync('/artifact/node_modules'));
const [command, args] = cliCommand(['help']);
assert.equal(command, '/artifact/bin/terminal-browser');
assert.match(run(command, args), /terminal-browser/);
assert.match(run('/bin/bash', ['/artifact/herdr-plugin/launch.sh', 'help']), /terminal-browser/);
assert(!fs.readFileSync('/artifact/herdr-plugin/herdr-plugin.toml', 'utf8').includes('[[build]]'));
assert.equal(run('/artifact/agent-browser/bin/agent-browser', ['--version']).trim(), 'agent-browser 0.33.0');
console.log(run('/artifact/electron/electron', ['/artifact/browser/dist/runtime-check.js', '--ozone-platform=headless', '--screen-info={8192x8192}']));
await import('/test/packaged-runtime.mjs');
if (process.env.PI_ROOT) {
  const { loadExtensions } = await import(process.env.PI_ROOT + '/dist/core/extensions/loader.js');
  const loaded = await loadExtensions(['/artifact/pi-extension/dist/extension.js'], '/tmp');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0].tools.keys()], ['browser_open','browser_tabs','browser_observe','browser_act','browser_control']);
  console.log(JSON.stringify({ pi: JSON.parse(fs.readFileSync(process.env.PI_ROOT + '/package.json')).version, extension: 'loaded', tools: 5 }));
}
`;
sandbox(inside, [pi.binding, [root, "/artifact"], [path.join(repository, "scripts/test/packaged-runtime.mjs"), "/test/packaged-runtime.mjs"], [path.join(repository, "scripts/test/pty-fixture.py"), "/test/pty-fixture.py"], [path.join(repository, "browser/test/fixtures/dynamic-live.cjs"), "/test/dynamic-live.cjs"]], { TERMINAL_BROWSER_DIST_ROOT: "/artifact", PI_ROOT: pi.root });
assert.equal(validateBundle(root).artifactId, manifest.artifactId);
console.log(`verified artifact ${manifest.artifactId}`);
