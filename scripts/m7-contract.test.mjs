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

function runResult(command, args, env) {
  return spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
}

function run(command, args, env) {
  const result = runResult(command, args, env);
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function fakeSystemctl(temporary, body = "exit 0") {
  const fake = join(temporary, "systemctl");
  const log = join(temporary, "systemctl.log");
  await writeFile(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in *is-active*|*is-enabled*) exit 0;; esac\n${body}\n`);
  await chmod(fake, 0o755);
  return { fake, log };
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
  assert.match(smoke, /length: 5/);
  assert.match(smoke, /peakFixtureRequests <= 3 && peakFixtureRequests > 1/);
  assert.match(smoke, /PI_WEB_SMOKE_TEST_COLLIDE_READER_ONCE/);
  assert.match(smoke, /attempt <= 5/);
  assert.match(smoke, /cgroupIsolation: "unproven"/);
  assert.match(smoke, /deterministic-high-water-before-cleanup/);
  assert.match(smoke, /names = \["runtime", "cache", "content", "audit"\]/);
  assert.match(smoke, /fixtureNonLoopback === 0/);
  assert.match(smoke, /web\.readBatch/);
  assert.match(smoke, /web\.content/);
  assert.match(smoke, /document-fail/);
});

test("smoke blocks Python bytecode writes and plan accepts the unchanged candidate", async () => {
  const smoke = await readFile(smokeScript, "utf8");
  assert.equal((smoke.match(/PYTHONDONTWRITEBYTECODE: "1"/gu) ?? []).length, 2);
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-bytecode-"));
  const home = join(temporary, "home"); const releases = join(temporary, "releases");
  await mkdir(home);
  const staged = JSON.parse(run(stageScript, ["--source", root, "--release-root", releases, "--test-no-build"], { HOME: home }));
  const packageRoot = join(staged.candidate, "components/browser/services/reader/src");
  const imported = runResult("/usr/bin/python3", ["-c", "import pi_web_reader"], { PYTHONPATH: packageRoot, PYTHONDONTWRITEBYTECODE: "1" });
  assert.equal(imported.status, 0, imported.stderr);
  await assert.rejects(lstat(join(packageRoot, "pi_web_reader/__pycache__")));
  const evidence = join(temporary, "evidence.json"); await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const plan = JSON.parse(run(cutoverScript, ["--plan", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode"], { HOME: home }));
  assert.equal(plan.treeSha256, staged.treeSha256);
});

test("cutover plan, apply, and rollback stay inside isolated HOME and restore bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-cutover-"));
  const home = join(temporary, "home"); const prefix = join(home, ".local"); const config = join(home, ".config"); const state = join(home, ".state");
  const releases = join(temporary, "releases"); await mkdir(home);
  const staged = JSON.parse(run(stageScript, ["--source", root, "--release-root", releases, "--test-no-build"], { HOME: home }));
  const evidence = join(temporary, "evidence.json"); await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const { fake, log } = await fakeSystemctl(temporary);
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

test("failed aggregate stop changes no path and restores service state", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-stop-failure-"));
  const home = join(temporary, "home"); const prefix = join(home, ".local"); const state = join(home, ".state");
  await mkdir(home);
  const staged = JSON.parse(run(stageScript, ["--source", root, "--release-root", join(temporary, "releases"), "--test-no-build"], { HOME: home }));
  const evidence = join(temporary, "evidence.json"); await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const oldInstall = join(prefix, "lib/pi-web-tools"); await mkdir(oldInstall, { recursive: true }); await writeFile(join(oldInstall, "marker"), "unchanged bytes\n");
  const { fake, log } = await fakeSystemctl(temporary, `if [[ "$*" == "--user stop webxd.service pi-web-reader.service pi-web-searxng.service pi-browserd.service pi-web-crawl.service pi-web-docling.service pi-web-egress-proxy.service" ]]; then exit 9; fi\nexit 0`);
  const env = { HOME: home, PI_WEB_PREFIX: prefix, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: state };
  const result = runResult(cutoverScript, ["--apply", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode", "--run-id", "stop-failure", "--systemctl", fake], env);
  assert.notEqual(result.status, 0);
  assert.equal((await lstat(oldInstall)).isDirectory(), true);
  assert.equal(await readFile(join(oldInstall, "marker"), "utf8"), "unchanged bytes\n");
  const journal = JSON.parse(await readFile(join(state, "pi-web/cutovers/stop-failure/journal.json"), "utf8"));
  assert.equal(journal.status, "apply-failed");
  assert.deepEqual(journal.completedPaths, []);
  assert.match(await readFile(log, "utf8"), /--user start webxd\.service/);
});

test("prepared interruption rolls back exact bytes and retry is idempotent", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m7-prepared-"));
  const home = join(temporary, "home"); const prefix = join(home, ".local"); const state = join(home, ".state");
  await mkdir(home);
  const staged = JSON.parse(run(stageScript, ["--source", root, "--release-root", join(temporary, "releases"), "--test-no-build"], { HOME: home }));
  const evidence = join(temporary, "evidence.json"); await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const oldInstall = join(prefix, "lib/pi-web-tools"); await mkdir(oldInstall, { recursive: true });
  const original = Buffer.from([0, 255, 13, 10, 65, 0, 90]); await writeFile(join(oldInstall, "marker.bin"), original);
  const { fake } = await fakeSystemctl(temporary);
  const env = { HOME: home, PI_WEB_PREFIX: prefix, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: state, PI_WEB_CUTOVER_TEST_KILL_AFTER_REPLACEMENT: "1" };
  const killed = runResult(cutoverScript, ["--apply", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode", "--run-id", "prepared-kill", "--systemctl", fake], env);
  assert.equal(killed.signal, "SIGKILL");
  const journalPath = join(state, "pi-web/cutovers/prepared-kill/journal.json");
  const prepared = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.completedPaths, [oldInstall]);
  run(cutoverScript, ["--rollback", "prepared-kill", "--systemctl", fake], env);
  assert.deepEqual(await readFile(join(oldInstall, "marker.bin")), original);
  const second = JSON.parse(run(cutoverScript, ["--rollback", "prepared-kill", "--systemctl", fake], env));
  assert.equal(second.alreadyRolledBack, true);
  assert.deepEqual(await readFile(join(oldInstall, "marker.bin")), original);
});

test("cutover refuses traversal-shaped rollback IDs", () => {
  const temporary = spawnSync(cutoverScript, ["--rollback", "../bad"], { encoding: "utf8" });
  assert.notEqual(temporary.status, 0);
  assert.match(temporary.stderr, /run ID is invalid/);
});
