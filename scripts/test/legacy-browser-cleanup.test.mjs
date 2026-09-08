import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { activeReferenceMatches, applyPlan, createPlan, createTestSandbox, planSha256, serializePlan } from '../legacy-browser-cleanup.mjs';

const HOME = os.homedir();
const SOURCE = `${HOME}/Projects/webx`;
const RELEASE = `${HOME}/.local/lib/pi-web-tools-releases/7f986081b4e8a03729620777248ba1484c9bc4d7`;
const WORKSPACE = `${SOURCE}/components/browser/apps/workspace`;
const HOOKS = ['install-fedora.sh', 'uninstall-fedora.sh', 'scripts/pi-web-stage', 'scripts/pi-web-cutover'];
const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        version: 6.0.3

  components/browser/apps/workspace:
    dependencies:
      '@pi-web/protocol':
        version: link:../../packages/protocol-ts

  components/browser/packages/browserd-reference: {}

  components/browser/packages/protocol-ts: {}

  components/browser/packages/result-format:
    dependencies:
      '@toon-format/toon':
        version: 4.1.0

  components/browser/packages/test-fixtures: {}

  apps/webxd:
    dependencies:
      reader:
        version: 1.0.0

packages:

  reader@1.0.0:
    resolution: {integrity: sentinel}

snapshots:

  reader@1.0.0: {}
`;
function fixture(t) {
  const sandbox = createTestSandbox();
  t.after(() => fs.rmSync(sandbox.directory, { recursive: true, force: true }));
  const local = logical => `${sandbox.home}${logical.slice(HOME.length)}`;
  const write = (logical, text = 'sentinel') => {
    const name = local(logical);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, text);
    return name;
  };
  const inventory = (...paths) => ({ schemaVersion: 1, candidateDeletions: paths.map(name => ({ path: name, class: 'test-classified-browser-path' })) });
  return { sandbox, local, write, inventory, journal: `${sandbox.directory}/journal.jsonl` };
}
function addRoot(f, root) {
  for (const hook of HOOKS) f.write(`${root}/${hook}`, '#!/bin/sh\nexit 0\n');
  f.write(`${root}/package.json`, `${JSON.stringify({ name: 'pi-web', scripts: { 'check:rust': 'cargo check', 'test:live': 'browser live test', 'test:python': 'uv run pytest tests/reader', build: 'pnpm -r build' }, dependencies: { shared: '1' } }, null, 2)}\n`);
  f.write(`${root}/pnpm-lock.yaml`, lockfile);
  f.write(`${root}/pnpm-workspace.yaml`, 'packages:\n  - apps/*\n  - packages/*\n  - components/browser/apps/*\n  - components/browser/packages/*\n');
  f.write(`${root}/scripts/pi_web_profiles.py`, 'PROFILE_IDS = ("web-core", "documents", "render", "browser", "full")\n');
  f.write(`${root}/install/profiles/browser.json`, '{"id":"browser"}\n');
  f.write(`${root}/install/profiles/full.json`, '{"includes":["web-core","documents","render","browser"]}\n');
  f.write(`${root}/install/profiles/web-core.json`, '{"id":"web-core","pythonPackages":["pi-web-reader"]}\n');
}

test('plan is read-only; exact apply preserves reader, userdata, modified report and symlink targets', t => {
  const f = fixture(t);
  addRoot(f, SOURCE);
  f.write(`${WORKSPACE}/src/main.ts`, 'obsolete frontend');
  const shared = f.write(`${SOURCE}/node_modules/shared/index.js`, 'shared dependency');
  fs.symlinkSync(path.dirname(shared), f.local(`${WORKSPACE}/shared-link`));
  const sentinels = [
    `${SOURCE}/components/browser/services/reader/main.py`,
    `${SOURCE}/components/browser/.venv/reader`,
    `${SOURCE}/components/browser/uv.lock`,
    `${HOME}/Projects/webx-worktrees/wp1-m7-001/components/browser/benchmarks/extraction/reports/current-run.json`,
    `${HOME}/.local/share/dev.pi-web.workspace/storage/keep`,
    `${HOME}/.local/share/dev.pi-web.workspace/mediakeys/keep`,
    `${HOME}/.local/lib/node_modules/agent-browser/keep`,
  ];
  for (const name of sentinels) f.write(name);
  const cache = `${HOME}/.local/share/dev.pi-web.workspace/WebKitCache`;
  f.write(`${cache}/discard`, 'cache');
  const alias = `${HOME}/.local/bin/pi-web-doctor-reference`;
  fs.mkdirSync(path.dirname(f.local(alias)), { recursive: true });
  fs.symlinkSync(`${HOME}/.local/lib/pi-web-workspace/packages/browserd-reference/src/doctor.mjs`, f.local(alias));
  const plan = createPlan(f.inventory(WORKSPACE, cache), f.sandbox);
  assert.equal(fs.readFileSync(f.local(`${SOURCE}/install-fedora.sh`), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.ok(fs.existsSync(f.local(WORKSPACE)));
  assert.equal(planSha256(JSON.parse(serializePlan(plan))), planSha256(plan));
  applyPlan(plan, planSha256(plan), f.journal, f.sandbox);
  assert.equal(fs.existsSync(f.local(WORKSPACE)), false);
  assert.equal(fs.existsSync(f.local(cache)), false);
  assert.throws(() => fs.lstatSync(f.local(alias)), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared dependency');
  for (const name of sentinels) assert.equal(fs.readFileSync(f.local(name), 'utf8'), 'sentinel');
  for (const hook of HOOKS) {
    const result = spawnSync('sh', [f.local(`${SOURCE}/${hook}`), '--cutover-rollback', 'old'], { encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /retired/);
  }
  const packageJson = JSON.parse(fs.readFileSync(f.local(`${SOURCE}/package.json`), 'utf8'));
  assert.deepEqual(packageJson.scripts, { 'test:python': 'uv run pytest tests/reader', build: 'pnpm -r build' });
  assert.deepEqual(packageJson.dependencies, { shared: '1' });
  const updatedLock = fs.readFileSync(f.local(`${SOURCE}/pnpm-lock.yaml`), 'utf8');
  assert.doesNotMatch(updatedLock, /  components\/browser\/(?:apps\/workspace|packages\/(?:protocol-ts|browserd-reference|result-format)):/);
  assert.match(updatedLock, /components\/browser\/packages\/test-fixtures: \{\}/);
  assert.equal(updatedLock.slice(updatedLock.indexOf('packages:\n')), lockfile.slice(lockfile.indexOf('packages:\n')));
  assert.equal(fs.existsSync(f.local(`${SOURCE}/install/profiles/browser.json`)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.local(`${SOURCE}/install/profiles/full.json`), 'utf8')).includes, ['web-core', 'documents', 'render']);
  assert.doesNotMatch(fs.readFileSync(f.local(`${SOURCE}/scripts/pi_web_profiles.py`), 'utf8'), /"browser"/);
  const events = fs.readFileSync(f.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'completed');
  assert.ok(events.some(event => event.event === 'deleted' && event.path.endsWith('/shared-link') && event.type === 'symlink'));
  assert.throws(() => applyPlan(plan, planSha256(plan), f.journal, f.sandbox), /Journal already exists/);
});

test('partial installed release keeps original manifest and records a different remaining tree hash', t => {
  const f = fixture(t);
  addRoot(f, RELEASE);
  const manifest = '{"candidateTreeSha256":"original-immutable-digest","commit":"old"}\n';
  f.write(`${RELEASE}/candidate-manifest.json`, manifest);
  f.write(`${RELEASE}/bin/pi-browserd`, 'old executable');
  const reader = `${RELEASE}/.venv/bin/pi-web-reader`;
  f.write(reader, 'retained executable');
  f.write(`${RELEASE}/components/browser/services/reader/source.py`, 'retained source');
  const plan = createPlan(f.inventory(`${RELEASE}/bin/pi-browserd`), f.sandbox);
  assert.equal(activeReferenceMatches(plan, `${RELEASE}/.venv/bin/python\0${reader}\0${RELEASE}/components/browser`, RELEASE), false);
  assert.equal(activeReferenceMatches(plan, `${HOME}/.local/lib/pi-web-tools/.venv/bin/pi-web-reader`, RELEASE), false);
  assert.equal(activeReferenceMatches(plan, `${HOME}/.local/lib/pi-web-tools/bin/pi-browserd`, RELEASE), true);
  assert.equal(activeReferenceMatches(plan, `${RELEASE}/bin/pi-browserd-new`, RELEASE), false);
  assert.equal(activeReferenceMatches(plan, `${RELEASE}/scripts/pi-web-cutover --rollback old`, RELEASE), true);
  applyPlan(plan, planSha256(plan), f.journal, f.sandbox);
  assert.equal(fs.readFileSync(f.local(`${RELEASE}/candidate-manifest.json`), 'utf8'), manifest);
  assert.equal(fs.readFileSync(f.local(reader), 'utf8'), 'retained executable');
  const marker = JSON.parse(fs.readFileSync(f.local(`${RELEASE}/.legacy-browser-retired.json`), 'utf8'));
  assert.equal(marker.state, 'retired');
  assert.match(marker.remainingTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal(marker.originalCandidateTreeSha256, 'original-immutable-digest');
  assert.deepEqual(marker.activationDisabled, HOOKS);
  assert.equal(marker.planSha256, planSha256(plan));
  assert.throws(() => createPlan(f.inventory(), f.sandbox), /already has a retirement record/);
});

test('stale child bytes refuse the entire apply before any hook or deletion changes', t => {
  const f = fixture(t);
  addRoot(f, SOURCE);
  f.write(`${WORKSPACE}/source.ts`, 'initial bytes');
  const plan = createPlan(f.inventory(WORKSPACE), f.sandbox);
  f.write(`${WORKSPACE}/source.ts`, 'changed bytes');
  assert.throws(() => applyPlan(plan, planSha256(plan), f.journal, f.sandbox), /Stale cleanup candidate/);
  assert.equal(fs.readFileSync(f.local(`${SOURCE}/install-fedora.sh`), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(fs.existsSync(f.journal), false);
  assert.equal(fs.readFileSync(f.local(`${WORKSPACE}/source.ts`), 'utf8'), 'changed bytes');
});

test('approval hash binds plan contents and arbitrary paths cannot enter deletion closure', t => {
  const f = fixture(t);
  f.write(`${WORKSPACE}/source.ts`);
  const plan = createPlan(f.inventory(WORKSPACE), f.sandbox);
  assert.throws(() => applyPlan(plan, '0'.repeat(64), f.journal, f.sandbox), /approved plan SHA-256/);
  const originalHash = planSha256(plan);
  plan.operations[0].path = `${HOME}/.local/share/dev.pi-web.workspace/storage`;
  assert.throws(() => applyPlan(plan, originalHash, f.journal, f.sandbox), /approved plan SHA-256/);
  assert.throws(() => applyPlan(plan, planSha256(plan), f.journal, f.sandbox), /Invalid or duplicate planned operation/);
  assert.throws(() => createPlan(f.inventory(`${SOURCE}/components/browser`), f.sandbox), /outside the fixed browser inventory/);
  assert.throws(() => createPlan(f.inventory(WORKSPACE), { home: f.sandbox.home }), /internally created test sandboxes/);
  assert.equal(fs.existsSync(f.local(`${WORKSPACE}/source.ts`)), true);
});

test('symlink ancestors are rejected while candidate symlinks themselves are only unlinked', t => {
  const f = fixture(t);
  const outside = path.join(f.sandbox.directory, 'retained');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
  fs.mkdirSync(path.dirname(f.local(WORKSPACE)), { recursive: true });
  fs.symlinkSync(outside, f.local(WORKSPACE));
  const plan = createPlan(f.inventory(WORKSPACE), f.sandbox);
  applyPlan(plan, planSha256(plan), f.journal, f.sandbox);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  fs.symlinkSync(outside, f.local(WORKSPACE));
  assert.throws(() => createPlan(f.inventory(`${WORKSPACE}/../../Cargo.toml`), f.sandbox), /outside the fixed browser inventory/);
  fs.unlinkSync(f.local(WORKSPACE));
  fs.rmdirSync(path.dirname(f.local(WORKSPACE)));
  fs.symlinkSync(outside, path.dirname(f.local(WORKSPACE)));
  fs.mkdirSync(path.join(outside, 'workspace'));
  fs.writeFileSync(path.join(outside, 'workspace/keep'), 'external');
  assert.throws(() => createPlan(f.inventory(WORKSPACE), f.sandbox), /Symbolic-link or non-directory ancestor/);
  assert.equal(fs.readFileSync(path.join(outside, 'workspace/keep'), 'utf8'), 'external');
});

test('a changed alias target is not accepted as a browser-owned alias', t => {
  const f = fixture(t);
  const alias = `${HOME}/.local/bin/pi-web-doctor-reference`;
  fs.mkdirSync(path.dirname(f.local(alias)), { recursive: true });
  fs.symlinkSync('/unrelated/doctor', f.local(alias));
  assert.throws(() => createPlan(f.inventory(alias), f.sandbox), /changed ownership/);
});

test('an ancestor swapped to a symlink after planning refuses apply without touching the target', t => {
  const f = fixture(t);
  f.write(`${WORKSPACE}/source.ts`, 'initial');
  const plan = createPlan(f.inventory(WORKSPACE), f.sandbox);
  const original = f.local(`${SOURCE}/components/browser/apps`);
  const saved = `${f.sandbox.directory}/saved-apps`;
  fs.renameSync(original, saved);
  fs.symlinkSync(saved, original);
  assert.throws(() => applyPlan(plan, planSha256(plan), f.journal, f.sandbox), /Symbolic-link or non-directory ancestor/);
  assert.equal(fs.readFileSync(`${saved}/workspace/source.ts`, 'utf8'), 'initial');
  assert.equal(fs.existsSync(f.journal), false);
});

test('Git source checks preserve modified unrelated report and reject unique user files in a deletion target', t => {
  const f = fixture(t);
  f.write(`${WORKSPACE}/source.ts`, 'tracked');
  const report = `${SOURCE}/components/browser/benchmarks/extraction/reports/current-run.json`;
  f.write(report, 'original report');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.local(SOURCE), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.invalid', 'commit', '-qm', 'fixture');
  f.write(report, 'modified report');
  const plan = createPlan(f.inventory(WORKSPACE), f.sandbox);
  assert.match(plan.sourceStates[0].status, /current-run.json/);
  f.write(`${WORKSPACE}/unique-user-file.ts`, 'user work');
  assert.throws(() => createPlan(f.inventory(WORKSPACE), f.sandbox), /Preserve untracked source/);
  assert.throws(() => applyPlan(plan, planSha256(plan), f.journal, f.sandbox), /Git state changed/);
  assert.equal(fs.readFileSync(f.local(report), 'utf8'), 'modified report');
  fs.unlinkSync(f.local(`${WORKSPACE}/unique-user-file.ts`));
  const refreshed = createPlan(f.inventory(WORKSPACE), f.sandbox);
  applyPlan(refreshed, planSha256(refreshed), f.journal, f.sandbox);
  assert.equal(fs.readFileSync(f.local(report), 'utf8'), 'modified report');
});


test('inventory ownership changes are refused before a new plan is made', t => {
  const f = fixture(t);
  f.write(`${WORKSPACE}/source.ts`, 'owned');
  const inventory = f.inventory(WORKSPACE);
  inventory.candidateDeletions[0].inode = -1;
  assert.throws(() => createPlan(inventory, f.sandbox), /Inventory ownership changed/);
  assert.equal(fs.readFileSync(f.local(`${WORKSPACE}/source.ts`), 'utf8'), 'owned');
});

test('phase4a runtime removal leaves research state and the independent runtime intact', t => {
  const f = fixture(t);
  const root = `${HOME}/.local/share/pi-web-phase4a`;
  f.write(`${root}/releases/old/bin/pi-browser-workspace`, 'retired binary');
  const content = f.write(`${HOME}/.cache/pi-web-phase4a/content/item`, 'shared content');
  const runtime = f.write(`${HOME}/.local/share/pi-web-research/releases/new/webxd.mjs`, 'research');
  const inventory = { ...f.inventory(root), kind: 'phase4a-runtime' };
  const plan = createPlan(inventory, f.sandbox);
  assert.equal(plan.operations.length, 1);
  applyPlan(plan, planSha256(plan), f.journal, f.sandbox);
  assert.equal(fs.existsSync(f.local(root)), false);
  assert.equal(fs.readFileSync(content, 'utf8'), 'shared content');
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'research');
  assert.throws(() => createPlan({ ...f.inventory(WORKSPACE), kind: 'phase4a-runtime' }, f.sandbox), /Not a phase4a runtime path/);
});

test('pinned dependency removal prepares only owned read-only directories and keeps shared packages', t => {
  const f = fixture(t);
  const root = `${HOME}/Projects/my-shtty-pi-web/node_modules/.pnpm/@tauri-apps+api@2.8.0`;
  f.write(`${root}/node_modules/@tauri-apps/api/index.js`, 'retired');
  const shared = f.write(`${HOME}/Projects/my-shtty-pi-web/node_modules/.pnpm/shared/index.js`, 'keep');
  fs.chmodSync(f.local(root), 0o500);
  const plan = createPlan({ ...f.inventory(root), kind: 'tauri-dependencies' }, f.sandbox);
  applyPlan(plan, planSha256(plan), f.journal, f.sandbox);
  assert.equal(fs.existsSync(f.local(root)), false);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'keep');
  assert.match(fs.readFileSync(f.journal, 'utf8'), /directory-prepared/);
});
