import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const [destination, dependencies] = process.argv.slice(2);
if (!destination || !dependencies) throw new Error('Usage: node build.mjs NEW_OUTPUT DEPENDENCY_ROOT');
const require = createRequire(join(resolve(dependencies), 'package.json'));
const esbuild = require('esbuild');
if (esbuild.version !== '0.28.2') throw new Error('esbuild 0.28.2 required');
const source = join(root, 'source');
const provenance = JSON.parse(await readFile(join(source, 'provenance.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const toolchain = JSON.parse(await readFile(join(root, 'toolchain-lock.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24' || process.env.ESBUILD_BINARY_PATH) throw new Error('The locked Linux x64 Node 24 toolchain is required');
const esbuildEntry = require.resolve('esbuild');
const binary = createRequire(esbuildEntry).resolve('@esbuild/linux-x64/bin/esbuild');
if (digest(await readFile(esbuildEntry)) !== toolchain.esbuild.entrySha256 || digest(await readFile(binary)) !== toolchain.esbuild.binarySha256) throw new Error('esbuild bytes differ from the reviewed toolchain');
async function files(path, prefix = '') {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(join(path, entry.name), name + '/'));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Source must contain only regular files');
  }
  return result.sort();
}
const expected = [...provenance.files.map(file => file.path), 'provenance.json'].sort();
if (JSON.stringify(await files(source)) !== JSON.stringify(expected)) throw new Error('Unexpected source closure');
for (const file of provenance.files) {
  if (digest(await readFile(join(source, file.path))) !== file.retainedSha256) throw new Error(`Source hash mismatch: ${file.path}`);
}
const output = resolve(destination);
await mkdir(output, { mode: 0o700 });
const entries = { 'webxd.mjs': 'apps/webxd/src/main.ts', 'extension.mjs': 'apps/pi-webx/src/index.ts', 'research-api.mjs': 'apps/webxd/src/runtime.ts', 'doctor.mjs': 'scripts/pi-web-doctor.mjs', 'audit.mjs': 'scripts/pi-web-audit.mjs' };
const manifest = { schemaVersion: 1, product: 'pi-web-research-only', sourceGitSha: provenance.gitSha, esbuild: esbuild.version, files: {}, inputs: {} };
for (const [name, entry] of Object.entries(entries)) {
  const result = await esbuild.build({ absWorkingDir: source, entryPoints: [entry], bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true, external: ['@earendil-works/pi-ai', '@earendil-works/pi-tui', '@earendil-works/pi-coding-agent', 'typebox'], legalComments: 'eof' });
  const bytes = result.outputFiles[0].contents;
  const text = Buffer.from(bytes).toString('utf8');
  if (/BrowserDaemonRpcPort|AgentCursorBrowserPort|PersistentBrowserConnection|WorkspaceGateway|NodeWorkspaceLauncher|browser_(?:open|tabs|observe|act|debug)|\/v1\/browser|node:child_process|pi-webctl|pi-browser-workspace/.test(text)) throw new Error(`Obsolete capability in ${name}`);
  for (const input of Object.keys(result.metafile.inputs)) if (!expected.includes(input)) throw new Error(`Unexpected bundle dependency: ${input}`);
  await writeFile(join(output, name), bytes, { mode: 0o600, flag: 'wx' });
  manifest.files[name] = digest(bytes);
  manifest.inputs[name] = Object.keys(result.metafile.inputs).sort();
}
for (const [from, name, mode] of [['pi-web', 'pi-web', 0o700], ['LICENSE', 'LICENSE', 0o600], ['source/provenance.json', 'provenance.json', 0o600], ['toolchain-lock.json', 'toolchain-lock.json', 0o600]]) {
  const bytes = await readFile(join(root, from));
  await writeFile(join(output, name), bytes, { mode, flag: 'wx' });
  manifest.files[name] = digest(bytes);
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, files: manifest.files }, null, 2));
