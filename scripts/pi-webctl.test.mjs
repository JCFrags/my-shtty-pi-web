import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
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
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    gitSha,
    dirtyTree: false,
    backendDefault: "legacy",
    compatibility: { defaultBackend: "legacy", candidateBackend: "agentcursor" },
    immutableFiles,
  }, null, 2)}\n`);
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
  await Promise.all([mkdir(home, { recursive: true }), mkdir(environment.XDG_RUNTIME_DIR, { recursive: true })]);
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
  assert.equal(await readlink(paths.currentLink), `releases/${release.releaseId}`);
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
  assert.equal(await readlink(paths.currentLink), `releases/${second.releaseId}`);
  assert.equal(await readlink(paths.previousLink), `releases/${first.releaseId}`);

  const rolledBack = await rollbackRelease(paths, systemd.command);
  assert.equal(rolledBack.releaseId, first.releaseId);
  assert.equal(rolledBack.backend, "agentcursor");
  assert.equal(await readlink(paths.currentLink), `releases/${first.releaseId}`);
  assert.equal(await readlink(paths.previousLink), `releases/${second.releaseId}`);

  await writeFile(systemd.failure, "fail\n");
  await assert.rejects(installRelease(paths, systemd.command, third.root), /candidate service is not active: webxd\.service/u);
  assert.equal(await readlink(paths.currentLink), `releases/${first.releaseId}`, "failed activation restores the exact current release");
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
