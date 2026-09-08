#!/usr/bin/env node
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_POLICY } from "../packages/policy/storage.mjs";

const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state");
const root = process.env.PI_WEB_AUDIT_DIR ?? join(state, "pi-web", "audit");
const events = join(root, "events");
const command = process.argv[2] ?? "list";

async function files(path = events) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return []; }
  const output = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await files(child));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      const info = await stat(child);
      output.push({ path: child, size: info.size, mtimeMs: info.mtimeMs, id: entry.name.slice(0, -5) });
    }
  }
  return output;
}

async function readRecord(file) {
  return JSON.parse(await readFile(file.path, "utf8"));
}

if (command === "path") {
  console.log(root);
} else if (command === "list") {
  const limitFlag = process.argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number.parseInt(process.argv[limitFlag + 1] ?? "50", 10) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("--limit must be between 1 and 10000");
  const found = (await files()).sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
  const rows = [];
  for (const file of found) {
    const record = await readRecord(file);
    rows.push({ id: record.id, timestamp: record.timestamp, operation: record.operation, status: record.status, durationMs: record.durationMs, query: record.input?.query, url: record.input?.url, bytes: file.size });
  }
  console.log(JSON.stringify({ directory: root, count: rows.length, records: rows }, null, 2));
} else if (command === "show") {
  const id = process.argv[3];
  if (!id || !/^\d{14,17}-[0-9a-f-]{36}$/u.test(id)) throw new Error("show requires an audit record ID from audit list");
  const match = (await files()).find((file) => file.id === id);
  if (!match) throw new Error(`audit record not found: ${id}`);
  process.stdout.write(await readFile(match.path, "utf8"));
} else if (command === "prune") {
  const found = (await files()).sort((left, right) => left.mtimeMs - right.mtimeMs);
  let total = found.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  for (const file of found) {
    if (file.mtimeMs >= Date.now() - AUDIT_POLICY.maxAgeMs && total <= AUDIT_POLICY.maxBytes) continue;
    await rm(file.path, { force: true });
    total -= file.size;
    removed += 1;
  }
  console.log(JSON.stringify({ directory: root, removed, remainingBytes: total, maxBytes: AUDIT_POLICY.maxBytes, maxAgeDays: AUDIT_POLICY.maxAgeDays }, null, 2));
} else {
  throw new Error("usage: pi-web audit [list [--limit N]|show ID|path|prune]");
}
