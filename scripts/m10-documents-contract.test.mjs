import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const profileCommand = resolve(root, "scripts/pi-web-profile");

function profile(args) {
  const result = spawnSync(profileCommand, args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("documents are optional and add pdftotext with finite worker bounds", () => {
  const core = profile([]);
  assert.deepEqual(core.resolvedProfiles, ["web-core"]);
  assert.equal(core.fedoraPackages.includes("poppler-utils"), false);
  assert.equal(core.units.includes("pi-web-docling.service"), false);
  const documents = profile(["--profile", "documents"]);
  assert.equal(documents.fedoraPackages.includes("poppler-utils"), true);
  assert.equal(documents.commands.includes("pdftotext"), true);
  assert.deepEqual(documents.resourceLimits["pi-web-docling.service"], {
    MemoryMax: "4G", TasksMax: 128, Concurrency: 1, QueueSize: 2, TimeoutSeconds: 120,
    MaxInputBytes: 268435456, MaxTempBytes: 536870912, MaxOutputBytes: 16777216,
  });
});

test("generated services make documents explicit and bound Docling", async () => {
  const cutover = await readFile(resolve(root, "scripts/pi-web-cutover"), "utf8");
  assert.match(cutover, /PI_WEB_DOCUMENTS_ENABLED=\{'1' if documents_enabled else '0'\}/u);
  for (const term of ["MemoryMax", "TasksMax", "PI_WEB_DOCLING_CONCURRENCY", "PI_WEB_DOCLING_QUEUE_SIZE", "PI_WEB_DOCLING_TIMEOUT_SECONDS", "PI_WEB_DOCLING_MAX_INPUT_BYTES", "PI_WEB_DOCLING_MAX_OUTPUT_BYTES", "TemporaryFileSystem=/tmp:rw,size="]) assert.match(cutover, new RegExp(term));
  assert.match(cutover, /HF_HUB_OFFLINE=1/u);
  assert.match(cutover, /TRANSFORMERS_OFFLINE=1/u);
});

test("staged smoke includes a valid text PDF and private invalid-PDF evidence", async () => {
  const smoke = await readFile(resolve(root, "scripts/pi-web-smoke.ts"), "utf8");
  assert.match(smoke, /STAGED TEXT PDF SMOKE/u);
  assert.match(smoke, /valid text PDF passes the staged candidate/u);
  assert.match(smoke, /invalid PDF failure evidence contains no private bytes/u);
  assert.match(smoke, /web-core keeps document components explicitly absent/u);
  assert.doesNotMatch(smoke, /dataBase64/u);
});
