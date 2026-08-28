import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const profileCommand = join(root, "scripts/pi-web-profile");
const stageCommand = join(root, "scripts/pi-web-stage");
const cutoverCommand = join(root, "scripts/pi-web-cutover");
const installerCommand = join(root, "install-fedora.sh");

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("web-core is the default and excludes every heavy optional dependency", () => {
  const profile = run(profileCommand, []);
  assert.deepEqual(profile.resolvedProfiles, ["web-core"]);
  assert.deepEqual(profile.pythonPackages, ["pi-web-reader"]);
  assert.deepEqual(profile.cargoPackages, []);
  assert.deepEqual(profile.playwrightBrowsers, []);
  assert.deepEqual(profile.npmPackages, []);
  const forbidden = /chromium|agent-browser|playwright|crawl4ai|docling|rust|cargo|webkit|gtk|tauri|pi-browserd/i;
  assert.equal(profile.fedoraPackages.some((item) => forbidden.test(item)), false);
  assert.equal(profile.units.some((item) => forbidden.test(item)), false);
});

test("optional profiles compose and full preserves explicit compatibility behavior", () => {
  const composed = run(profileCommand, ["--profile", "documents", "--profile", "browser"]);
  assert.deepEqual(composed.resolvedProfiles, ["web-core", "documents", "browser"]);
  assert.deepEqual(composed.pythonPackages, ["pi-web-reader", "pi-web-docling"]);
  assert.deepEqual(composed.cargoPackages, ["pi-browserd", "pi-browser-workspace"]);
  assert.equal(composed.playwrightBrowsers.length, 0);
  const full = run(profileCommand, ["--profile", "full"]);
  assert.deepEqual(full.resolvedProfiles, ["web-core", "documents", "render", "browser"]);
  assert.deepEqual(full.playwrightBrowsers, ["chromium"]);
  assert(full.units.includes("pi-web-crawl.service"));
  assert(full.units.includes("pi-browserd.service"));
});

test("core staging uses selected package installs and never uv all-packages", async () => {
  const stage = await readFile(stageCommand, "utf8");
  assert.doesNotMatch(stage, /uv[^\n]*sync[^\n]*--all-packages/);
  assert.match(stage, /"--package", package/);
  assert.match(stage, /profile\["cargoPackages"\]/);
  assert.match(stage, /profile\["playwrightBrowsers"\]/);
});

test("the installer provisions pinned core build tools without optional packages", async () => {
  const installer = await readFile(installerCommand, "utf8");
  assert.match(installer, /pnpm@10\.13\.1/);
  assert.match(installer, /astral\.sh\/uv\/0\.12\.0\/install\.sh/);
  assert.doesNotMatch(installer, /agent-browser@|playwright install|cargo build|uv sync --all-packages/);
});

test("the browser service can find the profile-local Agent Browser binary", async () => {
  const cutover = await readFile(cutoverCommand, "utf8");
  assert.match(cutover, /\.agent-browser\/node_modules\/\.bin:/);
  assert.match(cutover, /if browser_enabled else ""/);
});

test("candidate and cutover plans record generated core units and reviewed limits", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m9-profile-"));
  const home = join(temporary, "home");
  await mkdir(home);
  const staged = run(stageCommand, ["--source", root, "--release-root", join(temporary, "releases"), "--test-no-build"], { HOME: home });
  const manifest = JSON.parse(await readFile(join(staged.candidate, "candidate-manifest.json"), "utf8"));
  assert.deepEqual(manifest.profile.resolvedProfiles, ["web-core"]);
  assert.deepEqual(manifest.profile.resourceLimits["pi-web-reader.service"], { MemoryMax: "2G", TasksMax: 512 });
  const evidence = join(temporary, "evidence.json");
  await writeFile(evidence, JSON.stringify({ ok: true, mode: "deterministic" }));
  const plan = run(cutoverCommand, ["--plan", "--candidate", staged.candidate, "--evidence", evidence, "--test-mode"], {
    HOME: home,
    PI_WEB_PREFIX: join(home, ".local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state"),
  });
  assert.deepEqual(plan.serviceUnits, ["webxd.service", "pi-web-reader.service", "pi-web-searxng.service"]);
  assert(plan.replacementPaths.some((path) => path.endsWith("pi-web-searxng.service.d/profile-limits.conf")));
  assert.deepEqual(plan.stoppedForTransition.sort(), ["pi-browserd.service", "pi-web-crawl.service", "pi-web-docling.service", "pi-web-egress-proxy.service", "pi-web-reader.service", "pi-web-searxng.service", "webxd.service"].sort());
});
