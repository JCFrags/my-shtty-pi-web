import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
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

test("audit stores exact search and read evidence with secret redaction and user-only files", async () => {
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
    assert.equal(value.status, "succeeded");
    assert.equal(value.durationMs, 42);
    assert.equal(value.input.apiKey, "[redacted]");
    assert.match(value.input.url, /token=\[redacted\]/);
    assert.equal(value.structuredResult.data.untrustedContent, "complete public content");
    assert.equal(value.agentVisibleOutput.content[0].text, "agent-visible output");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audit records failures and removes records older than 90 days", async () => {
  const root = await mkdtemp(join(tmpdir(), "webx-audit-"));
  try {
    const audit = new WebAuditLog(root);
    await audit.record({ operation: "web.search", ownerId: "session", toolCallId: "call", startedAt: new Date("2026-08-24T12:00:00Z"), durationMs: 3, input: { query: "x" }, error: new Error("search failed") });
    const [path] = await records(root);
    assert(path);
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(path, old, old);
    await audit.prune(new Date("2026-08-24T12:00:00Z").getTime());
    assert.equal((await records(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
