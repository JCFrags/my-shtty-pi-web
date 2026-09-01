#!/usr/bin/env node
// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const UNITS = Object.freeze([
  "pi-web-agentcursor-egress-proxy.service",
  "pi-web-agentcursor-browserd.service",
  "webxd.service",
]);
const MARKER_NAME = ".pi-web-managed-v1";
const MARKER_VALUE = "pi-web-managed-root-v1\n";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

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
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_JSON_BYTES) fail(`unsafe JSON file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
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
 */
export async function verifyInstallRelease(releaseRootValue, expectedSha = undefined) {
  if (!isAbsolute(releaseRootValue)) fail("release root must be absolute");
  const releaseRoot = await realpath(releaseRootValue);
  const rootInformation = await lstat(releaseRoot);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink() || rootInformation.uid !== process.getuid?.() || (rootInformation.mode & 0o222) !== 0) fail("release root must be an owner-controlled immutable regular directory");
  const manifest = record(await readJson(join(releaseRoot, "manifest.json")), "release manifest");
  if (manifest.schemaVersion !== 1 || manifest.dirtyTree !== false || manifest.backendDefault !== "legacy" || typeof manifest.releaseId !== "string" || typeof manifest.gitSha !== "string" || !/^[0-9a-f]{40}$/u.test(manifest.gitSha)) fail("release manifest identity is invalid");
  if (basename(releaseRoot) !== manifest.releaseId || !manifest.releaseId.endsWith(manifest.gitSha)) fail("release directory does not match manifest identity");
  if (expectedSha !== undefined && manifest.gitSha !== expectedSha) fail("release Git SHA does not match the requested SHA");
  if (manifest.compatibility?.defaultBackend !== "legacy" || manifest.compatibility?.candidateBackend !== "agentcursor") fail("release backend compatibility is invalid");
  const checksums = record(await readJson(join(releaseRoot, "checksums.json")), "release checksums");
  if (checksums.schemaVersion !== 1 || checksums.algorithm !== "sha256" || !Array.isArray(checksums.files) || JSON.stringify(checksums.excludes) !== JSON.stringify(["checksums.json"])) fail("release checksum document is invalid");
  const listed = new Set();
  for (const itemValue of checksums.files) {
    const item = record(itemValue, "checksum record");
    if (typeof item.path !== "string" || item.path.startsWith("/") || item.path.split("/").includes("..") || listed.has(item.path) || typeof item.sha256 !== "string" || !Number.isSafeInteger(item.bytes) || !Number.isSafeInteger(item.mode)) fail("release checksum record is invalid");
    listed.add(item.path);
    const path = join(releaseRoot, item.path);
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1 || information.uid !== process.getuid?.() || (information.mode & 0o777) !== item.mode || (information.mode & 0o222) !== 0) fail(`release file mode or ownership is invalid: ${item.path}`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256) fail(`release checksum failed: ${item.path}`);
  }
  const actual = (await regularFiles(releaseRoot)).map((path) => relative(releaseRoot, path).replaceAll(sep, "/")).filter((path) => path !== "checksums.json");
  if (JSON.stringify([...listed].sort()) !== JSON.stringify(actual.sort())) fail("release checksum inventory is incomplete");
  for (const required of [
    "bin/pi-web-browserd.mjs",
    "bin/pi-web-webxd.mjs",
    "bin/pi-web-egress-proxy",
    "bin/pi-browser-workspace",
    "share/pi-webx/extension.mjs",
    "share/deploy/phase4a-config.mjs",
    "share/deploy/config/default.json",
    ...UNITS.map((name) => `share/deploy/systemd/${name}.in`),
  ]) if (!listed.has(required)) fail(`release is missing required installed file: ${required}`);
  return Object.freeze({ releaseRoot, releaseId: manifest.releaseId, gitSha: manifest.gitSha, manifest });
}

/** @param {string} root */
async function removeOwnedTree(root) {
  const information = await lstat(root);
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

/** @param {ReturnType<typeof installedPaths>} paths */
async function ensureManagedRoots(paths) {
  for (const root of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.stateRoot]) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const information = await lstat(root);
    if (!information.isDirectory() || information.isSymbolicLink()) fail(`managed root is unsafe: ${root}`);
    await chmod(root, 0o700);
    const marker = join(root, MARKER_NAME);
    if (await exists(marker)) {
      const markerInformation = await lstat(marker);
      if (!markerInformation.isFile() || markerInformation.isSymbolicLink() || await readFile(marker, "utf8") !== MARKER_VALUE) fail(`managed root marker is invalid: ${root}`);
    } else await atomicWrite(marker, MARKER_VALUE, 0o600);
  }
  await mkdir(paths.releasesRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.unitRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.binRoot, { recursive: true, mode: 0o755 });
  await mkdir(paths.applicationRoot, { recursive: true, mode: 0o755 });
  await mkdir(dirname(paths.extensionPath), { recursive: true, mode: 0o700 });
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
  const result = spawnSync(command, ["--user", ...arguments_], { encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (check && result.status !== 0) fail(`systemctl ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
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
  const errors = [];
  for (const [unit, stateValue] of Object.entries(states)) {
    const state = record(stateValue, "service state");
    try { systemctl(command, [state.enabled ? "enable" : "disable", unit], false); } catch (error) { errors.push(error); }
    try { systemctl(command, [state.active ? "start" : "stop", unit], false); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) fail("one or more prior service states could not be restored");
}

/** @param {string} value */
function desktopArgument(value) {
  if (/[%\0\r\n]/u.test(value)) fail("desktop executable path contains an unsafe byte");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} releaseRoot @param {Record<string, any>} config */
async function renderInstallation(paths, releaseRoot, config) {
  const modulePath = join(releaseRoot, "share/deploy/phase4a-config.mjs");
  const installedConfig = /** @type {any} */ (await import(`${pathToFileURL(modulePath).href}?release=${encodeURIComponent(basename(releaseRoot))}`));
  const parsed = installedConfig.parseInstalledConfig(config);
  const environment = installedConfig.serviceEnvironment(parsed, { releaseRoot: paths.currentLink, runtimeRoot: paths.runtimeRoot });
  await atomicWrite(paths.environmentPath, installedConfig.serializeEnvironmentFile(environment), 0o600);
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
    await atomicWrite(join(paths.unitRoot, name), rendered, 0o644);
  }
  await atomicLink(paths.extensionPath, join(paths.currentLink, "share/pi-webx"));
  await atomicLink(paths.controlLink, join(paths.currentLink, "bin/pi-webctl.mjs"));
  await atomicLink(paths.workspaceLink, join(paths.currentLink, "bin/pi-browser-workspace"));
  const desktop = `[Desktop Entry]\nType=Application\nName=Pi Web Workspace\nComment=Trusted local screenshot workspace\nExec=${desktopArgument(join(paths.currentLink, "bin/pi-browser-workspace"))}\nIcon=${join(paths.currentLink, "share/icons/pi-web-workspace.png")}\nTerminal=false\nCategories=Development;Utility;\nStartupNotify=true\nX-Pi-Web-Release=${basename(releaseRoot)}\n`;
  await atomicWrite(paths.desktopPath, desktop, 0o644);
  return parsed;
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} releaseSource @param {string | undefined} expectedSha */
async function stageRelease(paths, releaseSource, expectedSha = undefined) {
  const verified = await verifyInstallRelease(releaseSource, expectedSha);
  const destination = join(paths.releasesRoot, verified.releaseId);
  if (await exists(destination)) {
    const installed = await verifyInstallRelease(destination, verified.gitSha);
    if (installed.releaseId !== verified.releaseId) fail("installed release identity conflicts with staged release");
    return installed;
  }
  const stageParent = join(paths.releasesRoot, `.stage-${process.pid}-${randomBytes(6).toString("hex")}`);
  const temporary = join(stageParent, verified.releaseId);
  await mkdir(stageParent, { mode: 0o700 });
  await copyReleaseTree(verified.releaseRoot, temporary);
  await verifyInstallRelease(temporary, verified.gitSha).catch(async (error) => { await removeOwnedTree(stageParent); throw error; });
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  await chmod(destination, 0o555);
  await rm(stageParent, { recursive: true, force: true });
  return await verifyInstallRelease(destination, verified.gitSha);
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function currentReleaseId(paths) {
  try {
    const information = await lstat(paths.currentLink);
    if (!information.isSymbolicLink()) fail("current release pointer is not a symbolic link");
    const target = await readlink(paths.currentLink);
    const match = /^releases\/(phase4a-[0-9a-f]{40})$/u.exec(target);
    if (!match) fail("current release pointer target is invalid");
    return match[1];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string | undefined} releaseId */
async function setCurrent(paths, releaseId) { await atomicLink(paths.currentLink, releaseId === undefined ? undefined : `releases/${releaseId}`); }
/** @param {ReturnType<typeof installedPaths>} paths @param {string | undefined} releaseId */
async function setPrevious(paths, releaseId) { await atomicLink(paths.previousLink, releaseId === undefined ? undefined : `releases/${releaseId}`); }

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function captureActivation(paths, command) {
  return {
    currentReleaseId: await currentReleaseId(paths),
    previous: await snapshotPath(paths.previousLink),
    config: await snapshotPath(paths.configPath),
    managed: Object.fromEntries(await Promise.all(managedPaths(paths).map(async (path) => [path, await snapshotPath(path)]))),
    services: serviceStates(command),
  };
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {Record<string, any>} snapshot */
async function restoreActivation(paths, command, snapshot) {
  await setCurrent(paths, snapshot.currentReleaseId);
  await restorePath(paths.previousLink, record(snapshot.previous, "previous pointer snapshot"));
  await restorePath(paths.configPath, record(snapshot.config, "config snapshot"));
  for (const [path, value] of Object.entries(record(snapshot.managed, "managed path snapshots"))) await restorePath(path, record(value, "managed path snapshot"));
  systemctl(command, ["daemon-reload"], false);
  restoreServiceStates(command, record(snapshot.services, "service snapshots"));
}

/** @param {ReturnType<typeof installedPaths>} paths */
async function readInstalledConfig(paths) {
  if (!(await exists(paths.configPath))) return undefined;
  return record(await readJson(paths.configPath), "installed configuration");
}
/** @param {ReturnType<typeof installedPaths>} paths @param {Record<string, any>} config */
async function writeInstalledConfig(paths, config) { await atomicJson(paths.configPath, config); }

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {string} releaseSource @param {string | undefined} expectedSha */
export async function installRelease(paths, command, releaseSource, expectedSha = undefined) {
  await ensureManagedRoots(paths);
  const staged = await stageRelease(paths, releaseSource, expectedSha);
  const before = await captureActivation(paths, command);
  const firstInstall = before.currentReleaseId === undefined;
  if (firstInstall && !(await exists(paths.preinstallBackupPath))) await atomicJson(paths.preinstallBackupPath, before);
  let config = await readInstalledConfig(paths);
  if (config === undefined) config = record(await readJson(join(staged.releaseRoot, "share/deploy/config/default.json")), "default installed configuration");
  if (firstInstall) config.backend = "legacy";
  try {
    if (before.currentReleaseId !== undefined && before.currentReleaseId !== staged.releaseId) await setPrevious(paths, before.currentReleaseId);
    await setCurrent(paths, staged.releaseId);
    const parsed = await renderInstallation(paths, staged.releaseRoot, config);
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    systemctl(command, ["enable", "webxd.service"]);
    if (parsed.backend === "agentcursor") {
      systemctl(command, ["enable", "pi-web-agentcursor-egress-proxy.service"]);
      systemctl(command, ["enable", "pi-web-agentcursor-browserd.service"]);
      systemctl(command, ["restart", "pi-web-agentcursor-egress-proxy.service"]);
      systemctl(command, ["restart", "pi-web-agentcursor-browserd.service"]);
    } else {
      systemctl(command, ["disable", "--now", "pi-web-agentcursor-browserd.service"], false);
      systemctl(command, ["disable", "--now", "pi-web-agentcursor-egress-proxy.service"], false);
    }
    systemctl(command, ["daemon-reload"]);
    systemctl(command, ["restart", "webxd.service"]);
    const requiredUnits = parsed.backend === "agentcursor" ? UNITS : ["webxd.service"];
    for (const unit of requiredUnits) if (systemctl(command, ["is-active", "--quiet", unit], false).status !== 0) fail(`candidate service is not active: ${unit}`);
    const priorDeployment = await exists(paths.deploymentPath) ? record(await readJson(paths.deploymentPath), "deployment state") : undefined;
    await atomicJson(paths.deploymentPath, {
      schemaVersion: 1,
      currentReleaseId: staged.releaseId,
      currentBackend: parsed.backend,
      previousReleaseId: before.currentReleaseId,
      previousBackend: priorDeployment?.currentBackend ?? (before.currentReleaseId === undefined ? undefined : "legacy"),
      failedReleaseRetained: false,
    });
    return { ok: true, releaseId: staged.releaseId, gitSha: staged.gitSha, backend: parsed.backend, previousReleaseId: before.currentReleaseId ?? null };
  } catch (error) {
    await restoreActivation(paths, command, before).catch(() => undefined);
    await atomicJson(paths.failurePath, { schemaVersion: 1, failedReleaseId: staged.releaseId, error: error instanceof Error ? error.message.slice(0, 2_000) : "activation failed", releaseRetained: true });
    throw error;
  }
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {"legacy" | "agentcursor"} backend */
export async function setBackend(paths, command, backend) {
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
    const parsed = await renderInstallation(paths, releaseRoot, config);
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    if (backend === "agentcursor") {
      systemctl(command, ["enable", "--now", "pi-web-agentcursor-egress-proxy.service"]);
      systemctl(command, ["enable", "--now", "pi-web-agentcursor-browserd.service"]);
    } else {
      systemctl(command, ["disable", "--now", "pi-web-agentcursor-browserd.service"], false);
      systemctl(command, ["disable", "--now", "pi-web-agentcursor-egress-proxy.service"], false);
    }
    systemctl(command, ["restart", "webxd.service"]);
    if (systemctl(command, ["is-active", "--quiet", "webxd.service"], false).status !== 0) fail("webxd is not active after backend change");
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
export async function rollbackRelease(paths, command) {
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
    await setCurrent(paths, deployment.previousReleaseId);
    await setPrevious(paths, before.currentReleaseId);
    const parsed = await renderInstallation(paths, previousRoot, config);
    await writeInstalledConfig(paths, parsed);
    systemctl(command, ["daemon-reload"]);
    for (const unit of UNITS) systemctl(command, ["restart", unit]);
    if (systemctl(command, ["is-active", "--quiet", "webxd.service"], false).status !== 0) fail("webxd is not active after release rollback");
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
  if (!information.isDirectory() || information.isSymbolicLink()) fail(`managed root is unsafe: ${root}`);
  const marker = join(root, MARKER_NAME);
  const markerInformation = await lstat(marker);
  if (!markerInformation.isFile() || markerInformation.isSymbolicLink() || await readFile(marker, "utf8") !== MARKER_VALUE) fail(`managed root ownership marker is invalid: ${root}`);
}
/** @param {ReturnType<typeof installedPaths>} paths @param {string} command @param {boolean} purge */
export async function uninstallCandidate(paths, command, purge = false) {
  for (const unit of UNITS) {
    systemctl(command, ["disable", "--now", unit], false);
  }
  if (await exists(paths.preinstallBackupPath)) {
    const backup = record(await readJson(paths.preinstallBackupPath), "preinstall backup");
    const retainedConfig = await snapshotPath(paths.configPath);
    await restoreActivation(paths, command, backup);
    if (record(backup.config, "preinstall config snapshot").kind === "missing" && retainedConfig.kind === "file") await restorePath(paths.configPath, retainedConfig);
  } else {
    for (const path of managedPaths(paths)) await rm(path, { force: true });
    await setCurrent(paths, undefined);
    await setPrevious(paths, undefined);
    systemctl(command, ["daemon-reload"], false);
  }
  if (await exists(paths.releasesRoot)) {
    for (const name of await readdir(paths.releasesRoot)) {
      if (!/^phase4a-[0-9a-f]{40}$/u.test(name)) continue;
      const release = join(paths.releasesRoot, name);
      await verifyInstallRelease(release);
      await removeOwnedTree(release);
    }
  }
  for (const path of [paths.deploymentPath, paths.failurePath, paths.preinstallBackupPath]) await rm(path, { force: true });
  if (purge) {
    for (const root of [paths.cacheRoot, paths.stateRoot, paths.configRoot, paths.dataRoot]) {
      if (!(await exists(root))) continue;
      await verifyManagedRoot(root);
      await rm(root, { recursive: true });
    }
  }
  return { ok: true, purged: purge, legacyPreserved: true };
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
  const binRoot = environment.PI_WEB_BIN_HOME ?? join(home, ".local/bin");
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
    currentLink: join(dataRoot, "current"),
    previousLink: join(dataRoot, "previous"),
    unitRoot: join(configHome, "systemd/user"),
    applicationRoot: join(dataHome, "applications"),
    configPath: join(configRoot, "config.json"),
    environmentPath: join(configRoot, "service.env"),
    deploymentPath: join(stateRoot, "deployment.json"),
    failurePath: join(stateRoot, "last-activation-failure.json"),
    preinstallBackupPath: join(stateRoot, "preinstall-backup.json"),
    desktopPath: join(dataHome, "applications/pi-web-workspace.desktop"),
    extensionPath: join(home, ".pi/agent/extensions/pi-web"),
    controlLink: join(binRoot, "pi-webctl"),
    workspaceLink: join(binRoot, "pi-web-workspace"),
  });
}

/** @param {string[]} arguments_ */
function parseCli(arguments_) {
  const [command, subcommand, ...rest] = arguments_;
  const allowed = new Set(["--release", "--expected-sha", "--json", "--purge"]);
  /** @type {Record<string, string | boolean>} */
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (!allowed.has(name)) fail(`unsupported option: ${name}`);
    if (name === "--json" || name === "--purge") { options[name.slice(2)] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    options[name.slice(2)] = value;
  }
  return { command, subcommand, options };
}

/** @param {ReturnType<typeof installedPaths>} paths @param {string} command */
async function status(paths, command) {
  const releaseId = await currentReleaseId(paths);
  const config = await readInstalledConfig(paths);
  return {
    ok: releaseId !== undefined,
    releaseId: releaseId ?? null,
    backend: config?.backend ?? null,
    previousReleaseId: await exists(paths.deploymentPath) ? (await readJson(paths.deploymentPath)).previousReleaseId ?? null : null,
    services: serviceStates(command),
    paths: { data: paths.dataRoot, config: paths.configRoot, state: paths.stateRoot },
  };
}

async function main() {
  const { command: operation, subcommand, options } = parseCli(process.argv.slice(2));
  const paths = installedPaths();
  const systemctlCommand = "/usr/bin/systemctl";
  let result;
  if (operation === "install" && subcommand === undefined) {
    if (typeof options.release !== "string" || typeof options["expected-sha"] !== "string" || !/^[0-9a-f]{40}$/u.test(options["expected-sha"])) fail("install requires --release <immutable-release-root> --expected-sha <40-lowercase-hex>");
    result = await installRelease(paths, systemctlCommand, resolve(options.release), options["expected-sha"]);
  } else if (operation === "backend" && subcommand === "show") {
    const config = await readInstalledConfig(paths); if (config === undefined) fail("installed configuration is missing"); result = { ok: true, backend: config.backend };
  } else if (operation === "backend" && (subcommand === "legacy" || subcommand === "agentcursor")) result = await setBackend(paths, systemctlCommand, subcommand);
  else if (operation === "rollback" && subcommand === undefined) result = await rollbackRelease(paths, systemctlCommand);
  else if (operation === "uninstall" && subcommand === undefined) result = await uninstallCandidate(paths, systemctlCommand, options.purge === true);
  else if (operation === "status" && subcommand === undefined) result = await status(paths, systemctlCommand);
  else if (operation === "version" && subcommand === undefined) {
    const releaseId = await currentReleaseId(paths); if (releaseId === undefined) fail("no current Phase 4A release is installed"); const verified = await verifyInstallRelease(join(paths.releasesRoot, releaseId)); result = { ok: true, releaseId, gitSha: verified.gitSha };
  } else fail("usage: pi-webctl {install --release PATH --expected-sha SHA|status|version|backend show|backend legacy|backend agentcursor|rollback|uninstall [--purge]}");
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
