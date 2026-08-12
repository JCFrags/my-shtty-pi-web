import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const harness = join(root, "scripts/complete-browser-check.mjs");
const mock = join(root, "tests/integration/browser-mock-shipped-entrypoint.mjs");

test("fixed harness drives the shipped entrypoint and writes a complete evidence manifest", { timeout: 30_000 }, async (t) => {
  const output = await mkdtemp(join(tmpdir(), "pi-web-complete-harness-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await run(process.execPath, [harness, "--entrypoint", process.execPath, "--entrypoint-arg", mock, "--output", output, "--profile", "complete", "--timeout-ms", "5000"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.requiredPaths, ["agent-browser/chrome", "pinchtab/chrome"]);
  assert.ok(manifest.cases.length >= 26);
  for (const id of ["G01", "G06", "G10", "G13", "G15", "G17", "G20", "G21", "N01", "J1", "J2", "J3", "J4", "J5"]) assert.equal(manifest.cases.find((item) => item.id === id)?.ok, true, id);
  assert.equal(manifest.cases.find((item) => item.id === "N01").evidence.negativeSelector.dispatched, false);
  assert.ok(manifest.cases.filter((item) => item.visual).every((item) => item.visual.review === "pending-fresh-model-review"));
  assert.deepEqual(manifest.cleanStateInventory, []);
});

test("fixed harness refuses to run without a shipped entrypoint", async () => {
  const result = await run(process.execPath, [harness, "--output", "/tmp/not-used"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--entrypoint is required/);
});

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
