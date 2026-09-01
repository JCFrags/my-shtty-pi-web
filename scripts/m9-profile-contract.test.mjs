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

test("AgentCursor is an explicit prebuilt candidate and never mutates the legacy profiles", () => {
  const candidate = run(profileCommand, ["--profile", "browser-agentcursor"]);
  assert.deepEqual(candidate.requestedProfiles, ["browser-agentcursor"]);
  assert.deepEqual(candidate.resolvedProfiles, ["web-core", "browser-agentcursor"]);
  assert.equal(candidate.defaultProfile, "web-core");
  assert.deepEqual(candidate.runtimeFedoraPackages, ["chromium", "webkit2gtk4.1", "libappindicator-gtk3", "librsvg2", "gtk3"]);
  assert.deepEqual(candidate.buildFedoraPackages, []);
  assert.deepEqual(candidate.npmPackages, []);
  assert.deepEqual(candidate.cargoPackages, []);
  assert.deepEqual(candidate.playwrightBrowsers, []);
  assert(candidate.units.includes("webxd.service"));
  assert(candidate.units.includes("pi-web-agentcursor-egress-proxy.service"));
  assert(candidate.units.includes("pi-web-agentcursor-browserd.service"));
  assert(candidate.releaseComponents.includes("agentcursor-attribution"));
  assert.equal(candidate.units.includes("pi-browserd.service"), false);
  assert.equal(candidate.npmPackages.some((item) => item.startsWith("agent-browser@")), false);

  const legacy = run(profileCommand, ["--profile", "browser"]);
  assert.deepEqual(legacy.resolvedProfiles, ["web-core", "browser"]);
  assert.deepEqual(legacy.npmPackages, ["agent-browser@0.33.1"]);
  assert(legacy.units.includes("pi-browserd.service"));
  assert.equal(legacy.units.some((item) => item.includes("agentcursor")), false);
  const full = run(profileCommand, ["--profile", "full"]);
  assert.equal(full.resolvedProfiles.includes("browser-agentcursor"), false);
});

test("core staging uses selected package installs and never uv all-packages", async () => {
  const stage = await readFile(stageCommand, "utf8");
  assert.doesNotMatch(stage, /uv[^\n]*sync[^\n]*--all-packages/);
  assert.match(stage, /"--package", package/);
  assert.match(stage, /profile\["cargoPackages"\]/);
  assert.match(stage, /profile\["playwrightBrowsers"\]/);
});

test("stage relocation accepts direct and long-path uv console launchers", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webx-m9-python-launcher-"));
  const staging = join(temporary, "staging");
  const environment = join(staging, ".venv");
  const candidate = join(temporary, "candidate");
  await mkdir(join(environment, "bin"), { recursive: true });
  const reader = join(environment, "bin", "pi-web-reader");
  const docling = join(environment, "bin", "pi-web-docling");
  await writeFile(reader, `#!${staging}/.venv/bin/python3\nprint('ok')\n`);
  await writeFile(docling, `#!/bin/sh\n'''exec' '${staging}/.venv/bin/python' "$0" "$@"\n' '''\nprint('ok')\n`);
  const code = `
import importlib.machinery, importlib.util, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
loader = importlib.machinery.SourceFileLoader("pi_web_stage", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
module.relocate_python_environment(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), ["pi-web-reader", "pi-web-docling"])
`;
  const result = spawnSync("python3", ["-c", code, stageCommand, environment, staging, candidate], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readFile(reader, "utf8")).split("\n")[0], `#!${candidate}/.venv/bin/python3`);
  assert.deepEqual((await readFile(docling, "utf8")).split("\n").slice(0, 3), [
    "#!/bin/sh",
    `'''exec' '${candidate}/.venv/bin/python' "$0" "$@"`,
    "' '''",
  ]);
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
