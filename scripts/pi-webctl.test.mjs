import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  doctorReport,
  installRelease,
  installedPaths,
  rollbackRelease,
  setBackend,
  uninstallCandidate,
  verifyInstallRelease,
} from "./pi-webctl.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitNames = ["pi-web-agentcursor-egress-proxy.service", "pi-web-agentcursor-browserd.service", "webxd.service"];
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
    artifacts: { binary: "bin/pi-browser-workspace", rpm: "share/artifacts/pi-browser-workspace.rpm" },
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

async function syntheticRelease(parent, character) {
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
    writeFile(join(root, "bin/pi-browser-workspace"), "workspace fixture\n"),
    copyFile(join(sourceRoot, "scripts/pi-webctl.mjs"), join(root, "bin/pi-webctl.mjs")),
    copyFile(join(sourceRoot, "scripts/phase4a-release-format.mjs"), join(root, "bin/phase4a-release-format.mjs")),
    writeFile(join(root, "share/artifacts/pi-browser-workspace.rpm"), "rpm fixture\n"),
    copyFile(join(sourceRoot, "scripts/phase4a-config.mjs"), join(root, "share/deploy/phase4a-config.mjs")),
    copyFile(join(sourceRoot, "deploy/phase4a/config/default.json"), join(root, "share/deploy/config/default.json")),
    writeFile(join(root, "share/icons/pi-web-workspace.png"), "png fixture\n"),
    writeFile(join(root, "share/pi-webx/extension.mjs"), "export default function extension() {}\n"),
    ...unitNames.map((name) => copyFile(join(sourceRoot, `deploy/phase4a/systemd/${name}.in`), join(root, `share/deploy/systemd/${name}.in`))),
  ]);
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
  await writeFile(command, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in\n  '--user is-active --quiet webxd.service') [[ ! -f "${failure}" ]]; exit ;;\n  '--user is-active --quiet '*) exit 0 ;;\n  '--user is-enabled --quiet '*) exit 0 ;;\nesac\nexit 0\n`);
  await chmod(command, 0o755);
  return { command, log, failure };
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
    managed: Object.fromEntries(await Promise.all(managedPaths.map(async (path) => [path, await savedPath(path)]))),
    services: Object.fromEntries(unitNames.map((name) => [name, { active: true, enabled: true }])),
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

test("verified install is legacy-default, immutable, direct-launching, and preserves the legacy unit", async () => {
  const { paths, systemd, releases } = await fixture();
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
  const environment = await readFile(paths.environmentPath, "utf8");
  assert.match(environment, /^PI_WEB_EGRESS_HOST="127\.0\.0\.1"$/mu);
  assert.match(environment, /^PI_WEB_EGRESS_PORT="8877"$/mu);
  const webxd = await readFile(join(paths.unitRoot, "webxd.service"), "utf8");
  assert.match(webxd, /Wants=.*pi-browserd\.service/u);
  assert.doesNotMatch(webxd, /pi-web-agentcursor-browserd\.service/u);
  assert.doesNotMatch(webxd, /Projects\/|node_modules|tsx|vite/u);
  assert.equal(await readFile(join(paths.unitRoot, "pi-browserd.service"), "utf8"), "legacy-browser-unit\n");
  assert.equal(await readlink(paths.controlLink), join(paths.currentLink, "bin/pi-webctl.mjs"));
  assert.equal(await readlink(paths.extensionPath), join(paths.currentLink, "share/pi-webx"));
  const desktop = await readFile(paths.desktopPath, "utf8");
  assert.match(desktop, /^Exec=".*\/current\/bin\/pi-browser-workspace"$/mu);
  assert.doesNotMatch(desktop, /\/bin\/(?:ba)?sh|--debug|vite/u);
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

test("checksum corruption is refused before activation", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "e");
  const browserd = join(release.root, "bin/pi-web-browserd.mjs");
  await chmod(release.root, 0o755); await chmod(browserd, 0o755); await writeFile(browserd, "tampered\n"); await chmod(browserd, 0o555); await chmod(release.root, 0o555);
  await assert.rejects(verifyInstallRelease(release.root), /release checksum failed/u);
  await assert.rejects(installRelease(paths, systemd.command, release.root), /release checksum failed/u);
  await assert.rejects(lstat(paths.currentLink), /ENOENT/u);
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
  assert.deepEqual(new Set(report.findings.map((item) => item.status)), new Set(["pass", "warning", "not-tested"]));
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SECRET_REASON_MARKER|PRIVATE_PROFILE_MARKER|bindingSecret|socketPath|profile|\/tmp\//u);
  assert.equal(report.findings.find((item) => item.category === "egress")?.code, "EGRESS_NOT_SELECTED");

  await setBackend(paths, systemd.command, "agentcursor");
  const candidate = await doctorReport(paths, systemd.command, { ...environment, WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=private" }, {
    browser: async () => ({ product: "Chromium", version: "140.0.0.0" }),
    proxy: async () => "HTTP/1.1 204 No Content\r\nWebX-Egress-Proxy: secure-egress/1\r\nContent-Length: 0\r\n\r\n",
    authority: async () => ({ apiVersion: "3.0.0", capabilities: [{ id: "search", enabled: true, healthy: true }, { id: "read", enabled: true, healthy: true }] }),
  });
  assert.equal(candidate.findings.find((item) => item.category === "egress")?.status, "pass");
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

test("live mutation locks reject concurrent control and purge stays allowlisted", async () => {
  const { paths, systemd, releases } = await fixture();
  const release = await syntheticRelease(releases, "3");
  await installRelease(paths, systemd.command, release.root);
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
