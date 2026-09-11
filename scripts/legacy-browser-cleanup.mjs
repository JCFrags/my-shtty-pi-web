#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const WORKTREES = ['wp1-m1-m2-001', 'wp1-m3-m4-001', 'wp1-m5-reader-001', 'wp1-m6-001', 'wp1-m7-001', 'wp1-m8-001', 'wp1-m9-001', 'wp1-m10-001', 'wp1-m11-001'];
const RELEASES = ['28ccde9431be4621096101174211434025556e1b', '401f4488f9303b754d02c38132ca5f45a19f6fa8', '416a3e6f005a5ea875f7f5110d1dee08b78e05db', '7f986081b4e8a03729620777248ba1484c9bc4d7', '99335f10aa6ba3c4a1a914a9582497cc247d3707', 'a4b1bb2765681e53aecf2241777593f6cee4a3fc', 'a7bb96d0c895a4897452dae2cca794166d1b4bf0'];
const SOURCES = [`${HOME}/Projects/webx`, ...WORKTREES.map(name => `${HOME}/Projects/webx-worktrees/${name}`)];
const INSTALLED = RELEASES.map(name => `${HOME}/.local/lib/pi-web-tools-releases/${name}`);
const ROOTS = [...SOURCES, ...INSTALLED];
const BROWSER_PATHS = ['apps/workspace', 'crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'target', 'packages/browserd-reference', 'packages/protocol-ts', 'packages/result-format', 'schema', 'tests/backends', 'tests/multi-agent', 'tests/observations', 'tests/workspace', 'tools/stream-viewer', 'deploy/desktop/pi-browser-workspace.desktop', 'scripts/benchmark-agent-browser.mjs', 'scripts/password-manager-spike.mjs', 'scripts/lib/agent-browser.mjs', 'scripts/lib/pinchtab.mjs'];
const OLD_BUILD_PATHS = ['components/browser/apps/workspace', 'components/browser/target', 'components/browser/packages/protocol-ts', 'components/browser/packages/result-format', 'components/browser/tests/workspace', 'apps/browserd'];
const EXTRA_PATHS = ['.local/bin/pi-browserd.pre-lifecycle-20260730-180723', '.local/bin/pi-browserd.pre-webx-complete-20260812', '.local/share/applications/pi-browser-workspace.desktop', '.local/share/icons/hicolor/scalable/apps/pi-browser-workspace.svg', '.local/share/dev.pi-web.workspace/WebKitCache', '.local/share/dev.pi-web.workspace/CacheStorage', '.local/bin/pi-web-doctor-reference'].map(relative => `${HOME}/${relative}`);
const RUNTIME_PATHS = ['.local/bin/pinchtab-bridge', '.local/share/pi-web-phase4a', '.config/pi-web-phase4a', '.local/bin/pi-webctl', '.local/bin/pi-web-workspace', '.local/share/applications/pi-web-workspace.desktop', ...['pi-web-agentcursor-browserd', 'pi-web-agentcursor-egress-proxy', 'pi-web-qualification-browserd', 'pi-web-qualification-egress-proxy', 'pi-web-qualification-webxd'].map(name => `.config/systemd/user/${name}.service`)].map(relative => `${HOME}/${relative}`);
const TAURI_PACKAGES = ['api@2.8.0', 'cli@2.8.4', 'cli-linux-x64-gnu@2.8.4', 'cli-linux-x64-musl@2.8.4'];
const DEPENDENCY_PATHS = [...ROOTS, `${HOME}/Projects/my-shtty-pi-web`].flatMap(root => TAURI_PACKAGES.flatMap(pkg => [`${root}/node_modules/.pnpm/@tauri-apps+${pkg}`, `${root}/node_modules/.pnpm/node_modules/@tauri-apps/${pkg.split('@')[0]}`]));
const ALIAS = `${HOME}/.local/bin/pi-web-doctor-reference`;
const ALIAS_TARGET = `${HOME}/.local/lib/pi-web-workspace/packages/browserd-reference/src/doctor.mjs`;
const HOOKS = ['install-fedora.sh', 'uninstall-fedora.sh', 'scripts/pi-web-stage', 'scripts/pi-web-cutover'];
const CONFIGS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/pi_web_profiles.py', 'install/profiles/full.json'];
const IMPORTERS = ['components/browser/apps/workspace', 'components/browser/packages/browserd-reference', 'components/browser/packages/protocol-ts', 'components/browser/packages/result-format'];
const MARKER = '.legacy-browser-retired.json';
const RETIRED = '#!/bin/sh\nprintf "%s\\n" "This legacy Pi Web installer is retired. Use the managed terminal-browser stack. Retained reader research is under components/browser/services/reader in this tree. Do not install or roll back from this retired tree." >&2\nexit 3\n';
const sandboxContexts = new WeakSet();
const allowedDeletes = new Set([
  ...ROOTS.flatMap(root => BROWSER_PATHS.map(relative => `${root}/components/browser/${relative}`)),
  ...ROOTS.flatMap(root => ['bin/pi-browserd', 'bin/pi-browser-workspace', '.agent-browser', 'install/profiles/browser.json'].map(relative => `${root}/${relative}`)),
  ...OLD_BUILD_PATHS.map(relative => `${HOME}/Projects/my-shtty-pi-web/${relative}`),
  ...EXTRA_PATHS, ...RUNTIME_PATHS, ...DEPENDENCY_PATHS,
]);
const allowedWrites = new Set(ROOTS.flatMap(root => [...HOOKS, ...CONFIGS].map(relative => `${root}/${relative}`)));

function fail(message) { throw new Error(message); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function exists(name) { try { fs.lstatSync(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function context(sandbox) {
  if (sandbox !== undefined && !sandboxContexts.has(sandbox)) fail('Only internally created test sandboxes are accepted');
  return { home: sandbox?.home ?? HOME, sandbox: sandbox !== undefined };
}
function actual(logical, ctx) {
  if (!logical.startsWith(`${HOME}/`) || path.normalize(logical) !== logical) fail(`Not a bounded legacy path: ${logical}`);
  return `${ctx.home}${logical.slice(HOME.length)}`;
}
function assertParents(name) {
  for (let parent = path.dirname(name); ; parent = path.dirname(parent)) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`Symbolic-link or non-directory ancestor: ${parent}`);
    if (parent === path.dirname(parent)) break;
  }
}
function statRecord(info) {
  return { device: String(info.dev), inode: String(info.ino), mode: String(info.mode), uid: String(info.uid), size: String(info.size), mtimeNs: String(info.mtimeNs) };
}
function hashFile(name) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail(`Not a regular file: ${name}`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    if (JSON.stringify(statRecord(before)) !== JSON.stringify(statRecord(fs.fstatSync(fd, { bigint: true })))) fail(`File changed while reading: ${name}`);
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function snapshot(name, excluded = new Set()) {
  assertParents(name);
  if (!exists(name)) return { entries: [], sha256: digest('[]') };
  const entries = [];
  function visit(current, relative) {
    const info = fs.lstatSync(current, { bigint: true });
    const entry = { relative, ...statRecord(info) };
    if (info.isSymbolicLink()) Object.assign(entry, { type: 'symlink', target: fs.readlinkSync(current) });
    else if (info.isFile()) Object.assign(entry, { type: 'file', sha256: hashFile(current) });
    else if (info.isDirectory()) entry.type = 'directory';
    else fail(`Unsupported filesystem entry: ${current}`);
    entries.push(entry);
    if (entry.type === 'directory') {
      for (const child of fs.readdirSync(current).sort()) {
        const next = relative ? `${relative}/${child}` : child;
        if (!excluded.has(next)) visit(path.join(current, child), next);
      }
    }
  }
  visit(name, '');
  return { entries, sha256: digest(JSON.stringify(entries)) };
}
function contentTreeHash(name) {
  const { entries } = snapshot(name, new Set([MARKER]));
  return digest(JSON.stringify(entries.map(({ relative, mode, type, target, sha256 }) => ({ relative, mode, type, target, sha256 }))));
}
function readRegular(name) {
  const info = fs.lstatSync(name);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Expected regular source file: ${name}`);
  return fs.readFileSync(name, 'utf8');
}
function gitState(root, ctx) {
  const cwd = actual(root, ctx);
  if (!exists(path.join(cwd, '.git'))) {
    if (ctx.sandbox) return null;
    fail(`Missing Git ownership: ${root}`);
  }
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, head: git(['rev-parse', 'HEAD']).trim(), status: git(['status', '--porcelain=v1', '-z']), diffSha256: digest(git(['diff', 'HEAD', '--binary'])) };
}
function requireCleanTarget(logical, ctx) {
  const root = SOURCES.find(candidate => logical.startsWith(`${candidate}/`));
  if (!root || (ctx.sandbox && !exists(path.join(actual(root, ctx), '.git')))) return;
  const result = execFileSync('git', ['diff', 'HEAD', '--name-only', '--', logical.slice(root.length + 1)], { cwd: actual(root, ctx), encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.trim()) fail(`Preserve modified source instead of cleaning it: ${logical}`);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', logical.slice(root.length + 1)], { cwd: actual(root, ctx), encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (untracked.trim()) fail(`Preserve untracked source instead of cleaning it: ${logical}`);
}
function removeImporters(text) {
  const start = text.indexOf('\nimporters:\n');
  if (start < 0) fail('Unsupported pnpm lockfile: missing importers');
  const rest = text.slice(start + 1);
  const nextSection = rest.slice('importers:\n'.length).search(/^\S[^\n]*:\s*$/m);
  const end = nextSection < 0 ? text.length : start + 1 + 'importers:\n'.length + nextSection;
  const section = text.slice(start + 1, end);
  const headers = [...section.matchAll(/^  (\S[^\n]*?):[ \t]*(?:\{\}[ \t]*)?$/gm)];
  let changed = section;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (!IMPORTERS.includes(headers[i][1])) continue;
    changed = changed.slice(0, headers[i].index) + changed.slice(i + 1 < headers.length ? headers[i + 1].index : section.length);
  }
  if (/^\s+version: link:.*(?:apps\/workspace|packages\/(?:browserd-reference|protocol-ts|result-format))\s*$/m.test(changed)) fail('Remaining importer still links to removed browser package');
  return text.slice(0, start + 1) + changed + text.slice(end);
}
function transform(relative, text) {
  if (relative === 'package.json') {
    const value = JSON.parse(text);
    for (const [name, command] of Object.entries(value.scripts ?? {})) {
      if (['check:rust', 'test:rust', 'test:live'].includes(name) || /\b(?:cargo|tauri)\b|@pi-web\/workspace/.test(command)) delete value.scripts[name];
    }
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (relative === 'pnpm-lock.yaml') return removeImporters(text);
  if (relative === 'pnpm-workspace.yaml') return text.split('\n').filter(line => line.trim() !== '- components/browser/apps/*').join('\n');
  if (relative === 'install/profiles/full.json') {
    const value = JSON.parse(text);
    if (!Array.isArray(value.includes)) fail('Invalid full profile');
    value.includes = value.includes.filter(name => name !== 'browser');
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (relative === 'scripts/pi_web_profiles.py') {
    const old = 'PROFILE_IDS = ("web-core", "documents", "render", "browser", "full")';
    if (!text.includes(old)) fail('Unexpected legacy profile declaration');
    return text.replace(old, 'PROFILE_IDS = ("web-core", "documents", "render", "full")');
  }
  fail(`Unknown source transformation: ${relative}`);
}

export function createTestSandbox() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-legacy-browser-cleanup-test-'));
  const sandbox = Object.freeze({ directory, home: `${directory}/home/fixture` });
  fs.mkdirSync(sandbox.home, { recursive: true });
  sandboxContexts.add(sandbox);
  return sandbox;
}
export function serializePlan(plan) { return `${JSON.stringify(plan, null, 2)}\n`; }
export function planSha256(plan) { return digest(serializePlan(plan)); }
export function createPlan(inventory, sandbox) {
  const ctx = context(sandbox);
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.candidateDeletions)) fail('Expected the version-1 classified cleanup inventory');
  const runtimeOnly = inventory.kind === 'phase4a-runtime';
  const dependenciesOnly = inventory.kind === 'tauri-dependencies';
  const detachedOnly = runtimeOnly || dependenciesOnly;
  const operations = [];
  const seen = new Set();
  const skippedMissing = [];
  function addRemove(logical) {
    if (!allowedDeletes.has(logical)) fail(`Deletion is outside the fixed browser inventory: ${logical}`);
    if (seen.has(logical)) fail(`Duplicate cleanup path: ${logical}`);
    seen.add(logical);
    const name = actual(logical, ctx);
    if (!exists(name)) { skippedMissing.push(logical); return; }
    if (logical === ALIAS && (!fs.lstatSync(name).isSymbolicLink() || fs.readlinkSync(name) !== ALIAS_TARGET)) fail('Reference doctor alias changed ownership');
    requireCleanTarget(logical, ctx);
    operations.push({ action: 'remove', path: logical, before: snapshot(name) });
  }
  for (const candidate of inventory.candidateDeletions) {
    if (runtimeOnly && !RUNTIME_PATHS.includes(candidate.path)) fail('Not a phase4a runtime path');
    if (dependenciesOnly && !DEPENDENCY_PATHS.includes(candidate.path)) fail('Not a pinned Tauri dependency path');
    if (!allowedDeletes.has(candidate.path)) fail(`Deletion is outside the fixed browser inventory: ${candidate.path}`);
    const name = actual(candidate.path, ctx);
    if (exists(name)) {
      assertParents(name);
      const info = fs.lstatSync(name);
      const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported';
      for (const [field, value] of [['inode', info.ino], ['device', info.dev], ['uid', info.uid], ['type', type]]) {
        if ((!ctx.sandbox || candidate[field] !== undefined) && candidate[field] !== value) fail(`Inventory ownership changed: ${candidate.path} (${field})`);
      }
      if (candidate.symlinkTarget !== undefined && candidate.symlinkTarget !== null && fs.readlinkSync(name) !== candidate.symlinkTarget) fail(`Inventory symlink changed: ${candidate.path}`);
      if (candidate.sha256 && hashFile(name) !== candidate.sha256) fail(`Inventory file changed: ${candidate.path}`);
    }
    addRemove(candidate.path);
  }
  if (!detachedOnly && !seen.has(ALIAS) && exists(actual(ALIAS, ctx))) {
    if (!fs.lstatSync(actual(ALIAS, ctx)).isSymbolicLink() || fs.readlinkSync(actual(ALIAS, ctx)) !== ALIAS_TARGET) fail('Reference doctor alias changed ownership');
    addRemove(ALIAS);
  }
  const sourceStates = [];
  const releases = [];
  for (const root of detachedOnly ? [] : ROOTS) {
    const name = actual(root, ctx);
    if (!exists(name)) continue;
    assertParents(name);
    if (!fs.lstatSync(name).isDirectory() || fs.lstatSync(name).isSymbolicLink()) fail(`Legacy root is not an owned directory: ${root}`);
    if (SOURCES.includes(root)) sourceStates.push(gitState(root, ctx));
    if (exists(path.join(name, MARKER))) fail(`Root already has a retirement record: ${root}`);
    for (const relative of [...HOOKS, ...CONFIGS]) {
      const logical = `${root}/${relative}`;
      const file = actual(logical, ctx);
      if (!exists(file)) continue;
      assertParents(file);
      const original = readRegular(file);
      const content = HOOKS.includes(relative) ? RETIRED : transform(relative, original);
      if (original === content) continue;
      requireCleanTarget(logical, ctx);
      operations.push({ action: 'write', path: logical, role: HOOKS.includes(relative) ? 'retire-hook' : 'source-config', before: snapshot(file), content, mode: fs.statSync(file).mode & 0o777 });
    }
    const profile = `${root}/install/profiles/browser.json`;
    if (!seen.has(profile) && exists(actual(profile, ctx))) addRemove(profile);
    if (INSTALLED.includes(root)) {
      const manifest = path.join(name, 'candidate-manifest.json');
      const value = JSON.parse(readRegular(manifest));
      for (const relative of ['install-fedora.sh', 'scripts/pi-web-stage', 'scripts/pi-web-cutover']) {
        if (!exists(path.join(name, relative))) fail(`Missing release activation hook: ${root}/${relative}`);
      }
      releases.push({ root, originalManifest: snapshot(manifest), originalCandidateTreeSha256: value.candidateTreeSha256 ?? null });
    }
  }
  operations.sort((a, b) => Number(b.role === 'retire-hook') - Number(a.role === 'retire-hook') || a.path.localeCompare(b.path));
  return {
    schemaVersion: 1, kind: 'bounded-pi-legacy-browser-cleanup', environment: ctx.home,
    inventorySha256: digest(JSON.stringify(inventory)), sourceStates: sourceStates.filter(Boolean), releases, operations, skippedMissing,
    preconditions: ['The parent has verified supported search/read remains on retained paths. No retained reader move or restart is required.', 'No active user service or process may reference deletion candidates or rewritten installer entrypoints. Retained reader paths under mixed roots are permitted.', 'No concurrent changes to the legacy trees during apply. Stop on a failed journal; do not replay a partially applied plan.'],
    preserved: ['Reader, document and rendering Python sources/environments', 'User storage, media keys, sessions, credentials, and all non-inventoried paths', 'Original release candidate-manifest.json bytes', 'Modified m7 extraction report', 'Shared pnpm store and global agent-browser; exclusivity is not established'],
  };
}

function validatePlan(plan, ctx) {
  if (plan.schemaVersion !== 1 || plan.kind !== 'bounded-pi-legacy-browser-cleanup' || plan.environment !== ctx.home) fail('Plan belongs to a different cleanup environment');
  const paths = new Set();
  for (const operation of plan.operations) {
    const allowed = operation.action === 'remove' ? allowedDeletes : operation.action === 'write' ? allowedWrites : new Set();
    if (!allowed.has(operation.path) || paths.has(operation.path)) fail(`Invalid or duplicate planned operation: ${operation.path}`);
    paths.add(operation.path);
    if (operation.action === 'write' && operation.role === 'retire-hook' && operation.content !== RETIRED) fail('Retirement hook must fail closed');
    for (const entry of operation.before.entries) {
      if (entry.relative !== '' && (path.isAbsolute(entry.relative) || path.normalize(entry.relative) !== entry.relative || entry.relative === '..' || entry.relative.startsWith('../'))) fail('Invalid snapshot path');
    }
  }
  for (const state of plan.sourceStates) if (!SOURCES.includes(state.root)) fail('Unknown Git root');
  for (const release of plan.releases) {
    if (!INSTALLED.includes(release.root)) fail('Unknown installed release');
    for (const relative of ['install-fedora.sh', 'scripts/pi-web-stage', 'scripts/pi-web-cutover']) {
      if (!plan.operations.some(operation => operation.path === `${release.root}/${relative}` && operation.role === 'retire-hook' && operation.content === RETIRED)) fail('Release retirement must disable every activation entrypoint');
    }
  }
}
export function activeReferenceMatches(plan, value, stableTarget) {
  const expanded = stableTarget ? value.replaceAll(`${HOME}/.local/lib/pi-web-tools/`, `${stableTarget}/`) : value;
  return plan.operations.filter(operation => operation.action === 'remove' || operation.role === 'retire-hook').some(operation => {
    for (const text of [value, expanded]) {
      let index = text.indexOf(operation.path);
      while (index !== -1) {
        const suffix = text[index + operation.path.length];
        if (suffix === undefined || suffix === "/" || /\s/.test(suffix) || "\0'\":;".includes(suffix)) return true;
        index = text.indexOf(operation.path, index + 1);
      }
    }
    return false;
  });
}
function assertDetached(ctx, plan) {
  if (ctx.sandbox) return;
  let stableTarget;
  try { stableTarget = fs.realpathSync(`${HOME}/.local/lib/pi-web-tools`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const matches = value => activeReferenceMatches(plan, value, stableTarget);
  const blockers = [];
  let units;
  try {
    units = execFileSync('systemctl', ['--user', 'list-units', '--type=service', '--state=active,activating,reloading', '--no-legend', '--plain', '--no-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of units.trim().split('\n').filter(Boolean)) {
      const unit = line.trim().split(/\s+/)[0];
      const properties = execFileSync('systemctl', ['--user', 'show', unit, '--property=ExecStart,WorkingDirectory,EnvironmentFiles,FragmentPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (matches(properties)) blockers.push(`service ${unit}`);
    }
  } catch { fail('Cannot verify active user services; complete the parent service migration first'); }
  for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const link = name => {
        try { return fs.readlinkSync(`/proc/${pid}/${name}`); }
        catch (error) {
          if (error.code !== 'EACCES') throw error;
          return execFileSync('sudo', ['-n', 'readlink', `/proc/${pid}/${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        }
      };
      const cwd = link('cwd');
      const exe = link('exe');
      if ([command, cwd, exe].some(matches)) blockers.push(`process ${pid}`);
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) fail(`Cannot verify process ${pid}`); }
  }
  if (blockers.length) fail(`Active legacy references: ${blockers.join(', ')}`);
}
function assertSnapshot(name, expected) {
  if (snapshot(name).sha256 !== expected.sha256) fail(`Stale cleanup candidate: ${name}`);
}
function writeNew(name, content, mode = 0o600) {
  assertParents(name);
  const fd = fs.openSync(name, 'wx', mode);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function replaceFile(name, content, mode) {
  assertParents(name);
  const temporary = `${name}.legacy-cleanup-${crypto.randomUUID()}`;
  try { writeNew(temporary, content, mode); fs.renameSync(temporary, name); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function removeExact(name, before, log) {
  const preparedModes = new Map();
  for (const entry of before.entries.filter(item => item.type === 'directory' && !(Number(item.mode) & 0o200))) {
    const current = entry.relative ? path.join(name, entry.relative) : name;
    assertParents(current);
    const info = fs.lstatSync(current, { bigint: true });
    if (String(info.dev) !== entry.device || String(info.ino) !== entry.inode || String(info.mode) !== entry.mode || Number(info.uid) !== process.getuid()) fail(`Directory ownership changed: ${current}`);
    const mode = Number(info.mode) | 0o200;
    fs.chmodSync(current, mode & 0o7777);
    preparedModes.set(current, String(mode));
    log({ event: 'directory-prepared', path: current, beforeMode: entry.mode, afterMode: String(mode) });
  }
  for (const entry of [...before.entries].reverse()) {
    const current = entry.relative ? path.join(name, entry.relative) : name;
    assertParents(current);
    const info = fs.lstatSync(current, { bigint: true });
    if (String(info.dev) !== entry.device || String(info.ino) !== entry.inode || String(info.mode) !== (preparedModes.get(current) ?? entry.mode)) fail(`Entry changed during cleanup: ${current}`);
    if (entry.type === 'directory') fs.rmdirSync(current);
    else {
      if (entry.type === 'symlink' && fs.readlinkSync(current) !== entry.target) fail(`Symlink changed during cleanup: ${current}`);
      if (entry.type === 'file' && (String(info.size) !== entry.size || String(info.mtimeNs) !== entry.mtimeNs)) fail(`File changed during cleanup: ${current}`);
      fs.unlinkSync(current);
    }
    log({ event: 'deleted', path: current, type: entry.type, before: entry });
  }
}
export function applyPlan(plan, approvedSha256, journalPath, sandbox) {
  const ctx = context(sandbox);
  const hash = planSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(approvedSha256) || approvedSha256 !== hash) fail('The explicit approved plan SHA-256 does not match');
  validatePlan(plan, ctx);
  const journal = path.resolve(journalPath);
  if ([...ROOTS, `${HOME}/Projects/my-shtty-pi-web`, ...EXTRA_PATHS, ...RUNTIME_PATHS].some(root => journal === actual(root, ctx) || journal.startsWith(`${actual(root, ctx)}/`))) fail('Keep the journal outside legacy trees');
  if (exists(journal)) fail('Journal already exists; a partial plan must not be replayed');
  assertDetached(ctx, plan);
  for (const state of plan.sourceStates) {
    if (JSON.stringify(gitState(state.root, ctx)) !== JSON.stringify(state)) fail(`Git state changed: ${state.root}`);
  }
  for (const operation of plan.operations) assertSnapshot(actual(operation.path, ctx), operation.before);
  for (const release of plan.releases) {
    assertSnapshot(actual(`${release.root}/candidate-manifest.json`, ctx), release.originalManifest);
    if (exists(actual(`${release.root}/${MARKER}`, ctx))) fail(`Retirement marker appeared: ${release.root}`);
  }
  assertParents(journal);
  const fd = fs.openSync(journal, 'wx', 0o600);
  const log = record => { fs.writeSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); };
  try {
    log({ event: 'started', planSha256: hash, plan });
    for (const operation of plan.operations.filter(item => item.role === 'retire-hook')) {
      const name = actual(operation.path, ctx);
      assertSnapshot(name, operation.before);
      replaceFile(name, operation.content, operation.mode);
      log({ event: 'replaced', path: name, role: operation.role, beforeSha256: operation.before.sha256, afterSha256: digest(operation.content) });
    }
    const provenance = release => ({ schemaVersion: 1, kind: 'retired-research-material-not-an-install-candidate', planSha256: hash, originalManifestSha256: release.originalManifest.entries[0].sha256, originalCandidateTreeSha256: release.originalCandidateTreeSha256, originalManifestValidity: 'Historical provenance only. Its candidate tree hash no longer describes this tree.', activationDisabled: HOOKS.filter(relative => plan.operations.some(item => item.path === `${release.root}/${relative}` && item.role === 'retire-hook')), removedPaths: plan.operations.filter(item => item.action === 'remove' && item.path.startsWith(`${release.root}/`)).map(item => item.path.slice(release.root.length + 1)), replacedPaths: plan.operations.filter(item => item.action === 'write' && item.path.startsWith(`${release.root}/`)).map(item => item.path.slice(release.root.length + 1)) });
    for (const release of plan.releases) {
      writeNew(actual(`${release.root}/${MARKER}`, ctx), `${JSON.stringify({ ...provenance(release), state: 'retirement-in-progress' }, null, 2)}\n`);
      log({ event: 'retirement-started', root: release.root });
    }
    for (const operation of plan.operations.filter(item => item.role !== 'retire-hook')) {
      const name = actual(operation.path, ctx);
      assertSnapshot(name, operation.before);
      if (operation.action === 'remove') removeExact(name, operation.before, log);
      else {
        replaceFile(name, operation.content, operation.mode);
        log({ event: 'replaced', path: name, role: operation.role, beforeSha256: operation.before.sha256, afterSha256: digest(operation.content) });
      }
    }
    for (const release of plan.releases) {
      assertSnapshot(actual(`${release.root}/candidate-manifest.json`, ctx), release.originalManifest);
      const remainingTreeSha256 = contentTreeHash(actual(release.root, ctx));
      replaceFile(actual(`${release.root}/${MARKER}`, ctx), `${JSON.stringify({ ...provenance(release), state: 'retired', remainingTreeSha256, remainingTreeHashDefinition: 'SHA-256 of ordered relative path, mode, type, symlink target and file SHA-256 records; excludes this marker; never follows links.' }, null, 2)}\n`, 0o600);
      log({ event: 'retirement-completed', root: release.root, remainingTreeSha256 });
    }
    log({ event: 'completed', planSha256: hash });
    return { planSha256: hash, journal, operations: plan.operations.length };
  } catch (error) {
    log({ event: 'failed', message: error.message, instruction: 'Inspect this journal. Do not replay the original plan or activate any partially retired release.' });
    throw error;
  } finally { fs.closeSync(fd); }
}
function main(args) {
  const command = args.shift();
  const options = {};
  while (args.length) {
    const name = args.shift();
    if (!['--inventory', '--out', '--plan', '--sha256', '--journal'].includes(name) || !args.length || options[name]) fail('Invalid or duplicate option');
    options[name] = args.shift();
  }
  if (command === 'plan' && options['--inventory'] && options['--out'] && Object.keys(options).length === 2) {
    const plan = createPlan(JSON.parse(fs.readFileSync(options['--inventory'], 'utf8')));
    writeNew(path.resolve(options['--out']), serializePlan(plan));
    console.log(JSON.stringify({ plan: path.resolve(options['--out']), sha256: planSha256(plan), operations: plan.operations.length, releases: plan.releases.length }));
  } else if (command === 'apply' && options['--plan'] && options['--sha256'] && options['--journal'] && Object.keys(options).length === 3) {
    const bytes = fs.readFileSync(options['--plan']);
    if (digest(bytes) !== options['--sha256']) fail('Approved plan file bytes changed');
    console.log(JSON.stringify(applyPlan(JSON.parse(bytes), options['--sha256'], options['--journal'])));
  } else fail('Usage: legacy-browser-cleanup.mjs plan --inventory FILE --out FILE | apply --plan FILE --sha256 APPROVED_SHA256 --journal NEW_FILE');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`legacy-browser-cleanup: ${error.message}`); process.exitCode = 1; }
}
