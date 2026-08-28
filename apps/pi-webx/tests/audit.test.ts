import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebAuditLog } from "../src/audit.js";

async function records(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else output.push(join(path, entry.name));
    }
  }
  await walk(join(root, "events"));
  return output.filter((path) => path.endsWith(".json"));
}

test("audit stores bounded metadata only with secret redaction and user-only files", async () => {
  const root = await mkdtemp(join(tmpdir(), "webx-audit-"));
  try {
    const audit = new WebAuditLog(root);
    await audit.record({
      operation: "web.read", ownerId: "session-one", toolCallId: "call-one", startedAt: new Date("2026-08-24T12:00:00Z"), durationMs: 42.4,
      input: { url: "https://example.test/page?token=private&part=1", query: "topic", apiKey: "private" },
      result: { summary: "Read result", data: { untrustedContent: "complete public content" }, trust: "untrusted-external" },
      presentation: { content: [{ type: "text", text: "agent-visible output" }], details: { complete: true } },
    });
    const files = await records(root);
    assert.equal(files.length, 1);
    const file = files[0];
    assert(file);
    const value = JSON.parse(await readFile(file, "utf8"));
    assert.equal(value.operation, "web.read");
    assert.equal(value.version, 2);
    assert.equal(value.outcome, "succeeded");
    assert.equal(value.status, "ok");
    assert.equal(value.durationMs, 42);
    assert.equal(value.input.apiKey, "[redacted]");
    assert.match(value.input.url, /token=\[redacted\]/);
    assert.equal(value.result.trust, "untrusted-external");
    assert.doesNotMatch(JSON.stringify(value), /complete public content|agent-visible output|structuredResult|agentVisibleOutput/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("batch audit keeps source counts, IDs, and cache state but no source bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "webx-audit-"));
  try {
    const audit = new WebAuditLog(root);
    await audit.record({
      operation: "web.readBatch", ownerId: "session", toolCallId: "batch", startedAt: new Date("2026-08-24T12:00:00Z"), durationMs: 12,
      input: { items: [{ url: "https://one.test" }, { url: "https://two.test" }], body: "input body must not persist", snippet: "input snippet must not persist", payloadBase64: "c2VjcmV0" },
      result: { summary: "batch", trust: "untrusted-external", data: {
        metadata: { requested: 2, succeeded: 1, failed: 1 },
        results: [
          { index: 0, url: "https://one.test", ok: true, result: { untrustedContent: "source body must not persist", metadata: { contentId: `cnt_${"a".repeat(32)}`, delivery: { cache: "miss", coalesced: true }, reader: { returnedCharacters: 28, storedBytes: 28 } } } },
          { index: 1, url: "https://two.test", ok: false, error: { code: "read-failed", message: "body-like failure detail" } },
        ],
      } },
      presentation: { content: [{ type: "text", text: "final visible body" }], details: {} },
    });
    const [path] = await records(root);
    assert(path);
    const value = JSON.parse(await readFile(path, "utf8"));
    assert.equal(value.result.sources[0].contentId, `cnt_${"a".repeat(32)}`);
    assert.equal(value.result.sources[0].coalesced, true);
    assert.equal(value.result.sources[1].status, "read-failed");
    assert.doesNotMatch(JSON.stringify(value), /source body must not persist|body-like failure detail|final visible body|input body must not persist|input snippet must not persist|c2VjcmV0/);
    assert.equal(value.input.body, "[omitted content]");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a new metadata record preserves historical version-1 records", async () => {
  const root = await mkdtemp(join(tmpdir(), "webx-audit-"));
  try {
    const historicalDirectory = join(root, "events", "2025-01-01");
    const historicalPath = join(historicalDirectory, "historical-v1.json");
    await mkdir(historicalDirectory, { recursive: true });
    await writeFile(historicalPath, `${JSON.stringify({ version: 1, id: "historical-v1" })}\n`);
    const old = new Date("2025-01-01T00:00:00Z");
    await utimes(historicalPath, old, old);

    const audit = new WebAuditLog(root);
    await audit.record({ operation: "web.search", ownerId: "session", toolCallId: "new-call", startedAt: new Date("2026-08-24T12:00:00Z"), durationMs: 1, input: { query: "new" } });

    assert.equal(JSON.parse(await readFile(historicalPath, "utf8")).version, 1);
    assert.equal((await records(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audit records failure metadata and removes records older than 30 days", async () => {
  const root = await mkdtemp(join(tmpdir(), "webx-audit-"));
  try {
    const audit = new WebAuditLog(root);
    await audit.record({ operation: "web.search", ownerId: "session", toolCallId: "call", startedAt: new Date("2026-08-24T12:00:00Z"), durationMs: 3, input: { query: "x" }, error: new Error("search failed") });
    const [path] = await records(root);
    assert(path);
    const failure = JSON.parse(await readFile(path, "utf8"));
    assert.equal(failure.outcome, "failed");
    assert.equal(failure.errorClass, "Error");
    assert.equal(typeof failure.error.messageDigest, "string");
    assert.doesNotMatch(JSON.stringify(failure), /search failed/);
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(path, old, old);
    await audit.prune(new Date("2026-08-24T12:00:00Z").getTime());
    assert.equal((await records(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
