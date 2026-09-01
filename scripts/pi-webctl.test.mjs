import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  doctorReport,
  installationPreflight,
  installRelease,
  installedPaths,
  qualifyInstalled,
  rollbackRelease,
  setBackend,
  uninstallCandidate,
  verifyInstallRelease,
} from "./pi-webctl.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ordinaryUnitNames = ["pi-web-agentcursor-egress-proxy.service", "pi-web-agentcursor-browserd.service", "webxd.service"];
const unitNames = [...ordinaryUnitNames, "pi-web-qualification-egress-proxy.service", "pi-web-qualification-browserd.service", "pi-web-qualification-webxd.service"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** @param {string} releaseId @param {string} sha @param {Array<{path: string, sha256: string, bytes: number}>} immutableFiles */
function completeManifest(releaseId, sha, immutableFiles) {
  return {
    schemaVersion: 1, releaseId, gitSha: sha, dirtyTree: false, buildTimestamp: "2026-01-01T00:00:00Z",
    toolchain: { node: "24.0.0", pnpm: "10.13.1", rust: "rustc 1.88.0", tauriCli: "tauri-cli 2", tauriLibrary: "2.0.0" },
    versions: { publicWebX: "3.0.0", publicBrowserContract: "3.0.0", browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2" },
    agentCursor: { repository: "https://github.com/kumard3/agentcursor", version: "0.3.0", commit: "b".repeat(40), vendoredSourceSha256: "c".repeat(64) },
    packageLockSha256: "d".repeat(64), supportedFedora: [44], testedBrowser: "test fixture", buildMode: "release", backendDefault: "legacy",
    packaging: { node: "fixture", proxy: "fixture", tauri: "fixture", checksumAlgorithm: "sha256", checksumScopeExcludes: ["checksums.json"] },
    immutableFiles,
    compatibility: { node: { minimumMajor: 24, maximumMajor: 24 }, rustBuild: "1.88.0", fedora: [44], webXApiMajor: 3, browserContractMajor: 3, browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2", defaultBackend: "legacy", candidateBackend: "agentcursor" },
    artifacts: { binary: "bin/pi-browser-workspace", qualificationBinary: "bin/pi-browser-workspace-qualification", rpm: "share/artifacts/pi-browser-workspace.rpm" },
  };
}

async function regularFiles(root) {
  const pending = [root]; const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("unexpected fixture entry");
    }
  }
  return files.sort();
}

async function seal(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else await chmod(path, path.includes(`${sep}bin${sep}`) ? 0o555 : 0o444);
    }
    await chmod(directory, 0o555);
  }
}

/** @param {string} parent @param {string} character @param {((root: string) => Promise<void>) | undefined} mutate */
async function syntheticRelease(parent, character, mutate = undefined) {
  const gitSha = character.repeat(40);
  const releaseId = `phase4a-${gitSha}`;
  const root = join(parent, releaseId);
  await Promise.all([
    mkdir(join(root, "bin"), { recursive: true }),
    mkdir(join(root, "share/artifacts"), { recursive: true }),
    mkdir(join(root, "share/deploy/config"), { recursive: true }),
    mkdir(join(root, "share/deploy/systemd"), { recursive: true }),
    mkdir(join(root, "share/icons"), { recursive: true }),
    mkdir(join(root, "share/pi-webx"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "bin/pi-web-browserd.mjs"), "export {};\n"),
    writeFile(join(root, "bin/pi-web-webxd.mjs"), "export {};\n"),
    writeFile(join(root, "bin/pi-web-egress-proxy"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(root, "bin/pi-web-qualification-proxy"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(root, "bin/pi-web-qualification-atspi.py"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(root, "bin/pi-web-qualification-runner.mjs"), "export {};\n"),
    writeFile(join(root, "bin/pi-web-qualification-pi-worker.mjs"), "export {};\n"),
    writeFile(join(root, "bin/pi-browser-workspace"), "workspace fixture\n"),
    writeFile(join(root, "bin/pi-browser-workspace-qualification"), "workspace qualification fixture\n"),
    copyFile(join(sourceRoot, "scripts/pi-webctl.mjs"), join(root, "bin/pi-webctl.mjs")),
    copyFile(join(sourceRoot, "scripts/phase4a-release-format.mjs"), join(root, "bin/phase4a-release-format.mjs")),
    writeFile(join(root, "share/artifacts/pi-browser-workspace.rpm"), "rpm fixture\n"),
    copyFile(join(sourceRoot, "scripts/phase4a-config.mjs"), join(root, "share/deploy/phase4a-config.mjs")),
    copyFile(join(sourceRoot, "deploy/phase4a/config/default.json"), join(root, "share/deploy/config/default.json")),
    writeFile(join(root, "share/icons/pi-web-workspace.png"), "png fixture\n"),
    writeFile(join(root, "share/pi-webx/extension.mjs"), "export default function extension() {}\n"),
    ...unitNames.map((name) => copyFile(join(sourceRoot, `deploy/phase4a/systemd/${name}.in`), join(root, `share/deploy/systemd/${name}.in`))),
  ]);
  await mutate?.(root);
  const immutableFiles = [];
  for (const path of await regularFiles(root)) {
    const bytes = await readFile(path);
    immutableFiles.push({ path: relative(root, path).replaceAll(sep, "/"), sha256: digest(bytes), bytes: bytes.byteLength });
  }
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(completeManifest(releaseId, gitSha, immutableFiles), null, 2)}\n`);
  const files = [];
  for (const path of await regularFiles(root)) {
    const bytes = await readFile(path);
    files.push({ path: relative(root, path).replaceAll(sep, "/"), sha256: digest(bytes), bytes: bytes.byteLength, mode: path.includes(`${sep}bin${sep}`) ? 0o555 : 0o444 });
    await chmod(path, path.includes(`${sep}bin${sep}`) ? 0o555 : 0o444);
  }
  await chmod(root, 0o755);
  await writeFile(join(root, "checksums.json"), `${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", excludes: ["checksums.json"], files }, null, 2)}\n`);
  await chmod(join(root, "checksums.json"), 0o444);
  await seal(root);
  return { root, releaseId, gitSha };
}

async function fakeSystemctl(temporary) {
  const command = join(temporary, "systemctl");
  const log = join(temporary, "systemctl.log");
  const failure = join(temporary, "fail-webxd-active");
  const operationFailure = join(temporary, "fail-systemctl-operation");
  const deactivateOnRestart = join(temporary, "deactivate-webxd-on-restart");
  const staticOnFailedOperation = join(temporary, "static-on-failed-operation");
  const qualificationFenceProbe = join(temporary, "qualification-fence-probe");
  const state = join(temporary, "systemctl-state");
  await mkdir(state);
  await Promise.all([writeFile(join(state, "webxd.service.active"), ""), writeFile(join(state, "webxd.service.enabled"), "")]);
  await writeFile(command, `#!/usr/bin/env bash
raw="$*"
printf '%s\\n' "$raw" >> "${log}"
if [[ -f "${deactivateOnRestart}" ]] && [[ "$raw" == '--user restart webxd.service' ]]; then rm -f "${state}/webxd.service.active"; touch "${failure}"; exit 1; fi
if [[ -f "${operationFailure}" ]] && [[ "$raw" == "$(cat "${operationFailure}")" ]]; then
  if [[ -f "${staticOnFailedOperation}" ]]; then unit="\${raw##* }"; touch "${state}/$unit.static"; fi
  exit 1
fi
[[ "$1" == '--user' ]] && shift
operation="$1"; shift || true
case "$operation" in
  is-active) unit="$1"; if [[ "$unit" != 'webxd.service' || ! -f "${failure}" ]] && [[ -f "${state}/$unit.active" ]]; then printf 'active\\n'; exit 0; else printf 'inactive\\n'; exit 3; fi ;;
  is-enabled) unit="$1"; if [[ -f "${state}/$unit.static" ]]; then printf 'static\\n'; exit 0; elif [[ -f "${state}/$unit.enabled" ]]; then printf 'enabled\\n'; exit 0; else printf 'disabled\\n'; exit 1; fi ;;
  enable) now=0; [[ "$1" == '--now' ]] && { now=1; shift; }; unit="$1"; touch "${state}/$unit.enabled"; [[ "$now" == 0 ]] || touch "${state}/$unit.active" ;;
  disable) now=0; [[ "$1" == '--now' ]] && { now=1; shift; }; unit="$1"; rm -f "${state}/$unit.enabled"; [[ "$now" == 0 ]] || rm -f "${state}/$unit.active" ;;
  start) unit="$1"; touch "${state}/$unit.active" ;;
  stop) unit="$1"; if [[ "$unit" == pi-web-qualification-* ]] && [[ -f "${qualificationFenceProbe}" ]]; then probe="$(cat "${qualificationFenceProbe}")"; if [[ -e "$probe" || -L "$probe" ]]; then printf 'qualification-fence-after-preparation %s\\n' "$unit" >> "${log}"; else printf 'qualification-fence-before-preparation %s\\n' "$unit" >> "${log}"; fi; fi; rm -f "${state}/$unit.active" ;;
  restart) unit="$1"; touch "${state}/$unit.active" ;;
  daemon-reload|show-environment|reset-failed) exit 0 ;;
  *) exit 1 ;;
esac
`);
  await chmod(command, 0o755);
  return { command, log, failure, operationFailure, deactivateOnRestart, staticOnFailedOperation, qualificationFenceProbe, state };
}

/** @param {string} path */
async function savedPath(path) {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
    return { kind: "file", mode: information.mode & 0o777, dataBase64: (await readFile(path)).toString("base64") };
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" }; throw error; }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} currentReleaseId @param {string | undefined} previousReleaseId */
async function activationSnapshot(paths, currentReleaseId, previousReleaseId) {
  const managedPaths = [
    ...unitNames.map((name) => join(paths.unitRoot, name)), paths.environmentPath, paths.desktopPath,
    paths.extensionPath, paths.controlLink, paths.workspaceLink,
  ];
  return {
    currentReleaseId, previousReleaseId,
    config: await savedPath(paths.configPath),
    deployment: await savedPath(paths.deploymentPath),
    managed: Object.fromEntries(await Promise.all(managedPaths.map(async (path) => [path, await savedPath(path)]))),
    services: Object.fromEntries(ordinaryUnitNames.map((name) => [name, { active: "active", enabled: "enabled" }])),
  };
}

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "pi-webctl-test-"));
  const home = join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: join(temporary, "runtime"),
    PI_WEB_BIN_HOME: join(home, ".local/bin"),
  };
  await Promise.all([mkdir(home, { recursive: true }), mkdir(environment.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })]);
  await chmod(environment.XDG_RUNTIME_DIR, 0o700);
  const paths = installedPaths(environment);
  const systemd = await fakeSystemctl(temporary);
  const releases = join(temporary, "source-releases"); await mkdir(releases);
  return { temporary, environment, paths, systemd, releases };
}

test("preflight is non-mutating, legacy-isolated, closed, and reports one reviewed package command", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const legacyRoots = [environment.XDG_DATA_HOME, environment.XDG_CONFIG_HOME, environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME].map((root) => join(root, "pi-web"));
  for (const root of legacyRoots) { await mkdir(root, { recursive: true }); await writeFile(join(root, "legacy-state"), "preserve\n"); }
  assert.deepEqual([paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.stateRoot], [
    join(environment.XDG_DATA_HOME, "pi-web-phase4a"),
    join(environment.XDG_CONFIG_HOME, "pi-web-phase4a"),
    join(environment.XDG_CACHE_HOME, "pi-web-phase4a"),
    join(environment.XDG_STATE_HOME, "pi-web-phase4a"),
  ]);
  const release = await syntheticRelease(releases, "7");
  const manifestDigest = digest(await readFile(join(release.root, "manifest.json")));
  const readyProbes = {
    osRelease: "ID=fedora\nVERSION_ID=44\n", architecture: "x64", systemdAvailable: true,
    diskAvailableBytes: 2_000_000_000, runtimeAvailableBytes: 4_000_000_000, nodeVersion: "24.18.0", pythonVersion: "Python 3.14.7",
    missingPackages: [], browser: { product: "Chromium", version: "151.0.0.0" }, portState: "free", serviceConflict: false, destinationConflict: false, runtimeState: "clean",
  };
  const ready = await installationPreflight(paths, systemd.command, release.root, release.gitSha, manifestDigest, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, readyProbes);
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.findings.map((item) => item.category), ["release", "platform", "systemd", "session", "filesystem", "disk", "node", "python", "packages", "browser", "conflicts", "runtime", "existing"]);
  assert.equal(ready.installCommand, null);
  await assert.rejects(lstat(paths.dataRoot), /ENOENT/u, "preflight does not create managed roots");
  for (const root of legacyRoots) assert.equal(await readFile(join(root, "legacy-state"), "utf8"), "preserve\n");
  assert.equal(await readFile(systemd.log, "utf8").catch(() => ""), "", "injected preflight does not invoke systemctl");

  const missingNode = await installationPreflight(paths, systemd.command, release.root, release.gitSha, manifestDigest, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, { ...readyProbes, missingPackages: ["nodejs24"] });
  assert.deepEqual(missingNode.missingPackages, ["nodejs24"]);
  assert.equal(missingNode.installCommand, "/usr/bin/sudo /usr/bin/dnf install -- nodejs24");

  const hostileBrowser = await installationPreflight(paths, systemd.command, release.root, release.gitSha, manifestDigest, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    osRelease: "ID=fedora\nVERSION_ID=44\n", architecture: "x64", systemdAvailable: true,
    diskAvailableBytes: 2_000_000_000, runtimeAvailableBytes: 4_000_000_000, nodeVersion: "24.18.0", pythonVersion: "Python 3.14.7",
    missingPackages: [], browser: { product: "SECRET_BROWSER_PRODUCT", version: "151.0.0.0-SECRET_BROWSER_VERSION" }, portState: "free", serviceConflict: false, destinationConflict: false, runtimeState: "clean",
  });
  assert.equal(hostileBrowser.findings.find((item) => item.category === "browser")?.code, "BROWSER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(hostileBrowser), /SECRET_BROWSER_PRODUCT|SECRET_BROWSER_VERSION/u);

  const blocked = await installationPreflight(paths, systemd.command, release.root, release.gitSha, manifestDigest, environment, {
    osRelease: "ID=fedora\nVERSION_ID=43\n", architecture: "x64", systemdAvailable: false,
    diskAvailableBytes: 1, runtimeAvailableBytes: 1, nodeVersion: "23.0.0", pythonVersion: "Python 3.12.0",
    missingPackages: ["webkit2gtk4.1", "chromium"], portState: "conflict", serviceConflict: true, destinationConflict: true, runtimeState: "present",
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missingPackages, ["chromium", "webkit2gtk4.1"]);
  assert.equal(blocked.installCommand, "/usr/bin/sudo /usr/bin/dnf install -- chromium webkit2gtk4.1");
  assert.doesNotMatch(JSON.stringify(blocked), /\/tmp\/|DBUS_SESSION_BUS_ADDRESS|WAYLAND_DISPLAY|SECRET/u);
});

test("production CLI requires exact identity, rejects option channels, and classifies doctor output", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const script = join(sourceRoot, "scripts/pi-webctl.mjs");
  const invoke = (arguments_) => spawnSync(process.execPath, [script, ...arguments_], { encoding: "utf8", env: { ...process.env, ...environment } });
  for (const failure of [
    invoke(["install", "--release", releases]),
    invoke(["preflight", "--release", releases, "--release", releases]),
    invoke(["qualify", "acceptance", "--duration", "1", "--expected-sha", "a".repeat(40), "--manifest-sha256", "b".repeat(64)]),
    invoke(["qualify", "soak", "--output", releases, "--expected-sha", "a".repeat(40), "--manifest-sha256", "b".repeat(64)]),
    invoke(["qualify", "custom", "--expected-sha", "a".repeat(40), "--manifest-sha256", "b".repeat(64)]),
    invoke(["status", "--systemctl", systemd.command]),
  ]) {
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr, "pi-webctl: PI_WEBCTL_FAILED: The requested operation failed.\n");
    assert.doesNotMatch(failure.stderr, new RegExp(releases.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  const statusFailure = invoke(["status", "--json"]);
  assert.equal(statusFailure.status, 1);
  assert.equal(statusFailure.stderr, "");
  assert.deepEqual(JSON.parse(statusFailure.stdout), { schemaVersion: 1, ok: false, error: { code: "PI_WEBCTL_FAILED", summary: "The requested operation failed." } });

  const release = await syntheticRelease(releases, "0");
  await installRelease(paths, systemd.command, release.root);
  const json = invoke(["doctor", "--json"]);
  assert.equal(json.status, 1);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.findings.map((item) => item.category), ["release", "filesystem", "services", "display", "browser", "egress", "authority", "resource", "workspace"]);
  assert.doesNotMatch(json.stdout + json.stderr, /\/tmp\/|bindingSecret|socketPath|profile/u);
  const human = invoke(["doctor"]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /^(?:PASS|WARNING|ERROR|UNAVAILABLE|NOT-TESTED)\t/u);
  assert.doesNotMatch(human.stdout + human.stderr, /\/tmp\/|bindingSecret|socketPath|profile/u);
});

test("prospective render failure occurs after fencing but before selector or ordinary service changes", async () => {
  const { paths, systemd, releases } = await fixture();
  const current = await syntheticRelease(releases, "8");
  await installRelease(paths, systemd.command, current.root);
  const logBefore = await readFile(systemd.log, "utf8");
  const selectorBefore = await readlink(paths.activeSelectorLink);
  const broken = await syntheticRelease(releases, "9", async (root) => {
    const path = join(root, "share/deploy/systemd/webxd.service.in");
    await writeFile(path, `${await readFile(path, "utf8")}\nUnknown=@UNREVIEWED_PLACEHOLDER@\n`);
  });
  await assert.rejects(installRelease(paths, systemd.command, broken.root), /unit template contains an unknown placeholder/u);
  assert.equal(await readlink(paths.activeSelectorLink), selectorBefore);
  assert.equal(await readlink(paths.currentLink), `../../releases/${current.releaseId}`);
  const systemctlDelta = (await readFile(systemd.log, "utf8")).slice(logBefore.length).trim().split("\n");
  const expectedFence = [...unitNames.filter((name) => name.startsWith("pi-web-qualification-"))].reverse().flatMap((unit) => [
    `--user stop ${unit}`,
    `--user reset-failed ${unit}`,
    `--user is-active ${unit}`,
  ]);
  assert.deepEqual(systemctlDelta, expectedFence, "an invalid prospective render performs only the mandatory qualification fence");
  assert.equal((await readdir(paths.selectorsRoot)).filter((name) => /^selector-/u.test(name)).length, 1);
});

test("verified install is legacy-default, immutable, direct-launching, and preserves the legacy unit", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "a");
  await mkdir(paths.unitRoot, { recursive: true });
  await writeFile(join(paths.unitRoot, "pi-browserd.service"), "legacy-browser-unit\n");
  await writeFile(join(paths.unitRoot, "webxd.service"), "legacy-webxd-unit\n");

  const result = await installRelease(paths, systemd.command, release.root);
  assert.equal(result.backend, "legacy");
  assert.equal(await readlink(paths.currentLink), `../../releases/${release.releaseId}`);
  assert.equal((await lstat(join(paths.releasesRoot, release.releaseId))).mode & 0o777, 0o555);
  assert.equal((await lstat(paths.configPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.environmentPath)).mode & 0o777, 0o600);
  const config = JSON.parse(await readFile(paths.configPath, "utf8"));
  assert.equal(config.backend, "legacy");
  assert.equal(config.resources.maxBrowserSessions, 2);
  const serviceEnvironment = await readFile(paths.environmentPath, "utf8");
  assert.match(serviceEnvironment, /^PI_WEB_EGRESS_HOST="127\.0\.0\.1"$/mu);
  assert.match(serviceEnvironment, /^PI_WEB_EGRESS_PORT="8877"$/mu);
  assert.ok(serviceEnvironment.includes(`WEBX_CACHE_DIR="${paths.cacheRoot}/responses"\n`));
  assert.ok(serviceEnvironment.includes(`WEBX_CONTENT_DIR="${paths.cacheRoot}/content"\n`));
  assert.ok(!serviceEnvironment.includes(`${environment.XDG_CACHE_HOME}/pi-web/`));
  const webxd = await readFile(join(paths.unitRoot, "webxd.service"), "utf8");
  assert.match(webxd, /Wants=.*pi-browserd\.service/u);
  assert.doesNotMatch(webxd, /pi-web-agentcursor-browserd\.service/u);
  assert.ok(webxd.includes(`EnvironmentFile=${paths.configRoot}/service.env\n`));
  assert.ok(webxd.includes(`WorkingDirectory=${paths.stateRoot}\n`));
  assert.ok(webxd.includes(`ReadWritePaths=${paths.cacheRoot} ${paths.stateRoot}\n`));
  assert.ok(!webxd.includes(`${environment.XDG_CONFIG_HOME}/pi-web/service.env`));
  assert.ok(!webxd.includes(`${environment.XDG_CACHE_HOME}/pi-web `));
  assert.ok(!webxd.includes(`${environment.XDG_STATE_HOME}/pi-web\n`));
  assert.doesNotMatch(webxd, /Projects\/|node_modules|tsx|vite/u);
  assert.equal(await readFile(join(paths.unitRoot, "pi-browserd.service"), "utf8"), "legacy-browser-unit\n");
  assert.equal(await readlink(paths.controlLink), join(paths.currentLink, "bin/pi-webctl.mjs"));
  assert.equal(await readlink(paths.extensionPath), join(paths.currentLink, "share/pi-webx"));
  const desktop = await readFile(paths.desktopPath, "utf8");
  assert.match(desktop, /^Exec=".*\/current\/bin\/pi-browser-workspace"$/mu);
  assert.doesNotMatch(desktop, /\/bin\/(?:ba)?sh|--debug|vite/u);
  const unitValidation = spawnSync("/usr/bin/systemd-analyze", ["--user", "verify", ...unitNames.map((name) => join(paths.unitRoot, name))], { encoding: "utf8", env: { ...process.env, ...environment, HOME: paths.home } });
  assert.equal(unitValidation.status, 0, unitValidation.stderr || unitValidation.stdout);
  const desktopValidation = spawnSync("/usr/bin/desktop-file-validate", [paths.desktopPath], { encoding: "utf8" });
  assert.equal(desktopValidation.status, 0, desktopValidation.stderr || desktopValidation.stdout);
  assert.doesNotMatch(await readFile(systemd.log, "utf8"), /(?:disable|stop).*pi-browserd\.service/u);

  assert.equal((await setBackend(paths, systemd.command, "agentcursor")).backend, "agentcursor");
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "agentcursor");
  const agentcursorWebxd = await readFile(join(paths.unitRoot, "webxd.service"), "utf8");
  assert.match(agentcursorWebxd, /Wants=.*pi-web-agentcursor-browserd\.service/u);
  assert.doesNotMatch(agentcursorWebxd, /Wants=.*pi-browserd\.service/u);
  assert.equal((await setBackend(paths, systemd.command, "legacy")).backend, "legacy");
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "legacy");

  const uninstalled = await uninstallCandidate(paths, systemd.command);
  assert.equal(uninstalled.legacyPreserved, true);
  await assert.rejects(lstat(paths.currentLink), /ENOENT/u);
  assert.equal(await readFile(join(paths.unitRoot, "webxd.service"), "utf8"), "legacy-webxd-unit\n");
  assert.equal(await readFile(join(paths.unitRoot, "pi-browserd.service"), "utf8"), "legacy-browser-unit\n");
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "legacy", "default uninstall retains candidate user configuration");
});

test("upgrade, release rollback, failed activation rollback, and reinstall are deterministic", async () => {
  const { paths, systemd, releases } = await fixture();
  const first = await syntheticRelease(releases, "b");
  const second = await syntheticRelease(releases, "c");
  const third = await syntheticRelease(releases, "d");
  await installRelease(paths, systemd.command, first.root);
  await setBackend(paths, systemd.command, "agentcursor");
  const upgraded = await installRelease(paths, systemd.command, second.root);
  assert.equal(upgraded.backend, "agentcursor", "upgrade preserves explicit backend choice");
  assert.equal(await readlink(paths.currentLink), `../../releases/${second.releaseId}`);
  assert.equal(await readlink(paths.previousLink), `../../releases/${first.releaseId}`);
  assert.equal((await readdir(paths.selectorsRoot)).filter((name) => /^selector-/u.test(name)).length, 1, "obsolete selector generations are pruned after commit");
  const deploymentBeforeReinstall = await readFile(paths.deploymentPath, "utf8");
  const sameShaReinstall = await installRelease(paths, systemd.command, second.root);
  assert.equal(sameShaReinstall.previousReleaseId, first.releaseId);
  assert.equal(await readFile(paths.deploymentPath, "utf8"), deploymentBeforeReinstall, "same-SHA reinstall preserves the real rollback target and backend");

  const rolledBack = await rollbackRelease(paths, systemd.command);
  assert.equal(rolledBack.releaseId, first.releaseId);
  assert.equal(rolledBack.backend, "agentcursor");
  assert.equal(await readlink(paths.currentLink), `../../releases/${first.releaseId}`);
  assert.equal(await readlink(paths.previousLink), `../../releases/${second.releaseId}`);

  await writeFile(systemd.failure, "fail\n");
  await assert.rejects(installRelease(paths, systemd.command, third.root), /candidate service is not active: webxd\.service/u);
  assert.equal(await readlink(paths.currentLink), `../../releases/${first.releaseId}`, "failed activation restores the exact current release");
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "agentcursor", "failed activation restores backend choice");
  assert.equal(JSON.parse(await readFile(paths.failurePath, "utf8")).releaseRetained, true);

  await import("node:fs/promises").then(({ rm }) => rm(systemd.failure));
  await uninstallCandidate(paths, systemd.command);
  const reinstalled = await installRelease(paths, systemd.command, first.root);
  assert.equal(reinstalled.releaseId, first.releaseId);
  assert.equal(reinstalled.backend, "legacy");
});

test("post-callback failure restores deployment metadata with the activation", async () => {
  const { paths, systemd, releases } = await fixture();
  const first = await syntheticRelease(releases, "d");
  const second = await syntheticRelease(releases, "e");
  await installRelease(paths, systemd.command, first.root);
  const deploymentBefore = await readFile(paths.deploymentPath, "utf8");
  const unsafeSelector = join(paths.selectorsRoot, `selector-${"f".repeat(24)}`);
  await mkdir(unsafeSelector, { mode: 0o755 });
  await assert.rejects(installRelease(paths, systemd.command, second.root), /obsolete release selector is unsafe/u);
  assert.equal(await readlink(paths.currentLink), `../../releases/${first.releaseId}`);
  assert.equal(await readFile(paths.deploymentPath, "utf8"), deploymentBefore);
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u);
});

test("existing same-SHA release cannot bypass the requested manifest digest", async () => {
  const { temporary, paths, systemd, releases } = await fixture();
  const first = await syntheticRelease(releases, "e");
  const alternateRoot = join(temporary, "alternate-releases");
  await mkdir(alternateRoot);
  const alternate = await syntheticRelease(alternateRoot, "e", async (root) => {
    await writeFile(join(root, "share/icons/pi-web-workspace.png"), "different reviewed payload\n");
  });
  const firstDigest = digest(await readFile(join(first.root, "manifest.json")));
  const alternateDigest = digest(await readFile(join(alternate.root, "manifest.json")));
  assert.notEqual(firstDigest, alternateDigest);
  await installRelease(paths, systemd.command, first.root, first.gitSha, firstDigest);
  await assert.rejects(installRelease(paths, systemd.command, alternate.root, alternate.gitSha, alternateDigest), /manifest digest does not match the requested digest/u);
  assert.equal(digest(await readFile(join(paths.releasesRoot, first.releaseId, "manifest.json"))), firstDigest);
  assert.equal(await readlink(paths.currentLink), `../../releases/${first.releaseId}`);
});

test("checksum corruption and a missing qualification helper are refused before activation", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "e");
  const browserd = join(release.root, "bin/pi-web-browserd.mjs");
  await chmod(release.root, 0o755); await chmod(browserd, 0o755); await writeFile(browserd, "tampered\n"); await chmod(browserd, 0o555); await chmod(release.root, 0o555);
  await assert.rejects(verifyInstallRelease(release.root), /release checksum failed/u);
  await assert.rejects(installRelease(paths, systemd.command, release.root), /release checksum failed/u);
  await assert.rejects(lstat(paths.currentLink), /ENOENT/u);

  const missingAtspi = await syntheticRelease(releases, "d", async (root) => await rm(join(root, "bin/pi-web-qualification-atspi.py")));
  await assert.rejects(verifyInstallRelease(missingAtspi.root), /missing required installed file: bin\/pi-web-qualification-atspi\.py/u);
});

test("closed release documents reject unknown fields, unsafe paths, and wrong expected identity", async () => {
  const { releases } = await fixture();
  const release = await syntheticRelease(releases, "f");
  const manifestPath = join(release.root, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  await assert.rejects(verifyInstallRelease(release.root, release.gitSha, "0".repeat(64)), /manifest digest does not match/u);
  await chmod(manifestPath, 0o644);
  const manifest = JSON.parse(manifestBytes.toString("utf8")); manifest.unreviewed = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`); await chmod(manifestPath, 0o444);
  await assert.rejects(verifyInstallRelease(release.root), /release manifest fields are invalid/u);

  await chmod(manifestPath, 0o644); await writeFile(manifestPath, manifestBytes); await chmod(manifestPath, 0o444);
  const checksumsPath = join(release.root, "checksums.json");
  const checksums = JSON.parse(await readFile(checksumsPath, "utf8"));
  checksums.files[0].path = "bin//unsafe";
  await chmod(checksumsPath, 0o644); await writeFile(checksumsPath, `${JSON.stringify(checksums)}\n`); await chmod(checksumsPath, 0o444);
  await assert.rejects(verifyInstallRelease(release.root), /checksum record 0 path is unsafe/u);
});

test("release verification enforces the primary group identity", async (context) => {
  const alternateGroup = process.getgroups?.().find((group) => group !== process.getgid?.());
  if (alternateGroup === undefined) { context.skip("no supplementary group is available"); return; }
  const { releases } = await fixture();
  const release = await syntheticRelease(releases, "9");
  const payload = join(release.root, "bin/pi-web-browserd.mjs");
  await chown(payload, process.getuid?.() ?? -1, alternateGroup);
  await assert.rejects(verifyInstallRelease(release.root), /release file mode or ownership is invalid/u);
});

test("release verification enforces exact metadata and directory modes", async () => {
  const { temporary, releases } = await fixture();
  const directoryRelease = await syntheticRelease(releases, "0");
  await chmod(join(directoryRelease.root, "share/deploy"), 0o777);
  await assert.rejects(verifyInstallRelease(directoryRelease.root), /release directory mode or ownership is invalid/u);

  const checksumsRelease = await syntheticRelease(releases, "1");
  await chmod(join(checksumsRelease.root, "checksums.json"), 0o666);
  await assert.rejects(verifyInstallRelease(checksumsRelease.root), /checksum metadata mode or ownership is invalid/u);

  const manifestRelease = await syntheticRelease(releases, "2");
  const manifestDigest = digest(await readFile(join(manifestRelease.root, "manifest.json")));
  const checksumsPath = join(manifestRelease.root, "checksums.json");
  const checksums = JSON.parse(await readFile(checksumsPath, "utf8"));
  checksums.files.find((item) => item.path === "manifest.json").mode = 0o555;
  await chmod(checksumsPath, 0o644);
  await writeFile(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`);
  await chmod(checksumsPath, 0o444);
  await chmod(join(manifestRelease.root, "manifest.json"), 0o555);
  await assert.rejects(verifyInstallRelease(manifestRelease.root, manifestRelease.gitSha, manifestDigest), /release file mode or ownership is invalid/u);

  const linkPath = join(temporary, "release-link");
  await symlink(manifestRelease.root, linkPath);
  await assert.rejects(verifyInstallRelease(linkPath), /direct immutable directory/u);
});

test("unmarked nonempty managed roots are never adopted or modified", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "a");
  await mkdir(paths.dataRoot, { recursive: true });
  const foreign = join(paths.dataRoot, "foreign-owner-data");
  await writeFile(foreign, "preserve\n");
  await assert.rejects(installRelease(paths, systemd.command, release.root), /refusing to adopt a nonempty unmarked managed root/u);
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  await assert.rejects(lstat(join(paths.dataRoot, ".pi-web-managed-v1")), /ENOENT/u);
  assert.equal(await readFile(systemd.log, "utf8").catch(() => ""), "");
});

test("hard-linked release payloads and symlinked managed roots fail closed", async () => {
  const first = await fixture();
  const release = await syntheticRelease(first.releases, "1");
  await chmod(release.root, 0o755);
  await link(join(release.root, "bin/pi-web-browserd.mjs"), join(release.root, "hardlink"));
  await chmod(release.root, 0o555);
  await assert.rejects(verifyInstallRelease(release.root), /mode or ownership is invalid/u);

  const second = await fixture();
  const diverted = join(second.temporary, "diverted-data");
  await mkdir(diverted);
  await mkdir(dirname(second.environment.XDG_DATA_HOME), { recursive: true });
  await symlink(diverted, second.environment.XDG_DATA_HOME, "dir");
  const clean = await syntheticRelease(second.releases, "2");
  await assert.rejects(installRelease(second.paths, second.systemd.command, clean.root), /owner-controlled directory is unsafe/u);
});

test("sealed interrupted release staging resumes without publishing mutable final bytes", async () => {
  const { paths, systemd, releases } = await fixture();
  const source = await syntheticRelease(releases, "8");
  await uninstallCandidate(paths, systemd.command);
  await mkdir(paths.releasesRoot, { recursive: true });
  const stagedSource = await syntheticRelease(paths.releasesRoot, "8");
  const interrupted = join(paths.releasesRoot, `.stage-${source.releaseId}-abcdef123456`);
  await rename(stagedSource.root, interrupted);
  assert.equal((await lstat(interrupted)).mode & 0o777, 0o555);
  await installRelease(paths, systemd.command, source.root);
  await assert.rejects(lstat(interrupted), /ENOENT/u);
  assert.equal((await lstat(join(paths.releasesRoot, source.releaseId))).mode & 0o777, 0o555);
});

test("every installed mutation fences stale qualification services before preparation", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "b");
  const qualificationUnits = unitNames.filter((name) => name.startsWith("pi-web-qualification-"));
  for (const unit of qualificationUnits) await writeFile(join(systemd.state, `${unit}.active`), "");
  const preparationProbe = join(paths.unitRoot, ordinaryUnitNames[0]);
  await writeFile(systemd.qualificationFenceProbe, preparationProbe);
  await assert.rejects(lstat(preparationProbe), /ENOENT/u);
  await installRelease(paths, systemd.command, release.root);
  assert.equal((await lstat(preparationProbe)).isFile(), true, "installation preparation eventually creates the probe unit");
  for (const unit of qualificationUnits) await assert.rejects(lstat(join(systemd.state, `${unit}.active`)), /ENOENT/u);
  const log = await readFile(systemd.log, "utf8");
  for (const unit of qualificationUnits) {
    assert.match(log, new RegExp(`--user stop ${unit.replaceAll(".", "\\.")}`, "u"));
    assert.match(log, new RegExp(`qualification-fence-before-preparation ${unit.replaceAll(".", "\\.")}`, "u"));
  }
  assert.doesNotMatch(log, /qualification-fence-after-preparation/u);
});

test("service activation accepts idempotent nonzero results only when exact probes match", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "2");
  await installRelease(paths, systemd.command, release.root);
  await writeFile(systemd.operationFailure, "--user restart webxd.service\n");
  assert.equal((await installRelease(paths, systemd.command, release.root)).releaseId, release.releaseId, "an idempotent nonzero restart is accepted when enabled and active probes match");
  await writeFile(systemd.operationFailure, "--user enable pi-web-agentcursor-egress-proxy.service\n");
  await assert.rejects(setBackend(paths, systemd.command, "agentcursor"), /candidate service is not enabled: pi-web-agentcursor-egress-proxy\.service/u);
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "legacy");

  const unsupported = await fixture();
  const unsupportedRelease = await syntheticRelease(unsupported.releases, "7");
  await writeFile(unsupported.systemd.operationFailure, "--user enable webxd.service\n");
  await writeFile(unsupported.systemd.staticOnFailedOperation, "static\n");
  await assert.rejects(installRelease(unsupported.paths, unsupported.systemd.command, unsupportedRelease.root), /unsupported enablement state: webxd\.service/u);
});

test("service restore failures keep the transaction recoverable", async () => {
  const { paths, systemd, releases } = await fixture();
  const first = await syntheticRelease(releases, "3");
  const failed = await syntheticRelease(releases, "4");
  await installRelease(paths, systemd.command, first.root);
  await writeFile(systemd.deactivateOnRestart, "fail\n");
  await writeFile(systemd.operationFailure, "--user start webxd.service\n");
  await assert.rejects(installRelease(paths, systemd.command, failed.root), /prior service states could not be restored/u);
  assert.equal(await readlink(paths.currentLink), `../../releases/${first.releaseId}`);
  assert.equal((await lstat(paths.transactionPath)).isFile(), true, "failed service restoration retains the recovery transaction");
  await Promise.all([rm(systemd.failure), rm(systemd.operationFailure), rm(systemd.deactivateOnRestart)]);
  const recovered = await setBackend(paths, systemd.command, "legacy");
  assert.equal(recovered.changed, false);
  assert.deepEqual(JSON.parse(await readFile(paths.recoveryPath, "utf8")), { schemaVersion: 1, operation: "install", recovered: true });
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u);
});

test("post-commit uninstall cleanup never restores a pointer to removed bytes", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "4");
  await installRelease(paths, systemd.command, release.root);
  await mkdir(paths.failurePath);
  await assert.rejects(uninstallCandidate(paths, systemd.command), /EISDIR|directory/u);
  await assert.rejects(lstat(paths.currentLink), /ENOENT/u);
  await assert.rejects(lstat(join(paths.releasesRoot, release.releaseId)), /ENOENT/u);
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u, "the reversible uninstall committed before destructive cleanup");
  await rm(paths.failurePath, { recursive: true });
  const partialResidue = join(paths.releasesRoot, release.releaseId);
  await mkdir(partialResidue, { mode: 0o700 });
  await writeFile(join(partialResidue, "partial"), "interrupted deletion residue\n");
  await writeFile(systemd.operationFailure, "--user disable --now pi-web-agentcursor-egress-proxy.service\n");
  const retryLogStart = (await readFile(systemd.log, "utf8")).length;
  assert.equal((await uninstallCandidate(paths, systemd.command)).legacyPreserved, true, "cleanup failure is retryable");
  await assert.rejects(lstat(partialResidue), /ENOENT/u, "retry removes only allowlisted owner-controlled post-commit residue");
  const retryMutations = (await readFile(systemd.log, "utf8")).slice(retryLogStart).split("\n").filter((line) => line !== "" && !line.includes("pi-web-qualification-"));
  assert.doesNotMatch(retryMutations.join("\n"), /disable --now|\b(?:start|stop|restart|enable|disable)\b/u, "cleanup retry does not mutate restored legacy services");
});

test("stale lock recovery restores the complete prior activation before new work", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "4");
  await installRelease(paths, systemd.command, release.root);
  const legacySnapshot = await activationSnapshot(paths, release.releaseId, undefined);
  await setBackend(paths, systemd.command, "agentcursor");
  await writeFile(paths.transactionPath, `${JSON.stringify({ schemaVersion: 1, operation: "backend", snapshot: legacySnapshot })}\n`, { mode: 0o600 });
  await mkdir(paths.mutationLockPath, { mode: 0o700 });
  await writeFile(join(paths.mutationLockPath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: 99999999, startTicks: "1" })}\n`, { mode: 0o600 });
  const result = await setBackend(paths, systemd.command, "legacy");
  assert.equal(result.changed, false, "recovery runs before the requested mutation");
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).backend, "legacy");
  assert.deepEqual(JSON.parse(await readFile(paths.recoveryPath, "utf8")), { schemaVersion: 1, operation: "backend", recovered: true });
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u);
  await assert.rejects(lstat(paths.mutationLockPath), /ENOENT/u);
});

test("atomic lock publication preserves recent markerless locks and recovers stale legacy residue", async () => {
  const { paths, systemd } = await fixture();
  await uninstallCandidate(paths, systemd.command);
  await mkdir(paths.mutationLockPath, { mode: 0o700 });
  await assert.rejects(uninstallCandidate(paths, systemd.command), /lock identity is not yet available/u);
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.mutationLockPath, old, old);
  assert.equal((await uninstallCandidate(paths, systemd.command)).legacyPreserved, true);
  await assert.rejects(lstat(paths.mutationLockPath), /ENOENT/u);
});

test("preflight rejects a checksum-corrupt installed candidate", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const installed = await syntheticRelease(releases, "4");
  const prospective = await syntheticRelease(releases, "5");
  await installRelease(paths, systemd.command, installed.root);
  const manifest = join(paths.releasesRoot, installed.releaseId, "manifest.json");
  await chmod(manifest, 0o644);
  await writeFile(manifest, "corrupt installed manifest\n");
  await chmod(manifest, 0o444);
  const report = await installationPreflight(paths, systemd.command, prospective.root, prospective.gitSha, digest(await readFile(join(prospective.root, "manifest.json"))), { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    osRelease: "ID=fedora\nVERSION_ID=44\n", architecture: "x64", systemdAvailable: true,
    diskAvailableBytes: 2_000_000_000, runtimeAvailableBytes: 4_000_000_000, nodeVersion: "24.18.0", pythonVersion: "Python 3.14.7",
    missingPackages: [], browser: { product: "Chromium", version: "151.0.0.0" }, portState: "free", serviceConflict: false, destinationConflict: false, runtimeState: "clean",
  });
  assert.equal(report.ok, false);
  assert.equal(report.findings.find((item) => item.category === "existing")?.code, "EXISTING_INSTALL_INVALID");
  assert.doesNotMatch(JSON.stringify(report), /corrupt installed manifest|\/tmp\//u);
});

test("CLI output rejects malformed private configuration without reflection", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "5");
  await installRelease(paths, systemd.command, release.root);
  const script = join(sourceRoot, "scripts/pi-webctl.mjs");
  const invoke = () => spawnSync(process.execPath, [script, "backend", "show", "--json"], { encoding: "utf8", env: { ...process.env, ...environment } });

  await writeFile(paths.configPath, '{"backend":"SECRET_PRIVATE_BACKEND_MARKER"}\n');
  await chmod(paths.configPath, 0o600);
  const semantic = invoke();
  assert.equal(semantic.status, 1);
  assert.equal(semantic.stderr, "");
  assert.equal(JSON.parse(semantic.stdout).error.code, "PI_WEBCTL_FAILED");
  assert.doesNotMatch(semantic.stdout + semantic.stderr, /SECRET_PRIVATE_BACKEND_MARKER|\/tmp\//u);

  await writeFile(paths.configPath, '{"backend":"legacy","token":S3CR3T}\n');
  await chmod(paths.configPath, 0o600);
  const syntax = invoke();
  assert.equal(syntax.status, 1);
  assert.equal(syntax.stderr, "");
  assert.equal(JSON.parse(syntax.stdout).error.code, "PI_WEBCTL_FAILED");
  assert.doesNotMatch(syntax.stdout + syntax.stderr, /S3CR3T|token|\/tmp\//u);
});

test("legacy full-stack uninstaller is fenced while a candidate is managed", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "5");
  await mkdir(paths.unitRoot, { recursive: true });
  const legacyUnit = join(paths.unitRoot, "pi-browserd.service");
  await writeFile(legacyUnit, "legacy-browser-unit\n");
  await installRelease(paths, systemd.command, release.root);
  const result = spawnSync("/usr/bin/bash", [join(sourceRoot, "uninstall-fedora.sh")], { encoding: "utf8", env: { ...process.env, ...environment } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing destructive legacy\/full-stack removal/u);
  assert.equal(await readFile(legacyUnit, "utf8"), "legacy-browser-unit\n");
});

test("doctor emits fixed classified findings without secrets or absolute managed paths", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "5");
  await installRelease(paths, systemd.command, release.root);
  const report = await doctorReport(paths, systemd.command, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    browser: async () => ({ product: "Chromium", version: "140.0.0.0" }),
    authority: async () => ({ apiVersion: "3.0.0", capabilities: [
      { id: "search", enabled: true, healthy: true, reason: "SECRET_REASON_MARKER" },
      { id: "read", enabled: true, healthy: true },
      { id: "browser", enabled: false, healthy: false, reason: "PRIVATE_PROFILE_MARKER" },
    ] }),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((item) => item.category), ["release", "filesystem", "services", "display", "browser", "egress", "authority", "resource", "workspace"]);
  assert.deepEqual(new Set(report.findings.map((item) => item.status)), new Set(["pass", "not-tested"]));
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SECRET_REASON_MARKER|PRIVATE_PROFILE_MARKER|bindingSecret|socketPath|profile|\/tmp\//u);
  assert.equal(report.findings.find((item) => item.category === "egress")?.code, "EGRESS_NOT_SELECTED");

  await setBackend(paths, systemd.command, "agentcursor");
  const candidate = await doctorReport(paths, systemd.command, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    browser: async () => ({ product: "Chromium", version: "140.0.0.0" }),
    proxy: async () => "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n",
    authority: async () => ({ apiVersion: "3.0.0", capabilities: [{ id: "search", enabled: true, healthy: true }, { id: "read", enabled: true, healthy: true }] }),
    resources: async () => ({ state: "normal", supervisedSessions: 0, warningSessions: 0, limitedSessions: 0, terminalLimitEvents: 0, lastTerminalReason: "none" }),
  });
  assert.equal(candidate.findings.find((item) => item.category === "egress")?.status, "pass");
  assert.equal(candidate.findings.find((item) => item.category === "resource")?.code, "RESOURCE_SUPERVISION_HEALTHY");

  const hostileBrowser = await doctorReport(paths, systemd.command, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    browser: async () => ({ product: "SECRET_BROWSER_PRODUCT", version: "140.0.0.0-SECRET_BROWSER_VERSION" }),
    proxy: async () => "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n",
    authority: async () => ({ apiVersion: "3.0.0", capabilities: [{ id: "search", enabled: true, healthy: true }, { id: "read", enabled: true, healthy: true }] }),
    resources: async () => ({ state: "normal", supervisedSessions: 0, warningSessions: 0, limitedSessions: 0, terminalLimitEvents: 0, lastTerminalReason: "none" }),
  });
  assert.equal(hostileBrowser.findings.find((item) => item.category === "browser")?.code, "BROWSER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(hostileBrowser), /SECRET_BROWSER_PRODUCT|SECRET_BROWSER_VERSION/u);

  const hostileResources = await doctorReport(paths, systemd.command, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    browser: async () => ({ product: "Chromium", version: "140.0.0.0" }),
    proxy: async () => "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n",
    authority: async () => ({ apiVersion: "3.0.0", capabilities: [{ id: "search", enabled: true, healthy: true }, { id: "read", enabled: true, healthy: true }] }),
    resources: async () => ({ state: "SECRET_RESOURCE_STATE", profilePath: "/tmp/SECRET_PROFILE", rawError: "SECRET_RESOURCE_ERROR" }),
  });
  assert.equal(hostileResources.findings.find((item) => item.category === "resource")?.code, "RESOURCE_SUPERVISION_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(hostileResources), /SECRET_RESOURCE_STATE|SECRET_PROFILE|SECRET_RESOURCE_ERROR|\/tmp\//u);
});

test("doctor converts corruption and missing display into controlled classifications", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "6");
  await installRelease(paths, systemd.command, release.root);
  const manifest = join(paths.releasesRoot, release.releaseId, "manifest.json");
  await chmod(manifest, 0o644); await writeFile(manifest, "CORRUPT_PRIVATE_MARKER\n"); await chmod(manifest, 0o444);
  const report = await doctorReport(paths, systemd.command, environment, { browser: async () => undefined, authority: async () => { throw new Error("SECRET_AUTHORITY_MARKER"); } });
  assert.equal(report.ok, false);
  assert.equal(report.findings.find((item) => item.category === "release")?.code, "RELEASE_INVALID");
  assert.equal(report.findings.find((item) => item.category === "display")?.status, "unavailable");
  assert.equal(report.findings.find((item) => item.category === "authority")?.code, "AUTHORITY_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(report), /CORRUPT_PRIVATE_MARKER|SECRET_AUTHORITY_MARKER|\/tmp\//u);
});

test("installed qualification is exact, private, static, and restores ordinary services", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "2");
  await installRelease(paths, systemd.command, release.root);
  const manifestSha256 = digest(await readFile(join(release.root, "manifest.json")));
  await assert.rejects(
    qualifyInstalled(paths, systemd.command, "acceptance", release.gitSha, manifestSha256, environment, { ports: async () => undefined }),
    /explicit AgentCursor backend/u,
  );
  await setBackend(paths, systemd.command, "agentcursor");
  const interruptedSnapshot = await activationSnapshot(paths, release.releaseId, undefined);
  await mkdir(paths.qualificationRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.qualificationRoot, "interrupted-private-state"), "discard\n", { mode: 0o600 });
  await writeFile(paths.transactionPath, `${JSON.stringify({ schemaVersion: 1, operation: "qualify", snapshot: interruptedSnapshot })}\n`, { mode: 0o600 });

  let proxyCalls = 0;
  let workloadCalls = 0;
  let closeCalls = 0;
  const result = await qualifyInstalled(paths, systemd.command, "acceptance", release.gitSha, manifestSha256, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private", SECRET_QUALIFICATION_MARKER: "must-not-cross" }, {
    ports: async () => undefined,
    proxy: async () => {
      proxyCalls += 1;
      if (proxyCalls < 3) throw new Error("qualification proxy is still starting");
      return "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n";
    },
    workload: async (childEnvironment, verified, mode) => {
      workloadCalls += 1;
      assert.equal(mode, "acceptance");
      assert.equal(verified.gitSha, release.gitSha);
      assert.equal(childEnvironment.PI_WEB_QUALIFICATION_RELEASE_ID, release.releaseId);
      assert.equal(childEnvironment.PI_WEB_QUALIFICATION_GIT_SHA, release.gitSha);
      assert.equal(childEnvironment.PI_WEB_QUALIFICATION_MANIFEST_SHA256, manifestSha256);
      assert.equal(childEnvironment.WEBX_BROWSER_BACKEND, "agentcursor");
      assert.equal(childEnvironment.WEBX_SEARX_URL, "http://127.0.0.1:18878");
      assert.equal(childEnvironment.WEBX_READER_URL, "http://127.0.0.1:18878");
      assert.equal(childEnvironment.SECRET_QUALIFICATION_MARKER, undefined);
      const leaseInformation = await lstat(paths.qualificationLeasePath);
      const environmentInformation = await lstat(paths.qualificationEnvironmentPath);
      assert.equal(leaseInformation.mode & 0o777, 0o600);
      assert.equal(environmentInformation.mode & 0o777, 0o600);
      assert.equal(leaseInformation.nlink, 1);
      const lease = JSON.parse(await readFile(paths.qualificationLeasePath, "utf8"));
      assert.deepEqual(lease, { schemaVersion: 1, releaseId: release.releaseId, gitSha: release.gitSha, manifestSha256 });
      return { schemaVersion: 1, ok: true, mode, releaseId: release.releaseId, gitSha: release.gitSha, manifestSha256, durationSeconds: 1, summary: { checks: { installed: true, private: true }, actors: 2 } };
    },
    closeWorkspace: (childEnvironment, executable) => {
      closeCalls += 1;
      assert.equal(childEnvironment.SECRET_QUALIFICATION_MARKER, undefined);
      assert.equal(executable, join(paths.releasesRoot, release.releaseId, "bin/pi-browser-workspace-qualification"));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(proxyCalls, 3);
  assert.equal(workloadCalls, 1);
  assert.equal(closeCalls, 1);
  await assert.rejects(lstat(paths.qualificationRoot), /ENOENT/u);
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u);
  assert.deepEqual(JSON.parse(await readFile(paths.recoveryPath, "utf8")), { schemaVersion: 1, operation: "qualify", recovered: true });
  for (const unit of ordinaryUnitNames) {
    assert.equal(await readFile(join(systemd.state, `${unit}.active`), "utf8"), "");
    assert.equal(await readFile(join(systemd.state, `${unit}.enabled`), "utf8"), "");
  }
  for (const unit of unitNames.slice(ordinaryUnitNames.length)) {
    await assert.rejects(lstat(join(systemd.state, `${unit}.active`)), /ENOENT/u);
    await assert.rejects(lstat(join(systemd.state, `${unit}.enabled`)), /ENOENT/u);
  }
  const systemctlLog = await readFile(systemd.log, "utf8");
  assert.match(systemctlLog, /--user start pi-web-qualification-egress-proxy\.service/u);
  assert.doesNotMatch(systemctlLog, /--user enable(?: --now)? pi-web-qualification/u);
});

test("qualification failure removes private runtime and restores the exact activation", async () => {
  const { paths, systemd, releases, environment } = await fixture();
  const release = await syntheticRelease(releases, "1");
  await installRelease(paths, systemd.command, release.root);
  await setBackend(paths, systemd.command, "agentcursor");
  const manifestSha256 = digest(await readFile(join(release.root, "manifest.json")));
  await assert.rejects(qualifyInstalled(paths, systemd.command, "acceptance", release.gitSha, manifestSha256, environment, {
    ports: async () => undefined,
    proxy: async () => "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n",
    workload: async () => { throw new Error("PRIVATE_WORKLOAD_FAILURE"); },
    closeWorkspace: () => undefined,
  }), /PRIVATE_WORKLOAD_FAILURE/u);
  await assert.rejects(lstat(paths.qualificationRoot), /ENOENT/u);
  await assert.rejects(lstat(paths.transactionPath), /ENOENT/u);
  for (const unit of ordinaryUnitNames) {
    assert.equal(await lstat(join(systemd.state, `${unit}.active`)).then(() => true), true);
    assert.equal(await lstat(join(systemd.state, `${unit}.enabled`)).then(() => true), true);
  }
  for (const unit of unitNames.slice(ordinaryUnitNames.length)) await assert.rejects(lstat(join(systemd.state, `${unit}.active`)), /ENOENT/u);
});

test("live mutation locks reject concurrent control and purge stays allowlisted", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "3");
  await installRelease(paths, systemd.command, release.root);
  const keyInformation = await lstat(paths.mutationLockKeyPath);
  assert.equal(keyInformation.mode & 0o777, 0o600);
  assert.equal(keyInformation.uid, process.getuid?.());
  assert.equal(keyInformation.gid, process.getgid?.());
  const authority = createServer();
  const authorityName = `\0pi-webctl-${digest(await readFile(paths.mutationLockKeyPath))}`;
  await new Promise((resolvePromise, rejectPromise) => {
    authority.once("error", rejectPromise);
    authority.listen(authorityName, () => resolvePromise(undefined));
  });
  await assert.rejects(setBackend(paths, systemd.command, "agentcursor"), /another pi-webctl mutation is in progress/u);
  await new Promise((resolvePromise) => authority.close(resolvePromise));
  const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
  await mkdir(paths.mutationLockPath, { mode: 0o700 });
  await writeFile(join(paths.mutationLockPath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: process.pid, startTicks })}\n`, { mode: 0o600 });
  await assert.rejects(setBackend(paths, systemd.command, "agentcursor"), /another pi-webctl mutation is in progress/u);
  await rm(paths.mutationLockPath, { recursive: true });
  const result = await uninstallCandidate(paths, systemd.command, true);
  assert.equal(result.purged, true);
  await assert.rejects(lstat(paths.dataRoot), /ENOENT/u);
  await assert.rejects(lstat(paths.stateRoot), /ENOENT/u);
});
