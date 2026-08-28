import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AUDIT_POLICY, CACHE_POLICY } from "../packages/policy/storage.mjs";

const text = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("shared storage policy keeps the reviewed defaults", () => {
  assert.deepEqual(CACHE_POLICY, {
    memoryEntries: 256,
    memoryBytes: 32 * 1024 * 1024,
    diskEntries: 2_048,
    diskBytes: 512 * 1024 * 1024,
    maxEntryBytes: 4_300_000,
  });
  assert.deepEqual(AUDIT_POLICY, {
    maxAgeDays: 30,
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxBytes: 100 * 1024 * 1024,
    maxRecordBytes: 64 * 1024,
    maxPruneFiles: 8_192,
    automaticPruneIntervalMs: 60 * 60 * 1_000,
  });
});

test("cache, automatic audit pruning, audit command, and doctor import one policy", async () => {
  const [cache, audit, command, doctor] = await Promise.all([
    text("../apps/webxd/src/cache.ts"),
    text("../apps/pi-webx/src/audit.ts"),
    text("./pi-web-audit.mjs"),
    text("./pi-web-doctor.mjs"),
  ]);
  assert.match(cache, /import \{ CACHE_POLICY \} from "\.\.\/\.\.\/\.\.\/packages\/policy\/storage\.mjs"/);
  assert.match(audit, /import \{ AUDIT_POLICY \} from "\.\.\/\.\.\/\.\.\/packages\/policy\/storage\.mjs"/);
  assert.match(command, /import \{ AUDIT_POLICY \} from "\.\.\/packages\/policy\/storage\.mjs"/);
  assert.match(doctor, /import \{ storagePolicyReport \} from "\.\.\/packages\/policy\/storage\.mjs"/);
  for (const source of [cache, audit, command]) assert.doesNotMatch(source, /10 \* 1024 \* 1024 \* 1024|90 \* 24 \* 60 \* 60/);
});

test("documentation and CI keep the storage and extraction contracts visible", async () => {
  const [readme, extensionReadme, daemonReadme, workflow] = await Promise.all([
    text("../README.md"),
    text("../apps/pi-webx/README.md"),
    text("../apps/webxd/README.md"),
    text("../.github/workflows/ci.yml"),
  ]);
  assert.match(readme, /256 entries and 32 MiB/);
  assert.match(readme, /2,048 entries and 512 MiB/);
  assert.match(readme, /older than 30 days/);
  assert.match(readme, /exceeds 100 MiB/);
  assert.match(readme, /web_read_batch/);
  assert.match(extensionReadme, /web_read_batch/);
  assert.match(extensionReadme, /30-day and 100 MiB policy/);
  assert.match(daemonReadme, /256 entries and 32 MiB/);
  assert.match(daemonReadme, /2,048 entries and 512 MiB/);
  assert.match(workflow, /^\s*- run: pnpm test:extraction$/mu);
});
