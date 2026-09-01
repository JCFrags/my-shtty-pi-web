#!/usr/bin/env node
// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseChecksums, validateReleaseManifest } from "./phase4a-release-format.mjs";

const UNITS = Object.freeze([
  "pi-web-agentcursor-egress-proxy.service",
  "pi-web-agentcursor-browserd.service",
  "webxd.service",
]);
const MARKER_NAME = ".pi-web-managed-v1";
const MARKER_VALUE = "pi-web-managed-root-v1\n";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const LOCK_PUBLICATION_GRACE_MS = 5_000;
const PREFLIGHT_PACKAGES = Object.freeze(["chromium", "desktop-file-utils", "gtk3", "libappindicator-gtk3", "librsvg2", "nodejs", "python3", "systemd", "webkit2gtk4.1"]);
const MINIMUM_INSTALL_FREE_BYTES = 512 * 1024 * 1024;

/** @param {string} message @returns {never} */
function fail(message) { throw new Error(message); }
/** @param {string | NodeJS.ArrayBufferView} value */
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
/** @param {unknown} value @param {string} name */
function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  return /** @type {Record<string, any>} */ (value);
}
/** @param {string} path */
async function readJson(path) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_JSON_BYTES) fail("JSON document is unsafe");
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { fail("JSON document is invalid"); }
}
/** @param {string} path */
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

/** @param {string} root */
async function regularFiles(root) {
  /** @type {string[]} */
  const pending = [root];
  /** @type {string[]} */
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) fail("release traversal lost its directory");
    const information = await lstat(directory);
    if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || (information.mode & 0o777) !== 0o555) fail("release directory mode or ownership is invalid");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else fail(`release contains a non-regular entry: ${relative(root, path)}`);
    }
  }
  return files.sort();
}

/**
 * Verify a release without importing code from the source checkout.
 * @param {string} releaseRootValue
 * @param {string | undefined} expectedSha
 * @param {string | undefined} expectedManifestSha256
 */
export async function verifyInstallRelease(releaseRootValue, expectedSha = undefined, expectedManifestSha256 = undefined) {
  if (!isAbsolute(releaseRootValue)) fail("release root must be absolute");
  const suppliedInformation = await lstat(releaseRootValue);
  if (!suppliedInformation.isDirectory() || suppliedInformation.isSymbolicLink()) fail("release root must be a direct immutable directory");
  const releaseRoot = await realpath(releaseRootValue);
  const rootInformation = await lstat(releaseRoot);
  if (releaseRoot !== resolve(releaseRootValue) || !rootInformation.isDirectory() || rootInformation.isSymbolicLink() || rootInformation.uid !== process.getuid?.() || (rootInformation.mode & 0o777) !== 0o555) fail("release root must be an owner-controlled immutable regular directory");
  const actualFiles = await regularFiles(releaseRoot);
  const manifest = validateReleaseManifest(await readJson(join(releaseRoot, "manifest.json")));
  if (basename(releaseRoot) !== manifest.releaseId) fail("release directory does not match manifest identity");
  if (expectedSha !== undefined && manifest.gitSha !== expectedSha) fail("release Git SHA does not match the requested SHA");
  const checksumsPath = join(releaseRoot, "checksums.json");
  const checksumsInformation = await lstat(checksumsPath);
  if (!checksumsInformation.isFile() || checksumsInformation.isSymbolicLink() || checksumsInformation.nlink !== 1 || checksumsInformation.uid !== process.getuid?.() || (checksumsInformation.mode & 0o777) !== 0o444) fail("release checksum metadata mode or ownership is invalid");
  const checksums = validateReleaseChecksums(await readJson(checksumsPath));
  const listed = new Set();
  for (const item of checksums.files) {
    listed.add(item.path);
    const path = join(releaseRoot, item.path);
    const information = await lstat(path);
    const expectedMode = item.path.startsWith("bin/") ? 0o555 : 0o444;
    if (item.mode !== expectedMode || !information.isFile() || information.isSymbolicLink() || information.nlink !== 1 || information.uid !== process.getuid?.() || (information.mode & 0o777) !== expectedMode) fail(`release file mode or ownership is invalid: ${item.path}`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256) fail(`release checksum failed: ${item.path}`);
  }
  const actual = actualFiles.map((path) => relative(releaseRoot, path).replaceAll(sep, "/")).filter((path) => path !== "checksums.json");
  if (JSON.stringify([...listed].sort()) !== JSON.stringify(actual.sort())) fail("release checksum inventory is incomplete");
  for (const required of [
    "bin/pi-web-browserd.mjs",
    "bin/pi-web-webxd.mjs",
    "bin/pi-web-egress-proxy",
    "bin/pi-browser-workspace",
    "bin/phase4a-release-format.mjs",
    "share/pi-webx/extension.mjs",
    "share/deploy/phase4a-config.mjs",
    "share/deploy/config/default.json",
    ...UNITS.map((name) => `share/deploy/systemd/${name}.in`),
  ]) if (!listed.has(required)) fail(`release is missing required installed file: ${required}`);
  for (const artifact of Object.values(manifest.artifacts)) if (typeof artifact !== "string" || !listed.has(artifact)) fail("release manifest artifact is missing from the checksum inventory");
  const immutableFiles = [];
  for (const item of checksums.files) if (item.path !== "manifest.json") immutableFiles.push({ path: item.path, sha256: item.sha256, bytes: item.bytes });
  if (JSON.stringify(manifest.immutableFiles) !== JSON.stringify(immutableFiles)) fail("release manifest payload digest inventory is invalid");
  const manifestSha256 = sha256(await readFile(join(releaseRoot, "manifest.json")));
  if (expectedManifestSha256 !== undefined && (!/^[0-9a-f]{64}$/u.test(expectedManifestSha256) || manifestSha256 !== expectedManifestSha256)) fail("release manifest digest does not match the requested digest");
  return Object.freeze({ releaseRoot, releaseId: manifest.releaseId, gitSha: manifest.gitSha, manifest, manifestSha256 });
}

/** @param {string} root */
async function removeOwnedTree(root) {
  let information;
  try { information = await lstat(root); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (!information.isDirectory() || information.isSymbolicLink()) { await rm(root, { force: true }); return; }
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) fail("owned-tree traversal lost its directory");
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(directory, entry.name));
  }
  await rm(root, { recursive: true, force: true });
}

/** @param {string} source @param {string} destination */
async function copyReleaseTree(source, destination) {
  const information = await lstat(source);
  if (!information.isDirectory() || information.isSymbolicLink()) fail("release copy source is unsafe");
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyReleaseTree(from, to);
    else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, (await lstat(from)).mode & 0o777);
    } else fail(`release copy contains a non-regular entry: ${entry.name}`);
  }
  await chmod(destination, information.mode & 0o777);
}

/** @param {string} path @param {number} mode */
async function ensureOwnedDirectory(path, mode) {
  await mkdir(path, { recursive: true, mode });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || await realpath(path) !== resolve(path) || (information.mode & 0o022) !== 0) fail(`owner-controlled directory is unsafe: ${path}`);
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function ensureManagedRoots(paths) {
  for (const root of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.stateRoot]) {
    const existed = await exists(root);
    if (existed) {
      const before = await lstat(root);
      if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || await realpath(root) !== resolve(root) || (before.mode & 0o022) !== 0) fail(`managed root is unsafe: ${root}`);
      const marker = join(root, MARKER_NAME);
      if (!(await exists(marker)) && (await readdir(root)).length > 0) fail(`refusing to adopt a nonempty unmarked managed root: ${root}`);
    }
    await ensureOwnedDirectory(root, 0o700);
    await chmod(root, 0o700);
    const marker = join(root, MARKER_NAME);
    if (await exists(marker)) {
      const markerInformation = await lstat(marker);
      if (!markerInformation.isFile() || markerInformation.isSymbolicLink() || markerInformation.uid !== process.getuid?.() || markerInformation.nlink !== 1 || (markerInformation.mode & 0o777) !== 0o600 || await readFile(marker, "utf8") !== MARKER_VALUE) fail(`managed root marker is invalid: ${root}`);
    } else await atomicWrite(marker, MARKER_VALUE, 0o600);
  }
  await ensureOwnedDirectory(paths.releasesRoot, 0o700);
  await ensureOwnedDirectory(paths.selectorsRoot, 0o700);
  await ensureOwnedDirectory(paths.unitRoot, 0o700);
  await ensureOwnedDirectory(paths.binRoot, 0o755);
  await ensureOwnedDirectory(paths.applicationRoot, 0o755);
  await ensureOwnedDirectory(dirname(paths.extensionPath), 0o700);
}

/** @param {string} path @param {string | Buffer} value @param {number} mode */
async function atomicWrite(path, value, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(temporary, value, { mode, flag: "wx" });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
/** @param {string} path @param {unknown} value */
async function atomicJson(path, value) { await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, 0o600); }
/** @param {string} path @param {string | undefined} target */
async function atomicLink(path, target) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (target === undefined) { await rm(path, { force: true }); return; }
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await symlink(target, temporary);
  await rename(temporary, path);
}

/** @param {string} path */
async function snapshotPath(path) {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
    if (information.isFile()) return { kind: "file", mode: information.mode & 0o777, dataBase64: (await readFile(path)).toString("base64") };
    fail(`managed path is not a regular file or symlink: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}
/** @param {string} path @param {Record<string, any>} snapshot */
async function restorePath(path, snapshot) {
  if (snapshot.kind === "missing") { await rm(path, { force: true }); return; }
  if (snapshot.kind === "symlink" && typeof snapshot.target === "string") { await atomicLink(path, snapshot.target); return; }
  if (snapshot.kind === "file" && Number.isSafeInteger(snapshot.mode) && typeof snapshot.dataBase64 === "string") { await atomicWrite(path, Buffer.from(snapshot.dataBase64, "base64"), snapshot.mode); return; }
  fail("managed path snapshot is invalid");
}

/** @param {ReturnType<typeof installedPaths>} paths */
function managedPaths(paths) {
  return [
    ...UNITS.map((name) => join(paths.unitRoot, name)),
    paths.environmentPath,
    paths.desktopPath,
    paths.extensionPath,
    paths.controlLink,
    paths.workspaceLink,
  ];
}

/** @param {string} command @param {string[]} arguments_ @param {boolean} check */
function systemctl(command, arguments_, check = true) {
  if (!isAbsolute(command)) fail("systemctl executable must be an absolute reviewed path");
  const env = {
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  const result = spawnSync(command, ["--user", ...arguments_], { encoding: "utf8", env });
  if (result.error) fail("the reviewed user service controller could not be executed");
  if (check && result.status !== 0) fail(`user service operation failed: ${arguments_[0] ?? "unknown"}`);
  return result;
}
/** @param {string} command */
function serviceStates(command) {
  return Object.fromEntries(UNITS.map((unit) => [unit, {
    active: systemctl(command, ["is-active", "--quiet", unit], false).status === 0,
    enabled: systemctl(command, ["is-enabled", "--quiet", unit], false).status === 0,
  }]));
}
/** @param {string} command @param {Record<string, any>} states */
function restoreServiceStates(command, states) {
  if (JSON.stringify(Object.keys(states).sort()) !== JSON.stringify([...UNITS].sort())) fail("service snapshot unit set is invalid");
  let failed = false;
  for (const [unit, stateValue] of Object.entries(states)) {
    const state = record(stateValue, "service state");
    systemctl(command, [state.enabled ? "enable" : "disable", unit], false);
    if ((systemctl(command, ["is-enabled", "--quiet", unit], false).status === 0) !== state.enabled) failed = true;
    systemctl(command, [state.active ? "start" : "stop", unit], false);
    if ((systemctl(command, ["is-active", "--quiet", unit], false).status === 0) !== state.active) failed = true;
  }
  if (failed) fail("one or more prior service states could not be restored");
}
/** @param {string} command @param {string} unit */
function activateService(command, unit) {
  systemctl(command, ["enable", unit], false);
  systemctl(command, ["restart", unit], false);
  if (systemctl(command, ["is-enabled", "--quiet", unit], false).status !== 0) fail(`candidate service is not enabled: ${unit}`);
  if (systemctl(command, ["is-active", "--quiet", unit], false).status !== 0) fail(`candidate service is not active: ${unit}`);
}
/** @param {string} command @param {string} unit */
function deactivateService(command, unit) {
  systemctl(command, ["disable", "--now", unit], false);
  if (systemctl(command, ["is-enabled", "--quiet", unit], false).status === 0) fail(`candidate service is not disabled: ${unit}`);
  if (systemctl(command, ["is-active", "--quiet", unit], false).status === 0) fail(`candidate service is not inactive: ${unit}`);
}

/** @param {string} value */
function desktopArgument(value) {
  if (/[%\0\r\n]/u.test(value)) fail("desktop executable path contains an unsafe byte");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Render and validate every prospective mutable installation byte without
 * changing selectors, managed files, or services.
 * @param {ReturnType<typeof installedPaths>} paths
 * @param {string} releaseRoot
 * @param {Record<string, any>} config
 */
async function prepareInstallation(paths, releaseRoot, config) {
  const modulePath = join(releaseRoot, "share/deploy/phase4a-config.mjs");
  const installedConfig = /** @type {any} */ (await import(`${pathToFileURL(modulePath).href}?release=${encodeURIComponent(basename(releaseRoot))}`));
  let parsed;
  try { parsed = installedConfig.parseInstalledConfig(config); }
  catch { fail("installed configuration is invalid"); }
  const environment = installedConfig.serializeEnvironmentFile(installedConfig.serviceEnvironment(parsed, { releaseRoot: paths.currentLink, runtimeRoot: paths.runtimeRoot }));
  if (Buffer.byteLength(environment) > 65_536 || /[\0\r]/u.test(environment)) fail("prospective service environment is invalid");
  /** @type {Record<string, string>} */
  const units = {};
  for (const name of UNITS) {
    const template = await readFile(join(releaseRoot, `share/deploy/systemd/${name}.in`), "utf8");
    const rendered = installedConfig.renderUnitTemplate(template, {
      currentRelease: paths.currentLink,
      configHome: paths.configHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      browserdUnit: parsed.backend === "agentcursor" ? "pi-web-agentcursor-browserd.service" : "pi-browserd.service",
      startTimeoutSec: parsed.services.startTimeoutSec,
      stopTimeoutSec: parsed.services.stopTimeoutSec,
    });
    if (Buffer.byteLength(rendered) > 131_072 || /[\0\r]/u.test(rendered) || /@[A-Z][A-Z0-9_]*@/u.test(rendered) || !/^\[Unit\]$/mu.test(rendered) || !/^\[Service\]$/mu.test(rendered) || !/^ExecStart=\/(?:usr\/bin\/(?:node|python3) )?[^\n]+$/mu.test(rendered) || /(?:\/bin\/(?:ba)?sh|node_modules|tsx|vite|Projects\/)/u.test(rendered)) fail(`prospective unit is invalid: ${name}`);
    units[name] = rendered;
  }
  const desktop = `[Desktop Entry]\nType=Application\nName=Pi Web Workspace\nComment=Trusted local screenshot workspace\nExec=${desktopArgument(join(paths.currentLink, "bin/pi-browser-workspace"))}\nIcon=${join(paths.currentLink, "share/icons/pi-web-workspace.png")}\nTerminal=false\nCategories=Development;Utility;\nStartupNotify=true\nX-Pi-Web-Release=${basename(releaseRoot)}\n`;
  if (Buffer.byteLength(desktop) > 16_384 || /[\0\r]/u.test(desktop) || !/^Exec="[^"]+\/active\/current\/bin\/pi-browser-workspace"$/mu.test(desktop) || /(?:\/bin\/(?:ba)?sh|node_modules|tsx|vite|Projects\/)/u.test(desktop)) fail("prospective desktop entry is invalid");
  return Object.freeze({ parsed, environment, units: Object.freeze(units), desktop });
}

/** @param {ReturnType<typeof installedPaths>} paths @param {Awaited<ReturnType<typeof prepareInstallation>>} prepared */
async function applyInstallation(paths, prepared) {
  await atomicWrite(paths.environmentPath, prepared.environment, 0o600);
  for (const name of UNITS) await atomicWrite(join(paths.unitRoot, name), prepared.units[name], 0o644);
  await atomicLink(paths.extensionPath, join(paths.currentLink, "share/pi-webx"));
  await atomicLink(paths.controlLink, join(paths.currentLink, "bin/pi-webctl.mjs"));
  await atomicLink(paths.workspaceLink, join(paths.currentLink, "bin/pi-browser-workspace"));
  await atomicWrite(paths.desktopPath, prepared.desktop, 0o644);
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} releaseSource @param {string | undefined} expectedSha @param {string | undefined} expectedManifestSha256 */
async function stageRelease(paths, releaseSource, expectedSha = undefined, expectedManifestSha256 = undefined) {
  const verified = await verifyInstallRelease(releaseSource, expectedSha, expectedManifestSha256);
  const destination = join(paths.releasesRoot, verified.releaseId);
  if (await exists(destination)) {
    const installed = await verifyInstallRelease(destination, verified.gitSha, verified.manifestSha256);
    if (installed.releaseId !== verified.releaseId) fail("installed release identity conflicts with staged release");
    return installed;
  }
  const stageParent = join(paths.releasesRoot, `.stage-${process.pid}-${randomBytes(6).toString("hex")}`);
  const temporary = join(stageParent, verified.releaseId);
  await mkdir(stageParent, { mode: 0o700 });
  await copyReleaseTree(verified.releaseRoot, temporary);
  await verifyInstallRelease(temporary, verified.gitSha, verified.manifestSha256).catch(async (error) => { await removeOwnedTree(stageParent); throw error; });
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  await chmod(destination, 0o555);
  await rm(stageParent, { recursive: true, force: true });
  return await verifyInstallRelease(destination, verified.gitSha, verified.manifestSha256);
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function releasePointers(paths) {
  try {
    const activeInformation = await lstat(paths.activeSelectorLink);
    if (!activeInformation.isSymbolicLink()) fail("active release selector is not a symbolic link");
    const activeTarget = await readlink(paths.activeSelectorLink);
    const selectorMatch = /^selectors\/(selector-[0-9a-f]{24})$/u.exec(activeTarget);
    if (!selectorMatch) fail("active release selector target is invalid");
    const selectorRoot = join(paths.selectorsRoot, selectorMatch[1]);
    const selectorInformation = await lstat(selectorRoot);
    if (!selectorInformation.isDirectory() || selectorInformation.isSymbolicLink() || selectorInformation.uid !== process.getuid?.() || (selectorInformation.mode & 0o077) !== 0) fail("active release selector is unsafe");
    /** @param {string} path @param {string} name */
    const readPointer = async (path, name) => {
      try {
        const information = await lstat(path);
        if (!information.isSymbolicLink()) fail(`${name} release pointer is not a symbolic link`);
        const target = await readlink(path);
        const match = /^\.\.\/\.\.\/releases\/(phase4a-[0-9a-f]{40})$/u.exec(target);
        if (!match) fail(`${name} release pointer target is invalid`);
        return match[1];
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    return { currentReleaseId: await readPointer(paths.currentLink, "current"), previousReleaseId: await readPointer(paths.previousLink, "previous") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { currentReleaseId: undefined, previousReleaseId: undefined };
    throw error;
  }
}
/** @param {ReturnType<typeof installedPaths>} paths */
async function currentReleaseId(paths) { return (await releasePointers(paths)).currentReleaseId; }
/** @param {ReturnType<typeof installedPaths>} paths @param {string | undefined} currentReleaseIdValue @param {string | undefined} previousReleaseIdValue */
async function setReleasePointers(paths, currentReleaseIdValue, previousReleaseIdValue) {
  for (const value of [currentReleaseIdValue, previousReleaseIdValue]) if (value !== undefined && !/^phase4a-[0-9a-f]{40}$/u.test(value)) fail("release pointer identity is invalid");
  const selectorName = `selector-${randomBytes(12).toString("hex")}`;
  const temporary = join(paths.selectorsRoot, `.stage-${selectorName}`);
  const selectorRoot = join(paths.selectorsRoot, selectorName);
  await mkdir(temporary, { mode: 0o700 });
  if (currentReleaseIdValue !== undefined) await symlink(`../../releases/${currentReleaseIdValue}`, join(temporary, "current"));
  if (previousReleaseIdValue !== undefined) await symlink(`../../releases/${previousReleaseIdValue}`, join(temporary, "previous"));
  await rename(temporary, selectorRoot);
  await atomicLink(paths.activeSelectorLink, `selectors/${selectorName}`);
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function pruneReleaseSelectors(paths) {
  if (!(await exists(paths.activeSelectorLink)) || !(await exists(paths.selectorsRoot))) return;
  const target = await readlink(paths.activeSelectorLink);
  const match = /^selectors\/(selector-[0-9a-f]{24})$/u.exec(target);
  if (!match) fail("active release selector target is invalid");
  for (const name of await readdir(paths.selectorsRoot)) {
    if (name === match[1] || !/^(?:selector-[0-9a-f]{24}|\.stage-selector-[0-9a-f]{24})$/u.test(name)) continue;
    const root = join(paths.selectorsRoot, name);
    const information = await lstat(root);
    if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || (information.mode & 0o077) !== 0) fail("obsolete release selector is unsafe");
    await removeOwnedTree(root);
  }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function captureActivation(paths, command) {
  return {
    ...(await releasePointers(paths)),
    config: await snapshotPath(paths.configPath),
    deployment: await snapshotPath(paths.deploymentPath),
    managed: Object.fromEntries(await Promise.all(managedPaths(paths).map(async (path) => [path, await snapshotPath(path)]))),
    services: serviceStates(command),
  };
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {Record<string, any>} snapshot */
async function restoreActivation(paths, command, snapshot) {
  await setReleasePointers(paths, typeof snapshot.currentReleaseId === "string" ? snapshot.currentReleaseId : undefined, typeof snapshot.previousReleaseId === "string" ? snapshot.previousReleaseId : undefined);
  await restorePath(paths.configPath, record(snapshot.config, "config snapshot"));
  await restorePath(paths.deploymentPath, record(snapshot.deployment, "deployment snapshot"));
  const managed = record(snapshot.managed, "managed path snapshots");
  if (JSON.stringify(Object.keys(managed).sort()) !== JSON.stringify(managedPaths(paths).sort())) fail("managed path snapshot set is invalid");
  for (const [path, value] of Object.entries(managed)) await restorePath(path, record(value, "managed path snapshot"));
  systemctl(command, ["daemon-reload"]);
  restoreServiceStates(command, record(snapshot.services, "service snapshots"));
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function readInstalledConfig(paths) {
  if (!(await exists(paths.configPath))) return undefined;
  const information = await lstat(paths.configPath);
  if (!information.isFile() || information.isSymbolicLink() || information.uid !== process.getuid?.() || information.nlink !== 1 || (information.mode & 0o777) !== 0o600) fail("installed configuration is invalid");
  try { return record(await readJson(paths.configPath), "installed configuration"); }
  catch { fail("installed configuration is invalid"); }
}
/** @param {ReturnType<typeof installedPaths>} paths @param {Record<string, any>} config */
async function writeInstalledConfig(paths, config) { await atomicJson(paths.configPath, config); }

/** @param {ReturnType<typeof installedPaths>} paths */
async function readValidatedInstalledConfig(paths) {
  const releaseId = await currentReleaseId(paths);
  if (releaseId === undefined) fail("no current Phase 4A release is installed");
  const verified = await verifyInstallRelease(join(paths.releasesRoot, releaseId));
  const config = await readInstalledConfig(paths);
  if (config === undefined) fail("installed configuration is missing");
  try {
    const modulePath = join(verified.releaseRoot, "share/deploy/phase4a-config.mjs");
    const configModule = /** @type {any} */ (await import(`${pathToFileURL(modulePath).href}?read=${encodeURIComponent(releaseId)}`));
    return configModule.parseInstalledConfig(config);
  } catch { fail("installed configuration is invalid"); }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {string} releaseSource @param {string | undefined} expectedSha @param {string | undefined} expectedManifestSha256 */
async function installReleaseUnlocked(paths, command, releaseSource, expectedSha = undefined, expectedManifestSha256 = undefined) {
  await ensureManagedRoots(paths);
  const staged = await stageRelease(paths, releaseSource, expectedSha, expectedManifestSha256);
  const before = await captureActivation(paths, command);
  const firstInstall = before.currentReleaseId === undefined;
  if (firstInstall && !(await exists(paths.preinstallBackupPath))) await atomicJson(paths.preinstallBackupPath, before);
  let config = await readInstalledConfig(paths);
  if (config === undefined) config = record(await readJson(join(staged.releaseRoot, "share/deploy/config/default.json")), "default installed configuration");
  if (firstInstall) config.backend = "legacy";
  try {
    const prepared = await prepareInstallation(paths, staged.releaseRoot, config);
    const nextPreviousReleaseId = before.currentReleaseId !== undefined && before.currentReleaseId !== staged.releaseId ? before.currentReleaseId : before.previousReleaseId;
    await setReleasePointers(paths, staged.releaseId, nextPreviousReleaseId);
    await applyInstallation(paths, prepared);
    const parsed = prepared.parsed;
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    if (parsed.backend === "agentcursor") {
      activateService(command, "pi-web-agentcursor-egress-proxy.service");
      activateService(command, "pi-web-agentcursor-browserd.service");
    } else {
      deactivateService(command, "pi-web-agentcursor-browserd.service");
      deactivateService(command, "pi-web-agentcursor-egress-proxy.service");
    }
    activateService(command, "webxd.service");
    const priorDeployment = await exists(paths.deploymentPath) ? record(await readJson(paths.deploymentPath), "deployment state") : undefined;
    const sameRelease = before.currentReleaseId === staged.releaseId;
    const nextPreviousBackend = before.currentReleaseId === undefined ? undefined : sameRelease ? priorDeployment?.previousBackend : priorDeployment?.currentBackend ?? "legacy";
    await atomicJson(paths.deploymentPath, {
      schemaVersion: 1,
      currentReleaseId: staged.releaseId,
      currentBackend: parsed.backend,
      previousReleaseId: nextPreviousReleaseId,
      previousBackend: nextPreviousBackend,
      failedReleaseRetained: false,
    });
    return { ok: true, releaseId: staged.releaseId, gitSha: staged.gitSha, backend: parsed.backend, previousReleaseId: nextPreviousReleaseId ?? null };
  } catch (error) {
    await restoreActivation(paths, command, before).catch(() => undefined);
    await atomicJson(paths.failurePath, { schemaVersion: 1, failedReleaseId: staged.releaseId, error: error instanceof Error ? error.message.slice(0, 2_000) : "activation failed", releaseRetained: true });
    throw error;
  }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {"legacy" | "agentcursor"} backend */
async function setBackendUnlocked(paths, command, backend) {
  const releaseId = await currentReleaseId(paths);
  if (releaseId === undefined) fail("no current Phase 4A release is installed");
  const releaseRoot = join(paths.releasesRoot, releaseId);
  await verifyInstallRelease(releaseRoot);
  const before = await captureActivation(paths, command);
  const config = await readInstalledConfig(paths);
  if (config === undefined) fail("installed configuration is missing");
  const oldBackend = config.backend;
  if (oldBackend === backend) return { ok: true, backend, changed: false, releaseId };
  config.backend = backend;
  try {
    const prepared = await prepareInstallation(paths, releaseRoot, config);
    await applyInstallation(paths, prepared);
    const parsed = prepared.parsed;
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    if (backend === "agentcursor") {
      activateService(command, "pi-web-agentcursor-egress-proxy.service");
      activateService(command, "pi-web-agentcursor-browserd.service");
    } else {
      deactivateService(command, "pi-web-agentcursor-browserd.service");
      deactivateService(command, "pi-web-agentcursor-egress-proxy.service");
    }
    activateService(command, "webxd.service");
    const deployment = await exists(paths.deploymentPath) ? record(await readJson(paths.deploymentPath), "deployment state") : { schemaVersion: 1, currentReleaseId: releaseId };
    deployment.currentBackend = backend;
    await atomicJson(paths.deploymentPath, deployment);
    return { ok: true, backend, previousBackend: oldBackend, changed: true, releaseId };
  } catch (error) {
    await restoreActivation(paths, command, before).catch(() => undefined);
    throw error;
  }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function rollbackReleaseUnlocked(paths, command) {
  if (!(await exists(paths.deploymentPath))) fail("deployment state is missing");
  const deployment = record(await readJson(paths.deploymentPath), "deployment state");
  if (typeof deployment.previousReleaseId !== "string" || !/^phase4a-[0-9a-f]{40}$/u.test(deployment.previousReleaseId)) fail("no verified previous candidate release is available");
  const previousRoot = join(paths.releasesRoot, deployment.previousReleaseId);
  await verifyInstallRelease(previousRoot);
  const before = await captureActivation(paths, command);
  const config = await readInstalledConfig(paths);
  if (config === undefined) fail("installed configuration is missing");
  config.backend = deployment.previousBackend === "agentcursor" ? "agentcursor" : "legacy";
  try {
    const prepared = await prepareInstallation(paths, previousRoot, config);
    await setReleasePointers(paths, deployment.previousReleaseId, before.currentReleaseId);
    await applyInstallation(paths, prepared);
    const parsed = prepared.parsed;
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    if (parsed.backend === "agentcursor") {
      activateService(command, "pi-web-agentcursor-egress-proxy.service");
      activateService(command, "pi-web-agentcursor-browserd.service");
    } else {
      deactivateService(command, "pi-web-agentcursor-browserd.service");
      deactivateService(command, "pi-web-agentcursor-egress-proxy.service");
    }
    activateService(command, "webxd.service");
    await atomicJson(paths.deploymentPath, {
      schemaVersion: 1,
      currentReleaseId: deployment.previousReleaseId,
      currentBackend: parsed.backend,
      previousReleaseId: before.currentReleaseId,
      previousBackend: deployment.currentBackend,
      failedReleaseRetained: false,
    });
    return { ok: true, releaseId: deployment.previousReleaseId, backend: parsed.backend, replacedReleaseId: before.currentReleaseId };
  } catch (error) {
    await restoreActivation(paths, command, before).catch(() => undefined);
    throw error;
  }
}

/** @param {string} root */
async function verifyManagedRoot(root) {
  if (!isAbsolute(root)) fail("managed root must be absolute");
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || await realpath(root) !== resolve(root) || (information.mode & 0o077) !== 0) fail(`managed root is unsafe: ${root}`);
  const marker = join(root, MARKER_NAME);
  const markerInformation = await lstat(marker);
  if (!markerInformation.isFile() || markerInformation.isSymbolicLink() || markerInformation.uid !== process.getuid?.() || markerInformation.nlink !== 1 || (markerInformation.mode & 0o777) !== 0o600 || await readFile(marker, "utf8") !== MARKER_VALUE) fail(`managed root ownership marker is invalid: ${root}`);
}
/** @param {ReturnType<typeof installedPaths>} paths */
async function isCommittedCandidateCleanup(paths) {
  return await currentReleaseId(paths) === undefined && await exists(paths.preinstallBackupPath);
}
/** @param {ReturnType<typeof installedPaths>} paths @param {boolean} allowPartialCleanup */
async function verifiedCandidateReleases(paths, allowPartialCleanup = false) {
  /** @type {string[]} */
  const releases = [];
  if (!(await exists(paths.releasesRoot))) return releases;
  for (const name of await readdir(paths.releasesRoot)) {
    if (!/^phase4a-[0-9a-f]{40}$/u.test(name)) continue;
    const release = join(paths.releasesRoot, name);
    if (allowPartialCleanup) {
      const information = await lstat(release);
      if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || await realpath(release) !== resolve(release) || ![0o555, 0o700].includes(information.mode & 0o777)) fail("partial candidate cleanup residue is unsafe");
    } else await verifyInstallRelease(release);
    releases.push(release);
  }
  return releases.sort();
}

/** @param {ReturnType<typeof installedPaths>} paths @param {boolean} purge */
async function prepareCandidateRemoval(paths, purge) {
  await verifiedCandidateReleases(paths, await isCommittedCandidateCleanup(paths));
  if (!purge) return;
  for (const root of [paths.cacheRoot, paths.configRoot, paths.dataRoot, paths.stateRoot]) if (await exists(root)) await verifyManagedRoot(root);
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {boolean} purge */
async function uninstallCandidateUnlocked(paths, command, purge = false) {
  if (await currentReleaseId(paths) === undefined) return { ok: true, purged: purge, legacyPreserved: true };
  for (const unit of UNITS) deactivateService(command, unit);
  if (await exists(paths.preinstallBackupPath)) {
    const backup = record(await readJson(paths.preinstallBackupPath), "preinstall backup");
    const retainedConfig = await snapshotPath(paths.configPath);
    await restoreActivation(paths, command, backup);
    if (record(backup.config, "preinstall config snapshot").kind === "missing" && retainedConfig.kind === "file") await restorePath(paths.configPath, retainedConfig);
  } else {
    for (const path of managedPaths(paths)) await rm(path, { force: true });
    await setReleasePointers(paths, undefined, undefined);
    systemctl(command, ["daemon-reload"]);
  }
  return { ok: true, purged: purge, legacyPreserved: true };
}

/**
 * Delete only inactive candidate bytes after the reversible transaction has
 * committed. A cleanup failure can be retried without restoring pointers to a
 * release that was already removed.
 * @param {ReturnType<typeof installedPaths>} paths
 * @param {boolean} purge
 */
async function cleanupCandidateRemoval(paths, purge) {
  for (const release of await verifiedCandidateReleases(paths, await isCommittedCandidateCleanup(paths))) await removeOwnedTree(release);
  for (const path of [paths.deploymentPath, paths.failurePath, paths.preinstallBackupPath]) await rm(path, { force: true });
  if (!purge) return;
  const roots = [paths.cacheRoot, paths.configRoot, paths.dataRoot, paths.stateRoot];
  for (const root of roots) if (await exists(root)) await verifyManagedRoot(root);
  for (const root of roots) if (await exists(root)) await rm(root, { recursive: true });
}

/** @param {number} pid */
async function processStartTicks(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/u);
    const startTicks = fields[19];
    return typeof startTicks === "string" && /^[0-9]+$/u.test(startTicks) ? startTicks : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function acquireMutationLock(paths) {
  const create = async () => {
    const startTicks = await processStartTicks(process.pid);
    if (startTicks === undefined) fail("cannot establish controller process identity");
    const stage = join(paths.stateRoot, `.mutation-lock-stage-${process.pid}-${randomBytes(12).toString("hex")}`);
    await atomicJson(stage, { schemaVersion: 1, pid: process.pid, startTicks });
    try { await link(stage, paths.mutationLockPath); }
    finally { await rm(stage, { force: true }); }
  };
  try { await create(); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const information = await lstat(paths.mutationLockPath);
    let owner;
    if (information.isFile() && !information.isSymbolicLink() && information.uid === process.getuid?.() && (information.mode & 0o777) === 0o600 && information.nlink >= 1 && information.nlink <= 2) {
      owner = record(await readJson(paths.mutationLockPath), "controller lock owner");
    } else if (information.isDirectory() && !information.isSymbolicLink() && information.uid === process.getuid?.() && (information.mode & 0o077) === 0) {
      try { owner = record(await readJson(join(paths.mutationLockPath, "owner.json")), "controller lock owner"); }
      catch (ownerError) {
        if (!(ownerError instanceof Error) || !("code" in ownerError) || ownerError.code !== "ENOENT") throw ownerError;
        if (Date.now() - information.mtimeMs < LOCK_PUBLICATION_GRACE_MS) fail("controller mutation lock identity is not yet available");
      }
    } else fail("controller mutation lock is unsafe");
    if (owner !== undefined) {
      if (JSON.stringify(Object.keys(owner).sort()) !== JSON.stringify(["pid", "schemaVersion", "startTicks"]) || owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || typeof owner.startTicks !== "string" || !/^[0-9]+$/u.test(owner.startTicks)) fail("controller mutation lock owner is invalid");
      if (await processStartTicks(owner.pid) === owner.startTicks) fail("another pi-webctl mutation is in progress");
    }
    const quarantine = join(paths.stateRoot, `.stale-mutation-lock-${randomBytes(12).toString("hex")}`);
    await rename(paths.mutationLockPath, quarantine);
    await removeOwnedTree(quarantine);
    await create();
  }
  return async () => await removeOwnedTree(paths.mutationLockPath);
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function recoverInterruptedActivation(paths, command) {
  if (!(await exists(paths.transactionPath))) return false;
  const transaction = record(await readJson(paths.transactionPath), "activation transaction");
  if (JSON.stringify(Object.keys(transaction).sort()) !== JSON.stringify(["operation", "schemaVersion", "snapshot"]) || transaction.schemaVersion !== 1 || !["install", "backend", "rollback", "uninstall"].includes(transaction.operation)) fail("activation transaction is invalid");
  await restoreActivation(paths, command, record(transaction.snapshot, "activation transaction snapshot"));
  await atomicJson(paths.recoveryPath, { schemaVersion: 1, operation: transaction.operation, recovered: true });
  await rm(paths.transactionPath);
  return true;
}

/**
 * @template T
 * @param {ReturnType<typeof installedPaths>} paths
 * @param {string} command
 * @param {string} operation
 * @param {() => Promise<T>} callback
 * @param {() => Promise<void>} [beforeSystemctl]
 * @param {() => Promise<void>} [afterCommit]
 */
async function withMutation(paths, command, operation, callback, beforeSystemctl = async () => undefined, afterCommit = async () => undefined) {
  await ensureManagedRoots(paths);
  const releaseLock = await acquireMutationLock(paths);
  try {
    await recoverInterruptedActivation(paths, command);
    await beforeSystemctl();
    const snapshot = await captureActivation(paths, command);
    await atomicJson(paths.transactionPath, { schemaVersion: 1, operation, snapshot });
    let result;
    try {
      result = await callback();
      await pruneReleaseSelectors(paths);
      await rm(paths.transactionPath, { force: true });
    } catch (error) {
      let restored = false;
      try { await restoreActivation(paths, command, snapshot); restored = true; }
      finally { if (restored) await rm(paths.transactionPath, { force: true }); }
      throw error;
    }
    await afterCommit();
    return result;
  } finally { await releaseLock(); }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {string} releaseSource @param {string | undefined} expectedSha @param {string | undefined} expectedManifestSha256 */
export async function installRelease(paths, command, releaseSource, expectedSha = undefined, expectedManifestSha256 = undefined) {
  const prepare = async () => {
    const staged = await stageRelease(paths, releaseSource, expectedSha, expectedManifestSha256);
    const pointers = await releasePointers(paths);
    let config = await readInstalledConfig(paths);
    if (config === undefined) config = record(await readJson(join(staged.releaseRoot, "share/deploy/config/default.json")), "default installed configuration");
    if (pointers.currentReleaseId === undefined) config.backend = "legacy";
    await prepareInstallation(paths, staged.releaseRoot, config);
  };
  return await withMutation(paths, command, "install", async () => await installReleaseUnlocked(paths, command, releaseSource, expectedSha, expectedManifestSha256), prepare);
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {"legacy" | "agentcursor"} backend */
export async function setBackend(paths, command, backend) {
  const prepare = async () => {
    const releaseId = await currentReleaseId(paths);
    if (releaseId === undefined) fail("no current Phase 4A release is installed");
    const releaseRoot = join(paths.releasesRoot, releaseId);
    await verifyInstallRelease(releaseRoot);
    const config = await readInstalledConfig(paths);
    if (config === undefined) fail("installed configuration is missing");
    config.backend = backend;
    await prepareInstallation(paths, releaseRoot, config);
  };
  return await withMutation(paths, command, "backend", async () => await setBackendUnlocked(paths, command, backend), prepare);
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
export async function rollbackRelease(paths, command) {
  const prepare = async () => {
    if (!(await exists(paths.deploymentPath))) fail("deployment state is missing");
    const deployment = record(await readJson(paths.deploymentPath), "deployment state");
    if (typeof deployment.previousReleaseId !== "string" || !/^phase4a-[0-9a-f]{40}$/u.test(deployment.previousReleaseId)) fail("no verified previous candidate release is available");
    const previousRoot = join(paths.releasesRoot, deployment.previousReleaseId);
    await verifyInstallRelease(previousRoot);
    const config = await readInstalledConfig(paths);
    if (config === undefined) fail("installed configuration is missing");
    config.backend = deployment.previousBackend === "agentcursor" ? "agentcursor" : "legacy";
    await prepareInstallation(paths, previousRoot, config);
  };
  return await withMutation(paths, command, "rollback", async () => await rollbackReleaseUnlocked(paths, command), prepare);
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {boolean} purge */
export async function uninstallCandidate(paths, command, purge = false) {
  const prepare = async () => await prepareCandidateRemoval(paths, purge);
  const cleanup = async () => await cleanupCandidateRemoval(paths, purge);
  return await withMutation(paths, command, "uninstall", async () => await uninstallCandidateUnlocked(paths, command, purge), prepare, cleanup);
}

/** @param {NodeJS.ProcessEnv} environment */
export function installedPaths(environment = process.env) {
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) fail("HOME must be absolute");
  const dataHome = environment.XDG_DATA_HOME ?? join(home, ".local/share");
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  const cacheHome = environment.XDG_CACHE_HOME ?? join(home, ".cache");
  const stateHome = environment.XDG_STATE_HOME ?? join(home, ".local/state");
  const runtimeRoot = environment.XDG_RUNTIME_DIR;
  const binRoot = join(home, ".local/bin");
  for (const [name, path] of Object.entries({ dataHome, configHome, cacheHome, stateHome, binRoot })) if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) fail(`${name} must be a safe absolute path`);
  if (!runtimeRoot || !isAbsolute(runtimeRoot) || /[\0\r\n]/u.test(runtimeRoot)) fail("XDG_RUNTIME_DIR must be a safe absolute path");
  const dataRoot = join(dataHome, "pi-web");
  const configRoot = join(configHome, "pi-web");
  const cacheRoot = join(cacheHome, "pi-web");
  const stateRoot = join(stateHome, "pi-web");
  return Object.freeze({
    home,
    dataHome,
    configHome,
    cacheHome,
    stateHome,
    runtimeRoot,
    binRoot,
    dataRoot,
    configRoot,
    cacheRoot,
    stateRoot,
    releasesRoot: join(dataRoot, "releases"),
    selectorsRoot: join(dataRoot, "selectors"),
    activeSelectorLink: join(dataRoot, "active"),
    currentLink: join(dataRoot, "active/current"),
    previousLink: join(dataRoot, "active/previous"),
    unitRoot: join(configHome, "systemd/user"),
    applicationRoot: join(dataHome, "applications"),
    configPath: join(configRoot, "config.json"),
    environmentPath: join(configRoot, "service.env"),
    deploymentPath: join(stateRoot, "deployment.json"),
    failurePath: join(stateRoot, "last-activation-failure.json"),
    preinstallBackupPath: join(stateRoot, "preinstall-backup.json"),
    mutationLockPath: join(stateRoot, "mutation.lock"),
    transactionPath: join(stateRoot, "activation-transaction.json"),
    recoveryPath: join(stateRoot, "last-interrupted-recovery.json"),
    desktopPath: join(dataHome, "applications/pi-web-workspace.desktop"),
    extensionPath: join(home, ".pi/agent/extensions/pi-web"),
    controlLink: join(binRoot, "pi-webctl"),
    workspaceLink: join(binRoot, "pi-web-workspace"),
  });
}

/** @param {string} target */
async function nearestWritableDirectory(target) {
  let candidate = target;
  while (!(await exists(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) fail("no writable ancestor exists for an installation root");
    candidate = parent;
  }
  const information = await lstat(candidate);
  if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || await realpath(candidate) !== resolve(candidate)) fail("an installation root has an unsafe ancestor");
  await access(candidate, fsConstants.W_OK | fsConstants.X_OK);
  return candidate;
}

/** @param {"auto" | "google-chrome-stable" | "chromium"} [selection] @returns {Promise<{product: string, version: string} | undefined>} */
async function detectReviewedBrowser(selection = "auto") {
  for (const candidate of [
    { path: "/usr/bin/google-chrome-stable", product: "Google Chrome", roots: ["/opt/google/chrome/"] },
    { path: "/usr/bin/chromium-browser", product: "Chromium", roots: ["/usr/lib64/chromium-browser/"] },
    { path: "/usr/bin/chromium", product: "Chromium", roots: ["/usr/lib64/chromium-browser/"] },
  ]) {
    if (selection !== "auto" && candidate.path !== (selection === "google-chrome-stable" ? "/usr/bin/google-chrome-stable" : "/usr/bin/chromium-browser")) continue;
    if (!(await exists(candidate.path))) continue;
    const resolved = await realpath(candidate.path);
    const information = await lstat(resolved);
    if (!information.isFile() || information.isSymbolicLink() || information.uid !== 0 || (information.mode & 0o111) === 0 || (resolved !== candidate.path && !candidate.roots.some((root) => resolved.startsWith(root)))) continue;
    const result = spawnSync(candidate.path, ["--version"], { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 });
    const version = /([0-9]+(?:\.[0-9]+){1,3})/u.exec(result.stdout)?.[1];
    if (result.status === 0 && version !== undefined) return { product: candidate.product, version };
  }
  return undefined;
}

/** @param {string} text @param {string} name */
function osReleaseValue(text, name) {
  const match = new RegExp(`^${name}=(?:"([^"]*)"|'([^']*)'|([^\\s#]+))$`, "mu").exec(text);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** @typedef {"pass" | "warning" | "error"} PreflightStatus */
/** @param {string} category @param {PreflightStatus} statusValue @param {string} code @param {string} summary */
function preflightFinding(category, statusValue, code, summary) { return Object.freeze({ category, status: statusValue, code, summary }); }

/**
 * Run a bounded, non-mutating host preflight. Optional probes are exported
 * test seams; the production CLI supplies none and uses only fixed commands.
 * @param {ReturnType<typeof installedPaths>} paths
 * @param {string} command
 * @param {string} releaseSource
 * @param {string | undefined} expectedSha
 * @param {string | undefined} expectedManifestSha256
 * @param {NodeJS.ProcessEnv} environment
 * @param {{osRelease?: string, architecture?: string, systemdAvailable?: boolean, diskAvailableBytes?: number, runtimeAvailableBytes?: number, nodeVersion?: string, pythonVersion?: string, missingPackages?: string[], browser?: {product: string, version: string}, portState?: "free" | "reviewed" | "conflict", serviceConflict?: boolean, destinationConflict?: boolean, runtimeState?: "clean" | "present"}} probes
 */
export async function installationPreflight(paths, command, releaseSource, expectedSha = undefined, expectedManifestSha256 = undefined, environment = process.env, probes = {}) {
  const verified = await verifyInstallRelease(releaseSource, expectedSha, expectedManifestSha256);
  const configModule = /** @type {any} */ (await import(`${pathToFileURL(join(verified.releaseRoot, "share/deploy/phase4a-config.mjs")).href}?preflight=${encodeURIComponent(verified.releaseId)}`));
  const installedConfig = await readInstalledConfig(paths);
  let prospectiveConfig;
  try { prospectiveConfig = configModule.parseInstalledConfig(installedConfig ?? await readJson(join(verified.releaseRoot, "share/deploy/config/default.json"))); }
  catch { fail("installed configuration is invalid"); }
  /** @type {Array<{category: string, status: PreflightStatus, code: string, summary: string}>} */
  const findings = [preflightFinding("release", "pass", "RELEASE_VERIFIED", "The immutable release identity and complete checksum inventory are verified.")];

  const osRelease = probes.osRelease ?? await readFile("/etc/os-release", "utf8").catch(() => "");
  const architecture = probes.architecture ?? process.arch;
  const supportedPlatform = osReleaseValue(osRelease, "ID") === "fedora" && osReleaseValue(osRelease, "VERSION_ID") === "44" && architecture === "x64";
  findings.push(preflightFinding("platform", supportedPlatform ? "pass" : "error", supportedPlatform ? "PLATFORM_SUPPORTED" : "PLATFORM_UNSUPPORTED", supportedPlatform ? "Fedora 44 x86_64 is supported." : "Installation requires Fedora 44 x86_64."));

  const systemdAvailable = probes.systemdAvailable ?? systemctl(command, ["show-environment"], false).status === 0;
  findings.push(preflightFinding("systemd", systemdAvailable ? "pass" : "error", systemdAvailable ? "USER_SYSTEMD_AVAILABLE" : "USER_SYSTEMD_UNAVAILABLE", systemdAvailable ? "The user service manager is available." : "The user service manager is unavailable."));

  const graphical = (typeof environment.WAYLAND_DISPLAY === "string" && environment.WAYLAND_DISPLAY.length > 0) || (typeof environment.DISPLAY === "string" && environment.DISPLAY.length > 0);
  const sessionReady = graphical && typeof environment.DBUS_SESSION_BUS_ADDRESS === "string" && environment.DBUS_SESSION_BUS_ADDRESS.length > 0;
  findings.push(preflightFinding("session", sessionReady ? "pass" : "error", sessionReady ? "GRAPHICAL_SESSION_AVAILABLE" : "GRAPHICAL_SESSION_UNAVAILABLE", sessionReady ? "A graphical user session and session bus are available." : "A graphical user session and session bus are required."));

  let pathReady = true;
  let dataAncestor = paths.home;
  try {
    const runtimeInformation = await lstat(paths.runtimeRoot);
    if (!runtimeInformation.isDirectory() || runtimeInformation.isSymbolicLink() || runtimeInformation.uid !== process.getuid?.() || await realpath(paths.runtimeRoot) !== resolve(paths.runtimeRoot) || (runtimeInformation.mode & 0o077) !== 0) throw new Error("unsafe runtime root");
    await access(paths.runtimeRoot, fsConstants.W_OK | fsConstants.X_OK);
    for (const target of [paths.dataHome, paths.configHome, paths.cacheHome, paths.stateHome, paths.binRoot]) {
      const ancestor = await nearestWritableDirectory(target);
      if (target === paths.dataHome) dataAncestor = ancestor;
    }
    for (const root of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.stateRoot]) {
      if (!(await exists(root))) continue;
      const information = await lstat(root);
      if (!information.isDirectory() || information.isSymbolicLink() || information.uid !== process.getuid?.() || await realpath(root) !== resolve(root) || (information.mode & 0o022) !== 0) throw new Error("unsafe managed root");
      const marker = join(root, MARKER_NAME);
      if (!(await exists(marker))) {
        if ((await readdir(root)).length > 0) throw new Error("unmanaged nonempty root");
        continue;
      }
      const markerInformation = await lstat(marker);
      if (!markerInformation.isFile() || markerInformation.isSymbolicLink() || markerInformation.uid !== process.getuid?.() || markerInformation.nlink !== 1 || (markerInformation.mode & 0o777) !== 0o600 || await readFile(marker, "utf8") !== MARKER_VALUE) throw new Error("invalid managed root marker");
    }
  } catch { pathReady = false; }
  findings.push(preflightFinding("filesystem", pathReady ? "pass" : "error", pathReady ? "INSTALL_ROOTS_WRITABLE" : "INSTALL_ROOTS_UNSAFE", pathReady ? "Installation and runtime roots are owner-controlled and writable." : "An installation or runtime root is missing, unsafe, or not writable."));

  let availableBytes = probes.diskAvailableBytes;
  if (availableBytes === undefined && pathReady) {
    const information = await statfs(dataAncestor, { bigint: true });
    const available = information.bavail * information.bsize;
    availableBytes = available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  }
  let runtimeAvailableBytes = probes.runtimeAvailableBytes;
  if (runtimeAvailableBytes === undefined && pathReady) {
    const information = await statfs(paths.runtimeRoot, { bigint: true });
    const available = information.bavail * information.bsize;
    runtimeAvailableBytes = available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  }
  const immutableFiles = Array.isArray(verified.manifest.immutableFiles) ? verified.manifest.immutableFiles : [];
  const releaseBytes = immutableFiles.reduce((total, item) => total + (Number.isSafeInteger(item?.bytes) ? item.bytes : 0), 0);
  const dataReady = availableBytes !== undefined && availableBytes >= releaseBytes * 2 + MINIMUM_INSTALL_FREE_BYTES;
  const runtimeRequiredBytes = prospectiveConfig.resources.maxBrowserSessions * prospectiveConfig.resources.profileHardMiB * 1024 * 1024 + 256 * 1024 * 1024;
  const diskReady = dataReady && runtimeAvailableBytes !== undefined && runtimeAvailableBytes >= runtimeRequiredBytes;
  findings.push(preflightFinding("disk", diskReady ? "pass" : "error", diskReady ? "DISK_SPACE_AVAILABLE" : "DISK_SPACE_INSUFFICIENT", diskReady ? "Free space covers staging, rollback, configured disposable profiles, and reserves." : "Data or runtime storage does not meet the reviewed release and configured profile reserve."));

  const nodeVersion = probes.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  const nodeCompatibility = record(verified.manifest.compatibility, "manifest compatibility").node;
  const nodeRange = record(nodeCompatibility, "manifest Node compatibility");
  const nodeReady = Number.isSafeInteger(nodeMajor) && nodeMajor >= nodeRange.minimumMajor && nodeMajor <= nodeRange.maximumMajor;
  findings.push(preflightFinding("node", nodeReady ? "pass" : "error", nodeReady ? "NODE_SUPPORTED" : "NODE_UNSUPPORTED", nodeReady ? `Node ${nodeMajor} is within the reviewed runtime range.` : "The installed Node major version is outside the release manifest range."));

  let pythonVersion = probes.pythonVersion;
  if (pythonVersion === undefined) {
    const result = spawnSync("/usr/bin/python3", ["--version"], { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 });
    pythonVersion = result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : "";
  }
  const pythonMatch = /^Python (3)\.(\d+)\./u.exec(pythonVersion);
  const pythonReady = pythonMatch !== null && Number(pythonMatch[2]) >= 13;
  findings.push(preflightFinding("python", pythonReady ? "pass" : "error", pythonReady ? "PYTHON_SUPPORTED" : "PYTHON_UNSUPPORTED", pythonReady ? `Python 3.${pythonMatch[2]} is supported.` : "Python 3.13 or newer is required."));

  let missingPackages = probes.missingPackages;
  if (missingPackages === undefined) missingPackages = PREFLIGHT_PACKAGES.filter((name) => spawnSync("/usr/bin/rpm", ["-q", "--", name], { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 }).status !== 0);
  if (missingPackages.some((name) => !PREFLIGHT_PACKAGES.includes(name)) || new Set(missingPackages).size !== missingPackages.length) fail("preflight package result is invalid");
  missingPackages = [...missingPackages].sort();
  findings.push(preflightFinding("packages", missingPackages.length === 0 ? "pass" : "error", missingPackages.length === 0 ? "RUNTIME_PACKAGES_PRESENT" : "RUNTIME_PACKAGES_MISSING", missingPackages.length === 0 ? "All reviewed Fedora runtime packages are installed." : `Missing reviewed Fedora packages: ${missingPackages.join(", ")}.`));

  const browser = probes.browser ?? await detectReviewedBrowser(prospectiveConfig.browser.product);
  findings.push(preflightFinding("browser", browser === undefined ? "error" : "pass", browser === undefined ? "BROWSER_UNAVAILABLE" : "BROWSER_REVIEWED", browser === undefined ? "Fedora Chromium or an already installed reviewed Google Chrome is required." : `${browser.product} ${browser.version} is available.`));

  let portState = probes.portState;
  if (portState === undefined) {
    try {
      const response = await probeProxy(prospectiveConfig.proxy.host, prospectiveConfig.proxy.port);
      portState = response.startsWith("HTTP/1.1 204 No Content\r\n") && response.includes("\r\nWebX-Egress-Proxy: secure-egress/1\r\n") ? "reviewed" : "conflict";
    } catch (error) { portState = error instanceof Error && "code" in error && error.code === "ECONNREFUSED" ? "free" : "conflict"; }
  }
  const portReady = portState === "free" || portState === "reviewed";
  let serviceConflict = probes.serviceConflict;
  if (serviceConflict === undefined) serviceConflict = UNITS.some((unit) => systemctl(command, ["is-enabled", unit], false).stdout.trim() === "masked");
  let destinationConflict = probes.destinationConflict;
  if (destinationConflict === undefined) {
    const managed = await exists(join(paths.dataRoot, MARKER_NAME));
    destinationConflict = !managed && (await Promise.all([
      join(paths.unitRoot, "pi-web-agentcursor-egress-proxy.service"),
      join(paths.unitRoot, "pi-web-agentcursor-browserd.service"),
      paths.desktopPath,
      paths.controlLink,
      paths.workspaceLink,
    ].map(async (path) => await exists(path)))).some(Boolean);
  }
  const conflictFree = portReady && !serviceConflict && !destinationConflict;
  findings.push(preflightFinding("conflicts", conflictFree ? "pass" : "error", conflictFree ? (portState === "reviewed" ? "REVIEWED_PROXY_PRESENT" : "NO_INSTALL_CONFLICT") : "INSTALL_CONFLICT", conflictFree ? (portState === "reviewed" ? "The reviewed candidate proxy already owns the fixed listener." : "No listener, masked-unit, or unmanaged destination conflict was found.") : "A listener, masked unit, or unmanaged candidate destination conflicts with installation."));

  let runtimeState = probes.runtimeState;
  if (runtimeState === undefined) {
    const runtime = join(paths.runtimeRoot, "pi-web-agentcursor");
    runtimeState = await exists(runtime) && (await readdir(runtime)).length > 0 ? "present" : "clean";
  }
  findings.push(preflightFinding("runtime", runtimeState === "clean" ? "pass" : "warning", runtimeState === "clean" ? "RUNTIME_STATE_CLEAN" : "RUNTIME_STATE_PRESENT", runtimeState === "clean" ? "No candidate runtime state is present." : "Owned candidate runtime state is present and requires operator review before cleanup."));

  let installedReleaseId = null;
  try {
    const pointers = await releasePointers(paths);
    installedReleaseId = pointers.currentReleaseId ?? null;
    if (pointers.currentReleaseId !== undefined) await verifyInstallRelease(join(paths.releasesRoot, pointers.currentReleaseId));
    if (pointers.previousReleaseId !== undefined) await verifyInstallRelease(join(paths.releasesRoot, pointers.previousReleaseId));
  } catch { findings.push(preflightFinding("existing", "error", "EXISTING_INSTALL_INVALID", "Existing candidate activation state or immutable release is invalid.")); }
  if (!findings.some((item) => item.category === "existing")) findings.push(preflightFinding("existing", installedReleaseId === null ? "pass" : "warning", installedReleaseId === null ? "CANDIDATE_NOT_INSTALLED" : "CANDIDATE_UPGRADE", installedReleaseId === null ? "No candidate release is currently installed; legacy state will be preserved." : "A verified candidate activation exists and will be treated as an upgrade."));

  const ok = findings.every((item) => item.status !== "error");
  const installCommand = missingPackages.length === 0 ? null : `/usr/bin/sudo /usr/bin/dnf install -- ${missingPackages.join(" ")}`;
  return Object.freeze({ schemaVersion: 1, ok, releaseId: verified.releaseId, gitSha: verified.gitSha, missingPackages: Object.freeze(missingPackages), installCommand, findings: Object.freeze(findings) });
}

/** @param {string[]} arguments_ */
function parseCli(arguments_) {
  const [command, ...tail] = arguments_;
  const subcommand = command === "backend" ? tail[0] : undefined;
  const rest = command === "backend" ? tail.slice(1) : tail;
  const allowed = new Set(["--release", "--expected-sha", "--manifest-sha256", "--json", "--purge"]);
  /** @type {Record<string, string | boolean>} */
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (!allowed.has(name)) fail(`unsupported option: ${name}`);
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate option: ${name}`);
    if (name === "--json" || name === "--purge") { options[key] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    options[key] = value;
  }
  return { command, subcommand, options };
}

const DOCTOR_CATEGORIES = Object.freeze(["release", "filesystem", "services", "display", "browser", "egress", "authority", "resource", "workspace"]);
/** @typedef {"pass" | "warning" | "error" | "unavailable" | "not-tested"} DoctorStatus */
/** @param {string} category @param {DoctorStatus} statusValue @param {string} code @param {string} summary */
function doctorFinding(category, statusValue, code, summary) { return Object.freeze({ category, status: statusValue, code, summary }); }

/** @param {string} socketPath */
async function probeAuthority(socketPath) {
  const socket = createConnection({ path: socketPath });
  let buffer = "";
  /** @type {Error | undefined} */
  let failure;
  /** @type {{resolve: (value: string) => void, reject: (error: Error) => void} | undefined} */
  let waiter;
  const drain = () => {
    if (waiter === undefined) return;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const target = waiter; waiter = undefined; target.resolve(line); return;
    }
    if (failure !== undefined) { const target = waiter; waiter = undefined; target.reject(failure); }
  };
  socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 65_536) socket.destroy(new Error("bounded authority response exceeded")); drain(); });
  socket.on("error", (error) => { failure = error; drain(); });
  socket.on("close", () => { failure ??= new Error("authority connection closed"); drain(); });
  const nextLine = () => new Promise((resolveLine, rejectLine) => { waiter = { resolve: resolveLine, reject: rejectLine }; drain(); });
  const deadline = setTimeout(() => socket.destroy(new Error("bounded authority probe timed out")), 2_000);
  try {
    await new Promise((resolveConnect, rejectConnect) => { socket.once("connect", resolveConnect); socket.once("error", rejectConnect); });
    socket.write(`${JSON.stringify({ bind: { ownerId: `pi-webctl-doctor-${process.pid}` } })}\n`);
    const binding = record(JSON.parse(await nextLine()), "authority binding");
    if (typeof binding.bindingId !== "string" || typeof binding.bindingSecret !== "string") fail("authority binding is invalid");
    socket.write(`${JSON.stringify({ binding: { bindingId: binding.bindingId, bindingSecret: binding.bindingSecret }, request: { method: "GET", path: "/v1/capabilities", maxResponseBytes: 65_536 } })}\n`);
    const response = record(JSON.parse(await nextLine()), "authority response");
    if (response.status !== 200) fail("authority capability status is invalid");
    return record(response.body, "authority capability catalog");
  } finally { clearTimeout(deadline); socket.destroy(); }
}

/** @param {string} host @param {number} port */
async function probeProxy(host, port) {
  return await new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host, port });
    let bytes = Buffer.alloc(0);
    const deadline = setTimeout(() => socket.destroy(new Error("bounded proxy probe timed out")), 2_000);
    /** @param {Error | undefined} error @param {string | undefined} [value] */
    const finish = (error, value) => { clearTimeout(deadline); socket.destroy(); if (error instanceof Error) rejectProbe(error); else resolveProbe(value); };
    socket.once("connect", () => socket.write("GET http://webx-egress.invalid/.well-known/webx-egress-health HTTP/1.1\r\nHost: webx-egress.invalid\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.byteLength > 4_096) finish(new Error("bounded proxy response exceeded")); });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(undefined, bytes.toString("ascii")));
  });
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function doctorFilesystem(paths) {
  for (const root of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.stateRoot]) await verifyManagedRoot(root);
  const runtimeInformation = await lstat(paths.runtimeRoot);
  if (!runtimeInformation.isDirectory() || runtimeInformation.isSymbolicLink() || runtimeInformation.uid !== process.getuid?.() || (runtimeInformation.mode & 0o077) !== 0) fail("runtime root is unsafe");
  for (const path of [...UNITS.map((name) => join(paths.unitRoot, name)), paths.environmentPath, paths.desktopPath, paths.configPath]) {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink() || information.uid !== process.getuid?.() || information.nlink !== 1) fail("installed managed file is unsafe");
  }
  for (const [path, target] of [[paths.extensionPath, join(paths.currentLink, "share/pi-webx")], [paths.controlLink, join(paths.currentLink, "bin/pi-webctl.mjs")], [paths.workspaceLink, join(paths.currentLink, "bin/pi-browser-workspace")]]) {
    const information = await lstat(path);
    if (!information.isSymbolicLink() || await readlink(path) !== target) fail("installed managed link is unsafe");
  }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {NodeJS.ProcessEnv} environment @param {{authority?: (path: string) => Promise<Record<string, any>>, proxy?: (host: string, port: number) => Promise<string>, browser?: () => Promise<{product: string, version: string} | undefined>}} probes */
export async function doctorReport(paths, command, environment = process.env, probes = {}) {
  /** @type {Array<{category: string, status: DoctorStatus, code: string, summary: string}>} */
  const findings = [];
  let releaseId;
  let verified;
  let config;
  try {
    const pointers = await releasePointers(paths); releaseId = pointers.currentReleaseId;
    if (releaseId === undefined) throw new Error("not installed");
    verified = await verifyInstallRelease(join(paths.releasesRoot, releaseId));
    if (pointers.previousReleaseId !== undefined) await verifyInstallRelease(join(paths.releasesRoot, pointers.previousReleaseId));
    config = await readInstalledConfig(paths);
    if (config === undefined) throw new Error("missing config");
    const modulePath = join(verified.releaseRoot, "share/deploy/phase4a-config.mjs");
    config = (await import(`${pathToFileURL(modulePath).href}?doctor=${encodeURIComponent(releaseId)}`)).parseInstalledConfig(config);
    if (await exists(paths.deploymentPath)) {
      const deployment = record(await readJson(paths.deploymentPath), "deployment state");
      if (deployment.currentReleaseId !== releaseId || deployment.currentBackend !== config.backend) throw new Error("deployment mismatch");
    }
    findings.push(doctorFinding("release", await exists(paths.failurePath) ? "warning" : "pass", await exists(paths.failurePath) ? "RELEASE_FAILURE_RETAINED" : "RELEASE_VERIFIED", await exists(paths.failurePath) ? "Current release is verified; bounded activation failure evidence is retained." : "Current and previous release identities are verified."));
  } catch { findings.push(doctorFinding("release", releaseId === undefined ? "unavailable" : "error", releaseId === undefined ? "RELEASE_NOT_INSTALLED" : "RELEASE_INVALID", releaseId === undefined ? "No Phase 4A release is installed." : "The installed release identity or checksum is invalid.")); }

  try { await doctorFilesystem(paths); findings.push(doctorFinding("filesystem", "pass", "FILESYSTEM_VERIFIED", "Managed roots, files, links, modes, and ownership are verified.")); }
  catch { findings.push(doctorFinding("filesystem", "error", "FILESYSTEM_INVALID", "An installed managed path is missing or unsafe.")); }

  try {
    if (config === undefined) throw new Error("config unavailable");
    const states = serviceStates(command);
    const webxd = states["webxd.service"];
    if (!webxd.active || !webxd.enabled) throw new Error("webxd unavailable");
    if (config.backend === "agentcursor") {
      if (!states["pi-web-agentcursor-egress-proxy.service"].active || !states["pi-web-agentcursor-browserd.service"].active) throw new Error("candidate unavailable");
      findings.push(doctorFinding("services", "pass", "SERVICES_CANDIDATE_ACTIVE", "webxd and the selected AgentCursor services are active."));
    } else {
      const unexpected = states["pi-web-agentcursor-egress-proxy.service"].active || states["pi-web-agentcursor-browserd.service"].active;
      findings.push(doctorFinding("services", unexpected ? "warning" : "pass", unexpected ? "SERVICES_CANDIDATE_UNEXPECTED" : "SERVICES_LEGACY_ACTIVE", unexpected ? "webxd is active, but an unselected candidate service is also active." : "webxd is active and candidate services are not selected."));
    }
  } catch { findings.push(doctorFinding("services", "unavailable", "SERVICES_UNAVAILABLE", "One or more selected user services are unavailable.")); }

  const displayReady = (typeof environment.WAYLAND_DISPLAY === "string" && environment.WAYLAND_DISPLAY.length > 0) || (typeof environment.DISPLAY === "string" && environment.DISPLAY.length > 0);
  const dbusReady = typeof environment.DBUS_SESSION_BUS_ADDRESS === "string" && environment.DBUS_SESSION_BUS_ADDRESS.length > 0;
  findings.push(doctorFinding("display", displayReady && dbusReady ? "pass" : "unavailable", displayReady && dbusReady ? "DISPLAY_SESSION_AVAILABLE" : "DISPLAY_SESSION_UNAVAILABLE", displayReady && dbusReady ? "A graphical user session and session bus are available." : "The graphical user session or session bus is unavailable."));

  try {
    let browser = await probes.browser?.();
    if (browser === undefined) browser = await detectReviewedBrowser(config?.browser?.product ?? "auto");
    if (browser === undefined) throw new Error("browser unavailable");
    findings.push(doctorFinding("browser", "pass", "BROWSER_REVIEWED", `${browser.product} ${browser.version} is the reviewed executable.`));
  } catch { findings.push(doctorFinding("browser", "unavailable", "BROWSER_UNAVAILABLE", "No reviewed browser executable is available.")); }

  if (config?.backend !== "agentcursor") findings.push(doctorFinding("egress", "not-tested", "EGRESS_NOT_SELECTED", "Candidate egress is not selected by the legacy backend."));
  else {
    try {
      const response = await (probes.proxy ?? probeProxy)(config.proxy.host, config.proxy.port);
      if (!response.startsWith("HTTP/1.1 204 No Content\r\n") || !response.includes("\r\nWebX-Egress-Proxy: secure-egress/1\r\n")) throw new Error("wrong proxy");
      findings.push(doctorFinding("egress", "pass", "EGRESS_PROXY_HEALTHY", "The reviewed loopback egress proxy passed its branded health probe."));
    } catch { findings.push(doctorFinding("egress", "unavailable", "EGRESS_PROXY_UNAVAILABLE", "The selected reviewed egress proxy is unavailable or malformed.")); }
  }

  try {
    if (verified === undefined) throw new Error("release unavailable");
    const catalog = await (probes.authority ?? probeAuthority)(join(paths.runtimeRoot, "pi-web/webxd.sock"));
    if (catalog.apiVersion !== record(verified.manifest.versions, "manifest versions").publicWebX || !Array.isArray(catalog.capabilities)) throw new Error("authority version mismatch");
    for (const required of ["search", "read"]) {
      const capability = catalog.capabilities.find((item) => item?.id === required);
      if (capability?.enabled !== true || capability?.healthy !== true) throw new Error("required authority capability unavailable");
    }
    findings.push(doctorFinding("authority", "pass", "AUTHORITY_HEALTHY", "Trusted WebX authority and required search/read capabilities are healthy."));
  } catch { findings.push(doctorFinding("authority", "unavailable", "AUTHORITY_UNAVAILABLE", "Trusted WebX authority or a required capability is unavailable.")); }

  findings.push(doctorFinding("resource", config === undefined ? "error" : "not-tested", config === undefined ? "RESOURCE_CONFIG_INVALID" : "RESOURCE_ENFORCEMENT_NOT_TESTED", config === undefined ? "Resource configuration is unavailable." : "Resource limits are configured; live enforcement is not tested by doctor."));
  const workspacePresent = verified !== undefined && await exists(join(verified.releaseRoot, "bin/pi-browser-workspace"));
  findings.push(doctorFinding("workspace", workspacePresent ? "not-tested" : "error", workspacePresent ? "WORKSPACE_LIVE_NOT_TESTED" : "WORKSPACE_INVALID", workspacePresent ? "The workspace bundle is verified; live GUI readiness is not tested by doctor." : "The installed workspace bundle is missing or invalid."));

  if (JSON.stringify(findings.map((item) => item.category)) !== JSON.stringify(DOCTOR_CATEGORIES)) fail("doctor category set is invalid");
  const ok = findings.every((item) => item.status !== "error" && item.status !== "unavailable");
  return Object.freeze({ schemaVersion: 1, ok, releaseId: releaseId ?? null, backend: typeof config?.backend === "string" ? config.backend : null, findings });
}

/** @param {ReturnType<typeof doctorReport> extends Promise<infer T> ? T : never} report */
function renderDoctorHuman(report) { return `${report.findings.map((item) => `${item.status.toUpperCase()}\t${item.category}\t${item.code}\t${item.summary}`).join("\n")}\n`; }
/** @param {Awaited<ReturnType<typeof installationPreflight>>} report */
function renderPreflightHuman(report) {
  const findings = report.findings.map((item) => `${item.status.toUpperCase()}\t${item.category}\t${item.code}\t${item.summary}`).join("\n");
  return `${findings}${report.installCommand === null ? "" : `\nREVIEWED_INSTALL_COMMAND\t${report.installCommand}`}\n`;
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function status(paths, command) {
  const releaseId = await currentReleaseId(paths);
  const config = releaseId === undefined ? undefined : await readValidatedInstalledConfig(paths);
  let previousReleaseId = null;
  if (await exists(paths.deploymentPath)) {
    const deployment = record(await readJson(paths.deploymentPath), "deployment state");
    if (deployment.previousReleaseId !== undefined && (typeof deployment.previousReleaseId !== "string" || !/^phase4a-[0-9a-f]{40}$/u.test(deployment.previousReleaseId))) fail("deployment state is invalid");
    previousReleaseId = deployment.previousReleaseId ?? null;
  }
  return {
    ok: releaseId !== undefined,
    releaseId: releaseId ?? null,
    backend: config?.backend ?? null,
    previousReleaseId,
    services: serviceStates(command),
  };
}

/** @param {Record<string, string | boolean>} options @param {string[]} allowed */
function assertOptionSet(options, allowed) {
  if (Object.keys(options).some((name) => !allowed.includes(name))) fail("one or more options are not valid for this command");
}

async function main() {
  const { command: operation, subcommand, options } = parseCli(process.argv.slice(2));
  const paths = installedPaths();
  const systemctlCommand = "/usr/bin/systemctl";
  let result;
  if ((operation === "install" || operation === "preflight") && subcommand === undefined) {
    assertOptionSet(options, ["release", "expected-sha", "manifest-sha256", "json"]);
    if (typeof options.release !== "string" || typeof options["expected-sha"] !== "string" || !/^[0-9a-f]{40}$/u.test(options["expected-sha"]) || typeof options["manifest-sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(options["manifest-sha256"])) fail(`${operation} requires --release <immutable-release-root> --expected-sha <40-lowercase-hex> --manifest-sha256 <64-lowercase-hex>`);
    const releaseSource = resolve(options.release);
    const preflight = await installationPreflight(paths, systemctlCommand, releaseSource, options["expected-sha"], options["manifest-sha256"]);
    if (operation === "preflight" || !preflight.ok) {
      process.stdout.write(options.json === true ? `${JSON.stringify(preflight, null, 2)}\n` : renderPreflightHuman(preflight));
      if (!preflight.ok) process.exitCode = 1;
      return;
    }
    result = await installRelease(paths, systemctlCommand, releaseSource, options["expected-sha"], options["manifest-sha256"]);
  } else if (operation === "backend" && subcommand === "show") {
    assertOptionSet(options, ["json"]); const config = await readValidatedInstalledConfig(paths); result = { ok: true, backend: config.backend };
  } else if (operation === "backend" && (subcommand === "legacy" || subcommand === "agentcursor")) { assertOptionSet(options, ["json"]); result = await setBackend(paths, systemctlCommand, subcommand); }
  else if (operation === "rollback" && subcommand === undefined) { assertOptionSet(options, ["json"]); result = await rollbackRelease(paths, systemctlCommand); }
  else if (operation === "uninstall" && subcommand === undefined) { assertOptionSet(options, ["json", "purge"]); result = await uninstallCandidate(paths, systemctlCommand, options.purge === true); }
  else if (operation === "status" && subcommand === undefined) { assertOptionSet(options, ["json"]); result = await status(paths, systemctlCommand); }
  else if (operation === "doctor" && subcommand === undefined) {
    assertOptionSet(options, ["json"]); const report = await doctorReport(paths, systemctlCommand);
    process.stdout.write(options.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorHuman(report));
    if (!report.ok) process.exitCode = 1;
    return;
  } else if (operation === "version" && subcommand === undefined) {
    assertOptionSet(options, ["json"]); const releaseId = await currentReleaseId(paths); if (releaseId === undefined) fail("no current Phase 4A release is installed"); const verified = await verifyInstallRelease(join(paths.releasesRoot, releaseId)); result = { ok: true, releaseId, gitSha: verified.gitSha, manifestSha256: verified.manifestSha256 };
  } else fail("usage: pi-webctl {preflight|install} --release PATH --expected-sha SHA --manifest-sha256 DIGEST [--json] | doctor [--json] | status | version | backend show | backend legacy | backend agentcursor | rollback | uninstall [--purge]");
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
}

if (process.argv[1]) {
  let invoked;
  try { invoked = await realpath(process.argv[1]); } catch { invoked = undefined; }
  if (invoked && import.meta.url === pathToFileURL(invoked).href) main().catch((error) => {
    process.stderr.write(`pi-webctl: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
