import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const stageScript = join(root, "scripts/pi-web-stage");
const cutoverScript = join(root, "scripts/pi-web-cutover");
const smokeScript = join(root, "scripts/pi-web-smoke.ts");

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

test("stage is versioned and isolated from live paths", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-stage-"));
  const home = join(temporary, "home"); const releases = join(temporary, "releases");
  await mkdir(home);
  const output = JSON.parse(run(stageScript, ["--source", root, "--release-root", releases, "--test-no-build"], { HOME: home, XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"), XDG_STATE_HOME: join(temporary, "state"), XDG_RUNTIME_DIR: join(temporary, "runtime") }));
  assert.match(output.candidate, new RegExp(`${output.commit}$`));
  const manifest = JSON.parse(await readFile(join(output.candidate, "candidate-manifest.json"), "utf8"));
  assert.deepEqual(manifest.lockedDependencies, ["pnpm-lock.yaml", "components/browser/uv.lock", "components/browser/Cargo.lock"]);
  assert.equal(manifest.liveChanged, false);
  await assert.rejects(lstat(join(home, ".pi/agent/extensions/pi-web")));
});

test("smoke contract has unique candidate paths, finite ports, and evidence bounds", async () => {
  const smoke = await readFile(smokeScript, "utf8");
  assert.match(smoke, /pi-web-candidate.*runId/);
  assert.match(smoke, /listen\(0, "127\.0\.0\.1"\)/);
  assert.match(smoke, /MAX_EVIDENCE_BYTES = 262_144/);
  assert.match(smoke, /MAX_VISIBLE_CHARS = 40_000/);
  assert.match(smoke, /REQUEST_MS = 45_000/);
  assert.match(smoke, /TOTAL_MS = 180_000/);
  assert.match(smoke, /maxConcurrency <= 3/);
  assert.match(smoke, /fixtureNonLoopback === 0/);
  assert.match(smoke, /web\.readBatch/);
  assert.match(smoke, /web\.content/);
  assert.match(smoke, /document-fail/);
});

test("cutover plan, apply, and rollback stay inside isolated HOME and restore bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-cutover-"));
  const home = join(temporary, "home"); const prefix = join(home, ".local"); const config = join(home, ".config"); const state = join(home, ".state");
  const releases = join(temporary, "releases"); await mkdir(home);
  const staged = JSON.parse(run(stageScript, ["--source", root, "--release-root", releases, "--test-no-build"], { HOME: home }));
  const evidence = join(temporary, "evidence.json"); await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const fake = join(temporary, "systemctl"); const log = join(temporary, "systemctl.log");
  await writeFile(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in *is-active*|*is-enabled*) exit 0;; esac\nexit 0\n`); await chmod(fake, 0o755);
  const env = { HOME: home, PI_WEB_PREFIX: prefix, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const plan = JSON.parse(run(cutoverScript, ["--plan", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode", "--run-id", "contract-run"], env));
  assert.equal(plan.coreIndependentFromOptionalWorkers, true);
  assert(plan.replacementPaths.every((path) => path.startsWith(home)));
  const oldInstall = join(prefix, "lib/pi-web-tools"); await mkdir(oldInstall, { recursive: true }); await writeFile(join(oldInstall, "legacy-marker"), "exact old bytes\n");
  run(cutoverScript, ["--apply", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode", "--run-id", "contract-run", "--systemctl", fake], env);
  assert.equal(await readlink(join(prefix, "lib/pi-web-tools")), staged.candidate);
  const webxdUnit = await readFile(join(config, "systemd/user/webxd.service"), "utf8");
  assert.match(webxdUnit, /Wants=pi-web-reader\.service pi-web-searxng\.service/);
  assert.doesNotMatch(webxdUnit, /pi-browserd|pi-web-crawl|pi-web-docling/);
  const journal = JSON.parse(await readFile(join(state, "pi-web/cutovers/contract-run/journal.json"), "utf8"));
  assert.equal(Object.keys(journal.before).length, plan.replacementPaths.length);
  assert.equal(Object.keys(journal.servicesBefore).length, 7);
  run(cutoverScript, ["--rollback", "contract-run", "--systemctl", fake], env);
  assert.equal((await lstat(oldInstall)).isDirectory(), true);
  assert.equal(await readFile(join(oldInstall, "legacy-marker"), "utf8"), "exact old bytes\n");
  assert.match(await readFile(log, "utf8"), /daemon-reload/);
});

test("cutover refuses traversal-shaped rollback IDs", () => {
  const temporary = spawnSync(cutoverScript, ["--rollback", "../bad"], { encoding: "utf8" });
  assert.notEqual(temporary.status, 0);
  assert.match(temporary.stderr, /run ID is invalid/);
});
