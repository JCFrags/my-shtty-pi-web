import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, chmod, link, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualificationDiagnosticsError, QualificationDiagnosticsReader } from "./phase4a-qualification-diagnostics.mjs";

function record(index, extra = {}) {
  return { kind: "milestone", recordedAt: `2026-09-02T00:00:${String(index).padStart(2, "0")}.000Z`, index, ...extra };
}
async function temporaryJournal() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-diagnostics-test-"));
  const path = join(root, "tauri.jsonl");
  return { root, path };
}
async function closeJournal(root) {
  await rm(root, { recursive: true, force: true });
}
async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof QualificationDiagnosticsError && error.code === code);
}

 test("diagnostics reader incrementally handles partial UTF-8 lines and appends", async () => {
  const { root, path } = await temporaryJournal();
  try {
    const first = Buffer.from(`${JSON.stringify(record(1, { message: "π雪" }))}\n`, "utf8");
    const split = first.indexOf(Buffer.from("π", "utf8")) + 1;
    await writeFile(path, first.subarray(0, split), { mode: 0o600 });
    const reader = new QualificationDiagnosticsReader(path);
    assert.deepEqual(await reader.records(), []);
    await appendFile(path, first.subarray(split));
    assert.deepEqual(await reader.records(), [record(1, { message: "π雪" })]);
    await appendFile(path, `${JSON.stringify(record(2))}\n`);
    assert.deepEqual(await reader.records(), [record(1, { message: "π雪" }), record(2)]);
    assert.equal(await reader.index(), 2);
    assert.deepEqual(await reader.find((value) => value.index === 2, 1), record(2));
  } finally {
    await closeJournal(root);
  }
});

test("diagnostics reader bounds the ring and expires old cursors", async () => {
  const { root, path } = await temporaryJournal();
  try {
    await writeFile(path, `${[1, 2, 3, 4].map((index) => JSON.stringify(record(index))).join("\n")}\n`, { mode: 0o600 });
    const reader = new QualificationDiagnosticsReader(path, { maxRecords: 10, maxRing: 3 });
    assert.deepEqual(await reader.records(), [record(2), record(3), record(4)]);
    assert.equal(await reader.index(), 4);
    await expectCode(reader.find(() => false, 0), "cursor-expired");
    assert.equal((await reader.find((value) => value.index === 4, 2)).index, 4);

    const bounded = new QualificationDiagnosticsReader(path, { maxRecords: 3, maxRing: 3 });
    await expectCode(bounded.records(), "unsafe");
  } finally {
    await closeJournal(root);
  }
});

test("diagnostics reader rejects replacement, truncation, permissions, links, and malformed records", async () => {
  const { root, path } = await temporaryJournal();
  try {
    await writeFile(path, `${JSON.stringify(record(1))}\n`, { mode: 0o600 });
    const replacementReader = new QualificationDiagnosticsReader(path);
    await replacementReader.records();
    await rename(path, `${path}.old`);
    await writeFile(path, `${JSON.stringify(record(2))}\n`, { mode: 0o600 });
    await expectCode(replacementReader.records(), "replaced");

    const truncationPath = join(root, "truncated.jsonl");
    await writeFile(truncationPath, `${JSON.stringify(record(3))}\n`, { mode: 0o600 });
    const truncationReader = new QualificationDiagnosticsReader(truncationPath);
    await truncationReader.records();
    await truncate(truncationPath, 0);
    await expectCode(truncationReader.records(), "truncated");

    const permissionPath = join(root, "permission.jsonl");
    await writeFile(permissionPath, `${JSON.stringify(record(4))}\n`, { mode: 0o600 });
    await chmod(permissionPath, 0o644);
    await expectCode(new QualificationDiagnosticsReader(permissionPath).records(), "unsafe");

    const targetPath = join(root, "target.jsonl");
    const linkPath = join(root, "link.jsonl");
    await writeFile(targetPath, `${JSON.stringify(record(5))}\n`, { mode: 0o600 });
    await symlink(targetPath, linkPath);
    await expectCode(new QualificationDiagnosticsReader(linkPath).records(), "unsafe");

    const hardLinkPath = join(root, "hard-link.jsonl");
    await writeFile(hardLinkPath, `${JSON.stringify(record(6))}\n`, { mode: 0o600 });
    await link(hardLinkPath, join(root, "hard-link-copy.jsonl"));
    await expectCode(new QualificationDiagnosticsReader(hardLinkPath).records(), "unsafe");

    const malformedPath = join(root, "malformed.jsonl");
    await writeFile(malformedPath, "{not-json}\n", { mode: 0o600 });
    await expectCode(new QualificationDiagnosticsReader(malformedPath).records(), "invalid");
    await writeFile(malformedPath, `${JSON.stringify({ kind: "not-allowed", recordedAt: "now" })}\n`, { mode: 0o600 });
    await expectCode(new QualificationDiagnosticsReader(malformedPath).records(), "invalid");
    await writeFile(malformedPath, Buffer.from([0xff, 0xfe, 0x0a]), { mode: 0o600 });
    await expectCode(new QualificationDiagnosticsReader(malformedPath).records(), "invalid");
  } finally {
    await closeJournal(root);
  }
});

test("diagnostics reader enforces constructor, line, and file bounds", async () => {
  const { root, path } = await temporaryJournal();
  try {
    for (const options of [{ maxBytes: 0 }, { maxRecords: 0 }, { maxRing: 0 }, { maxLineBytes: 0 }, { maxBytes: 2, maxLineBytes: 3 }, { kinds: ["milestone"] }, { kinds: new Set() }]) {
      assert.throws(() => new QualificationDiagnosticsReader("relative.jsonl", options), (error) => error instanceof QualificationDiagnosticsError && error.code === "unsafe");
    }
    await writeFile(path, "x".repeat(33), { mode: 0o600 });
    await expectCode(new QualificationDiagnosticsReader(path, { maxLineBytes: 32 }).records(), "unsafe");
    const oversized = join(root, "oversized.jsonl");
    await writeFile(oversized, `${JSON.stringify(record(7))}\n`, { mode: 0o600 });
    await expectCode(new QualificationDiagnosticsReader(oversized, { maxBytes: 1, maxLineBytes: 1 }).records(), "unsafe");
  } finally {
    await closeJournal(root);
  }
});
