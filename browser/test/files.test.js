const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { validateUploadFiles, reserveDownloadPath, UPLOAD_LIMITS } = require('../dist/agent/files.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'browser-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'project', 'normal.txt'), 'fixture');
  return { root, project: path.join(root, 'project') };
}

test('uploads canonicalize existing regular project files, including safe symlinks', t => {
  const { project } = fixture(t);
  fs.symlinkSync('normal.txt', path.join(project, 'alias'));
  assert.deepEqual(validateUploadFiles(project, ['normal.txt', 'alias']), [path.join(project, 'normal.txt'), path.join(project, 'normal.txt')]);
});

test('uploads reject traversal, symlink escapes, directories, missing and special files', t => {
  const { root, project } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside'), 'fixture');
  fs.symlinkSync('../outside', path.join(project, 'escape'));
  fs.mkdirSync(path.join(project, 'directory'));
  execFileSync('mkfifo', [path.join(project, 'pipe')]);
  for (const file of ['../outside', path.join(root, 'outside'), 'escape', 'directory', 'missing', 'pipe', '\0bad']) {
    assert.throws(() => validateUploadFiles(project, [file]), /upload/);
  }
  assert.throws(() => validateUploadFiles(null, ['normal.txt']), /owning/);
});

test('uploads reject secret path components and aliases to them', t => {
  const { project } = fixture(t);
  for (const file of ['.env', '.env.local', 'credentials.json', 'id_ed25519', 'private.pem', 'vault.kdbx']) {
    fs.writeFileSync(path.join(project, file), 'fixture');
    assert.throws(() => validateUploadFiles(project, [file]), /secret/);
  }
  fs.mkdirSync(path.join(project, 'secrets'));
  fs.writeFileSync(path.join(project, 'secrets', 'data.txt'), 'fixture');
  fs.symlinkSync('secrets/data.txt', path.join(project, 'alias'));
  assert.throws(() => validateUploadFiles(project, ['alias']), /secret/);
  assert.throws(() => validateUploadFiles(project, ['secrets/data.txt']), /secret/);
});

test('uploads enforce count, per-file and aggregate sizes without reading contents', t => {
  const { project } = fixture(t);
  for (const files of [[], Array(17).fill('normal.txt'), [1]]) assert.throws(() => validateUploadFiles(project, files), /upload/);
  const fd = fs.openSync(path.join(project, 'large'), 'w');
  fs.ftruncateSync(fd, UPLOAD_LIMITS.fileBytes + 1);
  fs.closeSync(fd);
  assert.throws(() => validateUploadFiles(project, ['large']), /size/);
  fs.truncateSync(path.join(project, 'large'), 24 * 1024 * 1024);
  assert.throws(() => validateUploadFiles(project, ['large', 'large', 'large']), /size/);
  assert.equal(validateUploadFiles(project, ['large', 'large']).length, 2);
});

test('download filenames cannot traverse and concurrent identical names never overwrite', t => {
  const { project } = fixture(t);
  const first = reserveDownloadPath(project, '../../same.txt');
  const second = reserveDownloadPath(project, '..\\same.txt');
  assert.notEqual(first, second);
  assert.equal(path.basename(first), 'same.txt');
  assert.ok(first.startsWith(path.join(project, '.terminal-browser-downloads') + path.sep));
  fs.writeFileSync(first, 'kept');
  assert.equal(fs.readFileSync(first, 'utf8'), 'kept');
  assert.equal(reserveDownloadPath(project, '..').endsWith('/download'), true);
});

test('download directory cannot be a symlink', t => {
  const { root, project } = fixture(t);
  fs.symlinkSync(root, path.join(project, '.terminal-browser-downloads'));
  assert.throws(() => reserveDownloadPath(project, 'name'), /unsafe/);
});

test('captured owner root cannot be replaced by a symlink to another project', t => {
  const { root, project } = fixture(t);
  fs.renameSync(project, path.join(root, 'original'));
  fs.mkdirSync(path.join(root, 'other'));
  fs.symlinkSync(path.join(root, 'other'), project);
  assert.throws(() => validateUploadFiles(project, ['normal.txt']), /root changed.*reopen/);
  assert.throws(() => reserveDownloadPath(project, 'file.txt'), /root changed.*reopen/);
});
