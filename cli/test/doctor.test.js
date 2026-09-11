const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectPiReceipts } = require('../dist/doctor.js');

const boot = '11111111-1111-1111-1111-111111111111';
const artifactId = 'b'.repeat(64);

function receiptName(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.json`;
}

function identity(index, overrides = {}) {
  return {
    artifactId,
    sourceRevision: 'c'.repeat(40),
    build: 'a'.repeat(64),
    protocol: 2,
    pid: 1000 + index,
    processStart: `${boot}:${index + 1}`,
    instanceId: `pi-${index}`,
    ...overrides,
  };
}

function writeReceipt(directory, index, identityValue = identity(index), receiptOverrides = {}) {
  const file = receiptName(index);
  fs.writeFileSync(path.join(directory, file), `${JSON.stringify({
    identity: identityValue,
    receipt: {
      id: file.slice(0, -5),
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      sequence: index + 1,
      ...receiptOverrides,
    },
  })}\n`);
  return file;
}

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-browser-doctor-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const size of [0, 1, 128, 129]) {
  test(`doctor enumerates all ${size} Pi receipts`, () => withDirectory((directory) => {
    const starts = new Map();
    for (let index = 0; index < size; index += 1) {
      const captured = identity(index);
      writeReceipt(directory, index, captured);
      starts.set(captured.pid, captured.processStart);
    }
    const result = inspectPiReceipts(directory, artifactId, (pid) => starts.get(pid) ?? null);
    assert.equal(result.complete, true);
    assert.equal(result.total, size);
    assert.equal(result.counts.live, size);
  }));
}

test('doctor finds live evidence beyond a large history set', () => withDirectory((directory) => {
  const size = 400;
  let live;
  for (let index = 0; index < size; index += 1) {
    const captured = identity(index);
    writeReceipt(directory, index, captured);
    if (index === size - 1) live = captured;
  }
  const result = inspectPiReceipts(directory, artifactId, (pid) => pid === live.pid ? live.processStart : null, () => false);
  assert.equal(result.total, size);
  assert.deepEqual(result.counts, { live: 1, history: size - 1, invalid: 0, unreadable: 0, incomplete: 0 });
  assert.equal(result.evidence.at(-1).state, 'live');
}));

test('doctor classifies malformed, oversized, symlink, inaccessible, and incomplete receipts', (t) => withDirectory((directory) => {
  fs.writeFileSync(path.join(directory, receiptName(1)), '{bad json');
  fs.writeFileSync(path.join(directory, receiptName(2)), Buffer.alloc(16385, 32));
  const target = path.join(directory, 'target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(directory, receiptName(3)));
  const inaccessible = path.join(directory, receiptName(4));
  fs.writeFileSync(inaccessible, '{}');
  fs.chmodSync(inaccessible, 0o000);
  fs.writeFileSync(path.join(directory, receiptName(5)), '{}');
  fs.writeFileSync(path.join(directory, receiptName(6)), JSON.stringify({ identity: identity(6, { processStart: null }) }));
  fs.writeFileSync(path.join(directory, receiptName(7)), JSON.stringify({ identity: identity(7, { processStart: 'not-a-boot:7' }) }));

  const result = inspectPiReceipts(directory, artifactId, () => null);
  assert.equal(result.complete, false);
  assert.equal(result.state, 'incomplete');
  assert.equal(result.counts.invalid, 4);
  if (process.getuid?.() === 0) {
    assert.equal(result.counts.incomplete, 4);
    assert.equal(result.counts.unreadable, 0);
    t.diagnostic('root can read the mode-000 receipt, so unreadable classification is not observable');
  } else {
    assert.equal(result.counts.incomplete, 3);
    assert.equal(result.counts.unreadable, 1);
    assert.equal(result.evidence.find((entry) => entry.file === receiptName(4)).state, 'unreadable');
  }
}));

test('doctor classifies exited and reused PIDs as history', () => withDirectory((directory) => {
  const exited = identity(1);
  const reused = identity(2);
  writeReceipt(directory, 1, exited);
  writeReceipt(directory, 2, reused);
  const result = inspectPiReceipts(directory, artifactId, (pid) => pid === reused.pid ? `${boot}:9999` : null, () => false);
  assert.equal(result.counts.history, 2);
  assert.equal(result.evidence.find((entry) => entry.file === receiptName(1)).reason, 'process-exited');
  assert.equal(result.evidence.find((entry) => entry.file === receiptName(2)).reason, 'process-not-current');
}));

test('doctor keeps only the newest module reload receipt live for one process identity', () => withDirectory((directory) => {
  const oldModule = identity(1);
  const newModule = identity(1, { instanceId: 'pi-new-module', build: 'd'.repeat(64) });
  writeReceipt(directory, 1, oldModule, { sequence: 1 });
  writeReceipt(directory, 2, newModule, { sequence: 2 });
  const result = inspectPiReceipts(directory, artifactId, () => oldModule.processStart);
  assert.equal(result.counts.live, 1);
  assert.equal(result.counts.history, 1);
  assert.equal(result.evidence.find((entry) => entry.file === receiptName(1)).reason, 'superseded-reload');
  assert.equal(result.evidence.find((entry) => entry.file === receiptName(2)).state, 'live');
}));

test('doctor marks conflicting metadata-less reload receipts incomplete without guessing from filenames', () => withDirectory((directory) => {
  const oldModule = identity(1);
  const newModule = identity(1, { instanceId: 'pi-new-module', build: 'd'.repeat(64) });
  fs.writeFileSync(path.join(directory, receiptName(1)), JSON.stringify({ identity: oldModule }));
  fs.writeFileSync(path.join(directory, receiptName(2)), JSON.stringify({ identity: newModule }));
  const result = inspectPiReceipts(directory, artifactId, () => oldModule.processStart);
  assert.equal(result.complete, false);
  assert.equal(result.counts.live, 0);
  assert.equal(result.counts.incomplete, 2);
  assert.ok(result.evidence.every((entry) => entry.reason === 'ambiguous-reload-order'));
}));

test('doctor marks an unreadable live process identity incomplete instead of historical', () => withDirectory((directory) => {
  const captured = identity(1);
  writeReceipt(directory, 1, captured);
  const result = inspectPiReceipts(directory, artifactId, () => null, () => true);
  assert.equal(result.complete, false);
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.evidence[0].reason, 'process-identity-unavailable');
}));

test('doctor rejects a FIFO receipt without blocking', () => withDirectory((directory) => {
  execFileSync('mkfifo', [path.join(directory, receiptName(1))]);
  const result = inspectPiReceipts(directory, artifactId, () => null);
  assert.equal(result.total, 1);
  assert.equal(result.counts.invalid, 1);
}));

test('doctor rejects a live claim when process start identity changes during enumeration', () => withDirectory((directory) => {
  const captured = identity(1);
  writeReceipt(directory, 1, captured);
  let sample = 0;
  const result = inspectPiReceipts(directory, artifactId, () => sample++ === 0 ? captured.processStart : `${boot}:9999`);
  assert.equal(result.counts.live, 0);
  assert.equal(result.counts.history, 1);
  assert.equal(result.evidence[0].reason, 'process-identity-changed');
}));

test('an invalid-only receipt collection cannot establish complete evidence', () => withDirectory((directory) => {
  fs.writeFileSync(path.join(directory, receiptName(0)), '{');
  const result = inspectPiReceipts(directory, artifactId);
  assert.equal(result.counts.invalid, 1);
  assert.equal(result.counts.live, 0);
  assert.equal(result.complete, false);
  assert.equal(result.state, 'incomplete');
}));
