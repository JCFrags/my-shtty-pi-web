#!/usr/bin/env node
// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInstalledConfig } from "./phase4a-config.mjs";
import { validateReleaseChecksums, validateReleaseManifest } from "./phase4a-release-format.mjs";

const releaseFile = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(releaseFile), "..");
const sourceRealRoot = await realpath(sourceRoot);
const releaseSchemaVersion = 1;
const expectedNodeMajor = 24;
const expectedPnpmVersion = "10.13.1";
const expectedRustVersion = "1.88.0";
const releasePrefix = "phase4a";

/** @typedef {Record<string, string>} CliOptions */
/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv }} CommandOptions */
/** @typedef {{ name: string, version: string, license?: string }} PackageManifest */
/** @typedef {{ path: string, manifest: PackageManifest }} PackageIdentity */
/** @typedef {{ path: string, sha256: string, bytes: number, mode: number }} FileRecord */
/** @typedef {{ schemaVersion: number, algorithm: string, excludes: string[], files: FileRecord[] }} ChecksumsDocument */
/** @typedef {{ schemaVersion?: unknown, releaseId?: unknown, gitSha?: unknown, dirtyTree?: unknown, backendDefault?: unknown, immutableFiles?: unknown }} ReleaseManifestIdentity */
/** @typedef {Record<string, string>} NormalizedRelease */
/** @typedef {{ id: string, name: string, version: string, license: string | null, license_file: string | null, manifest_path: string, source: string | null }} CargoPackage */
/** @typedef {{ pkg: string, dep_kinds: Array<{ kind: string | null, target: string | null }> }} CargoDependency */
/** @typedef {{ id: string, deps: CargoDependency[] }} CargoNode */
/** @typedef {{ packages: CargoPackage[], resolve: { nodes: CargoNode[] } }} CargoMetadata */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) { throw new Error(message); }
/**
 * @param {string | NodeJS.ArrayBufferView} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
/** @param {string} source */
function withFixedPythonInterpreter(source) {
  return `#!/usr/bin/python3\n${source.replace(/^#![^\r\n]*(?:\r?\n|$)/u, "")}`;
}
/**
 * @param {Array<string | undefined>} values
 * @returns {string[]}
 */
function definedPaths(values) {
  return /** @type {string[]} */ (values.filter((path) => typeof path === "string" && path !== ""));
}
/**
 * @param {string} file
 * @param {string[]} args
 * @param {CommandOptions} [options]
 * @returns {string}
 */
function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: options.cwd ?? sourceRoot, env: { ...process.env, ...options.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}
/**
 * @param {string[]} arguments_
 * @returns {{ operation: string, options: CliOptions }}
 */
function parse(arguments_) {
  const [operation, ...values] = arguments_;
  if (!operation || !["build", "verify", "reproducibility"].includes(operation)) fail("usage: phase4a-release.mjs <build|verify|reproducibility> [options]");
  const allowedOptions = new Set(operation === "build" ? ["output-root", "expected-sha", "tested-browser"] : operation === "verify" ? ["release-root", "expected-sha"] : ["work-root", "expected-sha", "tested-browser"]);
  /** @type {CliOptions} */
  const options = {};
  for (let index = 0; index < values.length; index++) {
    const name = values[index];
    const value = values[++index];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) fail(`invalid release option: ${name ?? "missing"}`);
    const key = name.slice(2);
    if (!allowedOptions.has(key)) fail(`unsupported ${operation} option: ${name}`);
    if (Object.hasOwn(options, key)) fail(`duplicate release option: ${name}`);
    options[key] = value;
  }
  return { operation, options };
}
/**
 * @param {CliOptions} options
 * @param {string} name
 * @returns {string}
 */
function required(options, name) {
  const value = options[name];
  if (!value) fail(`--${name} is required`);
  return value;
}
/**
 * @param {string} pathValue
 * @param {string} name
 * @returns {string}
 */
function assertAbsoluteOutsideSource(pathValue, name) {
  if (!isAbsolute(pathValue)) fail(`${name} must be absolute`);
  const path = resolve(pathValue);
  if (path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`)) fail(`${name} must be outside the source checkout`);
  return path;
}

/**
 * Reject a non-existent output below a symlink that resolves into the checkout.
 * @param {string} pathValue
 * @param {string} name
 */
async function resolvedOutsideSource(pathValue, name) {
  const path = assertAbsoluteOutsideSource(pathValue, name);
  let existing = path;
  /** @type {string[]} */
  const suffix = [];
  let canonical;
  for (;;) {
    try { canonical = await realpath(existing); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
  const projected = resolve(canonical, ...suffix);
  if (projected === sourceRealRoot || projected.startsWith(`${sourceRealRoot}${sep}`)) fail(`${name} resolves into the source checkout`);
  return path;
}
/**
 * @param {string} root
 * @param {boolean} [requireImmutableDirectories]
 * @returns {Promise<string[]>}
 */
async function regularFiles(root, requireImmutableDirectories = false) {
  /** @type {string[]} */
  const pending = [root];
  /** @type {string[]} */
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) fail("release traversal lost its directory");
    if (requireImmutableDirectories) {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || stats.gid !== process.getgid?.() || (stats.mode & 0o777) !== 0o555) fail(`release directory mode or ownership is invalid: ${relative(root, directory) || "."}`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else fail(`release contains a non-regular entry: ${relative(root, path)}`);
    }
  }
  return files.sort();
}
/** @param {string} path */
async function removeOwnedTree(path) {
  let information;
  try { information = await lstat(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!information.isDirectory()) { await rm(path, { force: true }); return; }
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) fail("cleanup traversal lost its directory");
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(directory, entry.name));
  }
  await rm(path, { recursive: true, force: true });
}
/**
 * Publish the already verified and sealed release with one atomic rename.
 * Directory rename authority comes from the writable parent, so the release
 * root never needs to become mutable under its final identity.
 * @param {string} releaseRoot
 * @param {string} finalRoot
 */
async function publishImmutableRelease(releaseRoot, finalRoot) {
  await rename(releaseRoot, finalRoot);
}

/**
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else fail(`source tree contains a non-regular entry: ${relative(sourceRoot, from)}`);
  }
}
/**
 * @param {string} input
 * @returns {Promise<PackageIdentity | undefined>}
 */
async function packageRootForInput(input) {
  let current = dirname(await realpath(resolve(sourceRoot, input)));
  while (current !== dirname(current)) {
    try {
      /** @type {Record<string, unknown>} */
      const parsed = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (typeof parsed.name === "string" && typeof parsed.version === "string") return { path: current, manifest: { name: parsed.name, version: parsed.version, ...(typeof parsed.license === "string" ? { license: parsed.license } : {}) } };
    } catch { /* Continue to the containing package. */ }
    current = dirname(current);
  }
  return undefined;
}
/**
 * @param {string} releaseRoot
 * @param {import("esbuild").Metafile[]} metafiles
 */
async function writeBundledLicenses(releaseRoot, metafiles) {
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      if (!input.includes("node_modules/")) continue;
      const found = await packageRootForInput(input);
      if (found === undefined) fail(`cannot identify bundled dependency: ${input}`);
      packages.set(`${found.manifest.name}@${found.manifest.version}`, found);
    }
  }
  const records = [];
  const licenseDirectory = join(releaseRoot, "share/licenses/node");
  await mkdir(licenseDirectory, { recursive: true });
  for (const [identity, dependency] of [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const candidates = (await readdir(dependency.path, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(entry.name));
    if (candidates.length === 0 || typeof dependency.manifest.license !== "string") fail(`bundled dependency lacks reviewed license metadata: ${identity}`);
    const source = join(dependency.path, candidates[0].name);
    const bytes = await readFile(source);
    const file = `${identity.replaceAll("/", "__").replaceAll("@", "_")}-${sha256(bytes).slice(0, 12)}.txt`;
    await writeFile(join(licenseDirectory, file), bytes);
    records.push({ name: dependency.manifest.name, version: dependency.manifest.version, license: dependency.manifest.license, licenseFile: `share/licenses/node/${file}`, licenseSha256: sha256(bytes) });
  }
  await writeFile(join(releaseRoot, "share/licenses/node-bundled-packages.json"), `${JSON.stringify({ schemaVersion: 1, packages: records }, null, 2)}\n`);
  return records;
}

/** @param {string} root */
async function deterministicTreeDigest(root) {
  const digest = createHash("sha256");
  for (const path of await regularFiles(root)) {
    digest.update(relative(root, path).replaceAll(sep, "/"));
    digest.update("\0");
    digest.update(await readFile(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** @param {string} releaseRoot */
async function writeRustLicenses(releaseRoot) {
  /** @type {CargoMetadata} */
  const metadata = JSON.parse(command("cargo", ["metadata", "--locked", "--format-version=1", "--filter-platform", "x86_64-unknown-linux-gnu"], { cwd: join(sourceRoot, "components/browser") }));
  if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes)) fail("Cargo metadata is incomplete");
  const packages = new Map(metadata.packages.map((package_) => [package_.id, package_]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.packages.find((package_) => package_.name === "pi-browser-workspace" && package_.source === null);
  if (root === undefined) fail("Tauri workspace package is missing from Cargo metadata");
  const pending = [root.id];
  const closure = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || closure.has(id)) continue;
    closure.add(id);
    const node = nodes.get(id);
    if (node === undefined) fail(`Cargo dependency node is missing: ${id}`);
    for (const dependency of node.deps) if (dependency.dep_kinds.some((kind) => kind.kind !== "dev")) pending.push(dependency.pkg);
  }
  const licenseDirectory = join(releaseRoot, "share/licenses/rust");
  await mkdir(licenseDirectory, { recursive: true });
  const records = [];
  for (const id of [...closure].sort()) {
    const package_ = packages.get(id);
    if (package_ === undefined || typeof package_.license !== "string" || package_.license.length === 0) fail(`Cargo package lacks license metadata: ${id}`);
    if (package_.source === null) {
      records.push({ name: package_.name, version: package_.version, license: package_.license, source: "workspace", licenseFiles: ["share/licenses/Pi-Browser-Workspace-LICENSE.txt"] });
      continue;
    }
    const packageRoot = dirname(package_.manifest_path);
    const entries = await readdir(packageRoot, { withFileTypes: true });
    const candidates = package_.license_file === null
      ? entries.filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice|unlicense)(?:[._-].*)?$/iu.test(entry.name)).map((entry) => join(packageRoot, entry.name))
      : [resolve(packageRoot, package_.license_file)];
    /** @type {string[]} */
    const licenseFiles = [];
    if (candidates.length === 0) {
      records.push({ name: package_.name, version: package_.version, license: package_.license, source: "crates.io", licenseFiles, notice: "The published crate declares this SPDX license expression but does not include a top-level license, copying, notice, or unlicense file." });
      continue;
    }
    for (const candidate of candidates.sort()) {
      const canonical = await realpath(candidate);
      if (canonical !== packageRoot && !canonical.startsWith(`${packageRoot}${sep}`)) fail(`Cargo license escapes its package: ${package_.name}@${package_.version}`);
      const bytes = await readFile(canonical);
      if (bytes.byteLength > 512 * 1024) fail(`Cargo license is unexpectedly large: ${package_.name}@${package_.version}`);
      const file = `${package_.name.replaceAll("/", "__").replaceAll("@", "_")}-${package_.version}-${sha256(bytes).slice(0, 12)}-${basename(canonical)}`;
      await writeFile(join(licenseDirectory, file), bytes);
      licenseFiles.push(`share/licenses/rust/${file}`);
    }
    records.push({ name: package_.name, version: package_.version, license: package_.license, source: "crates.io", licenseFiles });
  }
  await writeFile(join(releaseRoot, "share/licenses/rust-bundled-packages.json"), `${JSON.stringify({ schemaVersion: 1, target: "x86_64-unknown-linux-gnu", packages: records }, null, 2)}\n`);
  return records;
}
/**
 * @param {string} releaseRoot
 * @returns {Promise<import("esbuild").Metafile[]>}
 */
async function buildNodeBundles(releaseRoot) {
  const { build: esbuild } = await import("esbuild");
  const entries = [
    { input: "apps/browserd/src/main.ts", output: "bin/pi-web-browserd.mjs", external: [] },
    { input: "apps/webxd/src/main.ts", output: "bin/pi-web-webxd.mjs", external: [] },
    { input: "scripts/phase4a-qualification-runner.ts", output: "bin/pi-web-qualification-runner.mjs", external: [] },
    { input: "scripts/phase4a-qualification-pi-worker.ts", output: "bin/pi-web-qualification-pi-worker.mjs", external: [], alias: { "@earendil-works/pi-ai": join(sourceRoot, "scripts/phase4a-qualification-pi-ai-shim.ts"), "@earendil-works/pi-tui": join(sourceRoot, "scripts/phase4a-qualification-pi-tui-shim.ts") } },
    { input: "apps/pi-webx/src/index.ts", output: "share/pi-webx/extension.mjs", external: ["@earendil-works/*", "typebox"] },
  ];
  const metafiles = [];
  for (const entry of entries) {
    const result = await esbuild({ absWorkingDir: sourceRoot, entryPoints: [entry.input], outfile: join(releaseRoot, entry.output), bundle: true, platform: "node", format: "esm", target: "node24", packages: "bundle", external: entry.external, alias: entry.alias ?? {}, sourcemap: false, legalComments: "none", metafile: true, logLevel: "warning", charset: "utf8" });
    metafiles.push(result.metafile);
  }
  const normalized = metafiles.map((metafile, index) => ({ entry: entries[index].input, output: entries[index].output, inputs: Object.entries(metafile.inputs).map(([path, value]) => ({ path, bytes: value.bytes })).sort((a, b) => a.path.localeCompare(b.path)) }));
  await writeFile(join(releaseRoot, "share/build/node-bundle-inputs.json"), `${JSON.stringify({ schemaVersion: 1, bundles: normalized }, null, 2)}\n`);
  return metafiles;
}
/**
 * @param {string} tauriCli
 * @param {string} override
 * @param {boolean} qualification
 * @returns {string[]}
 */
function tauriBuildArguments(tauriCli, override, qualification) {
  return qualification
    ? [tauriCli, "build", "--config", override, "--features", "installed-qualification", "--no-bundle"]
    : [tauriCli, "build", "--config", override, "--bundles", "rpm"];
}
/**
 * @param {string} releaseRoot
 * @param {string} buildRoot
 * @param {string} sourceDateEpoch
 * @param {string} gitSha
 */
async function buildTauri(releaseRoot, buildRoot, sourceDateEpoch, gitSha) {
  const sourceArchive = join(buildRoot, "browser-source.tar");
  const sourceSnapshot = join(buildRoot, "source");
  await mkdir(sourceSnapshot, { recursive: true });
  command("git", ["archive", "--format=tar", `--output=${sourceArchive}`, gitSha, "components/browser"]);
  command("tar", ["-xf", sourceArchive, "-C", sourceSnapshot], { cwd: tmpdir() });
  await rm(sourceArchive);
  const browserSource = join(sourceSnapshot, "components/browser");
  const workspaceSource = join(browserSource, "apps/workspace");
  const frontend = join(workspaceSource, "dist");
  const cargoTarget = join(buildRoot, "cargo-target");
  await mkdir(frontend, { recursive: true });
  command("pnpm", ["--filter", "@pi-web/workspace", "exec", "vite", "build", "--outDir", frontend, "--emptyOutDir"]);
  const override = join(buildRoot, "tauri-release.json");
  await writeFile(override, `${JSON.stringify({ build: { beforeBuildCommand: "" }, bundle: { active: true, targets: ["rpm"] } }, null, 2)}\n`);
  const tauriCli = await realpath(join(sourceRoot, "components/browser/apps/workspace/node_modules/@tauri-apps/cli/tauri.js"));
  const remapRoots = definedPaths([buildRoot, sourceRoot, process.env.CARGO_HOME, process.env.RUSTUP_HOME, process.env.HOME]);
  const encodedRustFlags = [...new Set(remapRoots)].map((path, index) => `--remap-path-prefix=${path}=/usr/src/pi-web-${index}`).join("\x1f");
  const buildEnvironment = { CARGO_TARGET_DIR: cargoTarget, CARGO_ENCODED_RUSTFLAGS: encodedRustFlags, RUSTFLAGS: "", SOURCE_DATE_EPOCH: sourceDateEpoch };
  command(process.execPath, tauriBuildArguments(tauriCli, override, false), { cwd: workspaceSource, env: buildEnvironment });
  const binary = join(cargoTarget, "release/pi-browser-workspace");
  if (!(await lstat(binary)).isFile()) fail("Tauri release binary was not produced");
  await copyFile(binary, join(releaseRoot, "bin/pi-browser-workspace"));
  // The Tauri CLI supplies a remappable generated context. A direct Cargo
  // rebuild embeds the archived source directory in the qualification binary.
  command(process.execPath, tauriBuildArguments(tauriCli, override, true), { cwd: workspaceSource, env: buildEnvironment });
  if (!(await lstat(binary)).isFile()) fail("Tauri qualification release binary was not produced");
  await copyFile(binary, join(releaseRoot, "bin/pi-browser-workspace-qualification"));
  const rpmRoot = join(cargoTarget, "release/bundle/rpm");
  const rpms = (await regularFiles(rpmRoot)).filter((path) => path.endsWith(".rpm"));
  if (rpms.length !== 1) fail(`expected one Tauri RPM, found ${rpms.length}`);
  const rpmName = basename(rpms[0]);
  await copyFile(rpms[0], join(releaseRoot, `share/artifacts/${rpmName}`));
  return { binary: "bin/pi-browser-workspace", qualificationBinary: "bin/pi-browser-workspace-qualification", rpm: `share/artifacts/${rpmName}` };
}
/** @param {string} releaseRoot */
async function setImmutableModes(releaseRoot) {
  const pending = [releaseRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) fail("release mode traversal lost its directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) await chmod(path, path.includes(`${sep}bin${sep}`) ? 0o555 : 0o444);
      else fail(`release contains a non-regular entry: ${relative(releaseRoot, path)}`);
    }
    await chmod(directory, 0o555);
  }
}
/**
 * @param {string} releaseRoot
 * @param {string} path
 * @returns {Promise<FileRecord>}
 */
async function fileRecord(releaseRoot, path) {
  const bytes = await readFile(path);
  const stats = await lstat(path);
  return { path: relative(releaseRoot, path).replaceAll(sep, "/"), sha256: sha256(bytes), bytes: bytes.byteLength, mode: stats.mode & 0o777 };
}
/** @param {string} releaseRoot */
async function writeChecksums(releaseRoot) {
  /** @type {FileRecord[]} */
  const files = [];
  for (const path of await regularFiles(releaseRoot)) {
    if (relative(releaseRoot, path) === "checksums.json") continue;
    files.push(await fileRecord(releaseRoot, path));
  }
  await chmod(releaseRoot, 0o755);
  await writeFile(join(releaseRoot, "checksums.json"), `${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", excludes: ["checksums.json"], files }, null, 2)}\n`);
}

/** @param {string} releaseRoot */
async function immutablePayloadDigests(releaseRoot) {
  const records = [];
  for (const path of await regularFiles(releaseRoot)) {
    const name = relative(releaseRoot, path).replaceAll(sep, "/");
    if (name === "manifest.json" || name === "checksums.json") continue;
    const bytes = await readFile(path);
    records.push({ path: name, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return records;
}
/** @returns {Promise<{ node: string, pnpm: string, rust: string, tauriCli: string, tauriLibrary: string }>} */
async function toolchain() {
  const nodeVersion = process.versions.node;
  if (Number.parseInt(nodeVersion.split(".")[0], 10) !== expectedNodeMajor) fail(`Node ${expectedNodeMajor}.x is required, found ${nodeVersion}`);
  const pnpmVersion = command("pnpm", ["--version"]);
  if (pnpmVersion !== expectedPnpmVersion) fail(`pnpm ${expectedPnpmVersion} is required, found ${pnpmVersion}`);
  const rust = command("rustc", ["--version"], { cwd: join(sourceRoot, "components/browser") });
  if (!rust.startsWith(`rustc ${expectedRustVersion} `)) fail(`Rust ${expectedRustVersion} is required, found ${rust}`);
  const tauriCli = command("pnpm", ["--filter", "@pi-web/workspace", "exec", "tauri", "--version"]);
  const cargoLock = await readFile(join(sourceRoot, "components/browser/Cargo.lock"), "utf8");
  const tauriBlock = cargoLock.split("[[package]]").find((block) => /(?:^|\n)name = "tauri"(?:\n|$)/u.test(block));
  const tauriLibrary = tauriBlock === undefined ? undefined : /(?:^|\n)version = "([^"]+)"(?:\n|$)/u.exec(tauriBlock)?.[1];
  if (tauriLibrary === undefined) fail("locked Tauri library version is missing");
  return { node: nodeVersion, pnpm: pnpmVersion, rust, tauriCli, tauriLibrary };
}
/**
 * @param {string} expectedSha
 * @param {string} gitSha
 * @param {string} status
 */
function validateBuildIdentity(expectedSha, gitSha, status) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) fail("expected SHA must be forty lowercase hexadecimal characters");
  if (gitSha !== expectedSha) fail(`expected SHA ${expectedSha} does not match HEAD ${gitSha}`);
  if (status !== "") fail("release build requires a clean Git tree");
}

/** @param {CliOptions} options */
async function buildRelease(options) {
  const outputRoot = await resolvedOutsideSource(required(options, "output-root"), "output root");
  const expectedSha = required(options, "expected-sha");
  const gitSha = command("git", ["rev-parse", "HEAD"]);
  validateBuildIdentity(expectedSha, gitSha, command("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  command("pnpm", ["check:schemas"]);
  const initialLockSha256 = sha256(await readFile(join(sourceRoot, "pnpm-lock.yaml")));
  const releaseId = `${releasePrefix}-${gitSha}`;
  await mkdir(outputRoot, { recursive: true });
  const finalRoot = join(outputRoot, releaseId);
  try { await lstat(finalRoot); fail(`release already exists: ${finalRoot}`); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  const stageParent = await mkdtemp(join(outputRoot, ".phase4a-build-"));
  const releaseRoot = await mkdtemp(join(outputRoot, `.phase4a-release-${releaseId}-`));
  const buildRoot = join(stageParent, "build");
  await Promise.all(["bin", "share/artifacts", "share/build", "share/deploy", "share/icons", "share/licenses", "share/pi-webx/skills", "share/schemas"].map(async (path) => await mkdir(join(releaseRoot, path), { recursive: true })));
  let published = false;
  try {
    const tools = await toolchain();
    const commitTimestamp = command("git", ["show", "-s", "--format=%cI", gitSha]);
    const commitEpoch = command("git", ["show", "-s", "--format=%ct", gitSha]);
    const metafiles = await buildNodeBundles(releaseRoot);
    await writeBundledLicenses(releaseRoot, metafiles);
    const proxySource = await readFile(join(sourceRoot, "components/browser/scripts/secure_egress_proxy.py"), "utf8");
    const qualificationProxySource = await readFile(join(sourceRoot, "scripts/phase4a-qualification-proxy.py"), "utf8");
    const qualificationAtspiSource = await readFile(join(sourceRoot, "apps/webxd/tests/workspace-atspi.py"), "utf8");
    await writeFile(join(releaseRoot, "bin/pi-web-egress-proxy"), withFixedPythonInterpreter(proxySource));
    await writeFile(join(releaseRoot, "bin/pi-web-qualification-proxy"), withFixedPythonInterpreter(qualificationProxySource));
    await writeFile(join(releaseRoot, "bin/pi-web-qualification-atspi.py"), withFixedPythonInterpreter(qualificationAtspiSource));
    await Promise.all([
      copyFile(join(sourceRoot, "packages/browser-protocol/schema/browser-protocol.schema.json"), join(releaseRoot, "share/schemas/browser-protocol.schema.json")),
      copyFile(join(sourceRoot, "packages/workspace-protocol/schema/workspace-protocol.schema.json"), join(releaseRoot, "share/schemas/workspace-protocol.schema.json")),
      copyFile(join(sourceRoot, "packages/browser-runtime/third_party/agentcursor/LICENSE"), join(releaseRoot, "share/licenses/AgentCursor-LICENSE.txt")),
      copyFile(join(sourceRoot, "packages/browser-runtime/third_party/agentcursor/UPSTREAM.md"), join(releaseRoot, "share/licenses/AgentCursor-UPSTREAM.md")),
      copyFile(join(sourceRoot, "components/browser/LICENSE"), join(releaseRoot, "share/licenses/Pi-Browser-Workspace-LICENSE.txt")),
      copyTree(join(sourceRoot, "apps/pi-webx/skills"), join(releaseRoot, "share/pi-webx/skills")),
      copyTree(join(sourceRoot, "deploy/phase4a"), join(releaseRoot, "share/deploy")),
      copyFile(join(sourceRoot, "scripts/phase4a-config.mjs"), join(releaseRoot, "share/deploy/phase4a-config.mjs")),
      copyFile(join(sourceRoot, "scripts/pi-webctl.mjs"), join(releaseRoot, "bin/pi-webctl.mjs")),
      copyFile(join(sourceRoot, "scripts/phase4a-release-format.mjs"), join(releaseRoot, "bin/phase4a-release-format.mjs")),
      copyFile(join(sourceRoot, "components/browser/apps/workspace/src-tauri/icons/icon.png"), join(releaseRoot, "share/icons/pi-web-workspace.png")),
    ]);
    parseInstalledConfig(JSON.parse(await readFile(join(releaseRoot, "share/deploy/config/default.json"), "utf8")));
    await writeFile(join(releaseRoot, "share/pi-webx/package.json"), `${JSON.stringify({ name: "@webx/pi-webx-release", version: "0.1.0", private: true, type: "module", peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*", typebox: "*" }, pi: { extensions: ["./extension.mjs"], skills: ["./skills/webx"] } }, null, 2)}\n`);
    await writeRustLicenses(releaseRoot);
    const tauri = await buildTauri(releaseRoot, buildRoot, commitEpoch, gitSha);
    const packageLockSha256 = sha256(await readFile(join(sourceRoot, "pnpm-lock.yaml")));
    if (packageLockSha256 !== initialLockSha256) fail("pnpm lockfile changed during release dependency resolution");
    const agentCursorSourceSha256 = /Vendored source SHA-256: `([0-9a-f]{64})`/u.exec(await readFile(join(sourceRoot, "packages/browser-runtime/third_party/agentcursor/UPSTREAM.md"), "utf8"))?.[1];
    if (agentCursorSourceSha256 === undefined) fail("AgentCursor vendored-source digest is missing");
    if (await deterministicTreeDigest(join(sourceRoot, "packages/browser-runtime/src/vendor/agentcursor")) !== agentCursorSourceSha256) fail("AgentCursor vendored-source digest does not match the reviewed source");
    const manifest = {
      schemaVersion: releaseSchemaVersion, releaseId, gitSha, dirtyTree: false, buildTimestamp: commitTimestamp,
      toolchain: tools,
      versions: { publicWebX: "3.0.0", publicBrowserContract: "3.0.0", browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2" },
      agentCursor: { repository: "https://github.com/kumard3/agentcursor", version: "0.3.0", commit: "b23c633c66fd240f836f5edd1034f6fcf678e237", vendoredSourceSha256: agentCursorSourceSha256 },
      packageLockSha256, supportedFedora: [44], testedBrowser: options["tested-browser"] ?? "not-tested-at-build", buildMode: "release", backendDefault: "legacy",
      packaging: { node: "esbuild single-file ESM bundles with bundled dependency closure", proxy: "stdlib-only Python source with fixed Fedora interpreter", tauri: "release binary plus RPM", checksumAlgorithm: "sha256", checksumScopeExcludes: ["checksums.json"] },
      immutableFiles: await immutablePayloadDigests(releaseRoot),
      compatibility: { node: { minimumMajor: 24, maximumMajor: 24 }, rustBuild: expectedRustVersion, fedora: [44], webXApiMajor: 3, browserContractMajor: 3, browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2", defaultBackend: "legacy", candidateBackend: "agentcursor" },
      artifacts: tauri,
    };
    await writeFile(join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    validateBuildIdentity(expectedSha, command("git", ["rev-parse", "HEAD"]), command("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
    if (sha256(await readFile(join(sourceRoot, "pnpm-lock.yaml"))) !== initialLockSha256) fail("pnpm lockfile changed during release build");
    await setImmutableModes(releaseRoot);
    await writeChecksums(releaseRoot);
    await chmod(join(releaseRoot, "checksums.json"), 0o444);
    await chmod(releaseRoot, 0o555);
    const forbiddenBuildPaths = definedPaths([sourceRoot, stageParent, buildRoot, process.env.CARGO_HOME, process.env.RUSTUP_HOME, process.env.HOME]);
    await verifyRelease(releaseRoot, expectedSha, forbiddenBuildPaths, releaseId);
    await publishImmutableRelease(releaseRoot, finalRoot);
    published = true;
    const result = await verifyRelease(finalRoot, expectedSha, forbiddenBuildPaths);
    await removeOwnedTree(stageParent);
    process.stdout.write(`${JSON.stringify({ ok: true, releaseRoot: finalRoot, releaseId, manifestSha256: result.manifestSha256 }, null, 2)}\n`);
    return finalRoot;
  } catch (error) {
    await removeOwnedTree(stageParent).catch(() => undefined);
    await removeOwnedTree(releaseRoot).catch(() => undefined);
    if (published) await removeOwnedTree(finalRoot).catch(() => undefined);
    throw error;
  }
}
/** @param {string} source */
function validateFixedQualificationRunner(source) {
  if (!source.includes("soak-4h") || !/\b14400\b/u.test(source) || !/process\.argv\.length\s*===\s*3/u.test(source)) fail("release qualification runner lacks the fixed four-hour mode");
  if (/--(?:duration|seconds|minutes|hours)\b/u.test(source)) fail("release qualification runner exposes an arbitrary duration");
}
/**
 * @param {string} releaseRootValue
 * @param {string} [expectedSha]
 * @param {string[]} [forbiddenPaths]
 * @param {string} [stagedReleaseId]
 */
async function verifyRelease(releaseRootValue, expectedSha, forbiddenPaths = [sourceRoot], stagedReleaseId = undefined) {
  const releaseRoot = await resolvedOutsideSource(releaseRootValue, "release root");
  const rootStats = await lstat(releaseRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.uid !== process.getuid?.() || rootStats.gid !== process.getgid?.() || (rootStats.mode & 0o777) !== 0o555) fail("release root is not an immutable directory");
  const actual = (await regularFiles(releaseRoot, true)).map((path) => relative(releaseRoot, path).replaceAll(sep, "/")).filter((path) => path !== "checksums.json");
  const checksumStats = await lstat(join(releaseRoot, "checksums.json"));
  if (!checksumStats.isFile() || checksumStats.isSymbolicLink() || checksumStats.nlink !== 1 || checksumStats.uid !== process.getuid?.() || checksumStats.gid !== process.getgid?.() || (checksumStats.mode & 0o777) !== 0o444) fail("release checksum document mode is invalid");
  const manifestBytes = await readFile(join(releaseRoot, "manifest.json"));
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (expectedSha !== undefined && (!/^[0-9a-f]{40}$/u.test(expectedSha) || manifest.gitSha !== expectedSha)) fail("release manifest does not match the expected Git SHA");
  if (basename(releaseRoot) !== manifest.releaseId && stagedReleaseId !== manifest.releaseId) fail("release directory does not match its Git identity");
  const checksums = validateReleaseChecksums(JSON.parse(await readFile(join(releaseRoot, "checksums.json"), "utf8")));
  const listed = new Set();
  for (const record of checksums.files) {
    listed.add(record.path);
    const path = join(releaseRoot, record.path);
    const stats = await lstat(path);
    const expectedMode = record.path.startsWith("bin/") ? 0o555 : 0o444;
    if (record.mode !== expectedMode || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.uid !== process.getuid?.() || stats.gid !== process.getgid?.() || (stats.mode & 0o777) !== expectedMode) fail(`release file mode or ownership is invalid: ${record.path}`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) fail(`release checksum failed: ${record.path}`);
  }
  assert.deepEqual([...listed].sort(), actual.sort(), "release checksum inventory is incomplete");
  for (const required of ["bin/pi-webctl.mjs", "bin/phase4a-release-format.mjs", "bin/pi-web-qualification-proxy", "bin/pi-web-qualification-atspi.py", "bin/pi-web-qualification-runner.mjs", "bin/pi-web-qualification-pi-worker.mjs", "share/deploy/phase4a-config.mjs", "share/deploy/config/default.json"]) if (!listed.has(required)) fail(`release is missing required installed file: ${required}`);
  for (const artifact of Object.values(manifest.artifacts)) if (!listed.has(artifact)) fail("release manifest artifact is missing from the checksum inventory");
  assert.deepEqual(manifest.immutableFiles, await immutablePayloadDigests(releaseRoot), "release manifest payload digest inventory is invalid");
  command(process.execPath, ["--check", join(releaseRoot, "bin/pi-web-browserd.mjs")], { cwd: tmpdir() });
  command(process.execPath, ["--check", join(releaseRoot, "bin/pi-web-webxd.mjs")], { cwd: tmpdir() });
  const qualificationRunnerPath = join(releaseRoot, "bin/pi-web-qualification-runner.mjs");
  command(process.execPath, ["--check", qualificationRunnerPath], { cwd: tmpdir() });
  validateFixedQualificationRunner(await readFile(qualificationRunnerPath, "utf8"));
  command(process.execPath, ["--check", join(releaseRoot, "bin/pi-web-qualification-pi-worker.mjs")], { cwd: tmpdir() });
  command(process.execPath, ["--check", join(releaseRoot, "share/pi-webx/extension.mjs")], { cwd: tmpdir() });
  command(process.execPath, ["--check", join(releaseRoot, "share/deploy/phase4a-config.mjs")], { cwd: tmpdir() });
  command(process.execPath, ["--check", join(releaseRoot, "bin/pi-webctl.mjs")], { cwd: tmpdir() });
  command(process.execPath, ["--check", join(releaseRoot, "bin/phase4a-release-format.mjs")], { cwd: tmpdir() });
  parseInstalledConfig(JSON.parse(await readFile(join(releaseRoot, "share/deploy/config/default.json"), "utf8")));
  /** @type {Map<string, string>} */
  const deployUnits = new Map();
  for (const name of ["pi-web-agentcursor-egress-proxy.service", "pi-web-agentcursor-browserd.service", "webxd.service", "pi-web-qualification-egress-proxy.service", "pi-web-qualification-browserd.service", "pi-web-qualification-webxd.service"]) deployUnits.set(name, await readFile(join(releaseRoot, `share/deploy/systemd/${name}.in`), "utf8"));
  if (!deployUnits.get("pi-web-agentcursor-browserd.service")?.includes("Wants=pi-web-agentcursor-egress-proxy.service") || deployUnits.get("pi-web-agentcursor-browserd.service")?.includes("Requires=")) fail("release browserd unit dependency policy is invalid");
  if (!deployUnits.get("webxd.service")?.includes("Wants=pi-web-reader.service pi-web-searxng.service @BROWSERD_UNIT@") || deployUnits.get("webxd.service")?.includes("Requires=")) fail("release webxd unit dependency policy is invalid");
  for (const [name, unit] of deployUnits) {
    if (!unit.includes("Restart=on-failure") || !unit.includes("UMask=0077") || /(?:\/bin\/(?:ba)?sh|node_modules|tsx|ts-node|vite|cargo\/target)/u.test(unit)) fail(`release unit template is unsafe: ${name}`);
  }
  for (const forbiddenPath of new Set(forbiddenPaths)) {
    if (!isAbsolute(forbiddenPath)) fail("release forbidden-path marker must be absolute");
    const marker = Buffer.from(forbiddenPath);
    for (const path of await regularFiles(releaseRoot)) if ((await readFile(path)).includes(marker)) fail(`release contains an absolute build path in ${relative(releaseRoot, path)}`);
  }
  for (const name of ["pi-web-egress-proxy", "pi-web-qualification-proxy", "pi-web-qualification-atspi.py"]) {
    const proxy = await readFile(join(releaseRoot, `bin/${name}`), "utf8");
    if (!proxy.startsWith("#!/usr/bin/python3\n")) fail(`release proxy interpreter is not fixed: ${name}`);
    command("/usr/bin/python3", ["-c", "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], 'exec')", join(releaseRoot, `bin/${name}`)], { cwd: tmpdir() });
  }
  return { manifest, manifestSha256: sha256(manifestBytes) };
}
/**
 * @param {string} rpmPath
 * @returns {string}
 */
function normalizedRpmPayload(rpmPath) {
  const query = "[%{FILENAMES}\\t%{FILEDIGESTS}\\t%{FILESIZES}\\t%{FILEMODES:perms}\\t%{FILEUSERNAME}\\t%{FILEGROUPNAME}\\n]";
  return sha256(command("rpm", ["-qp", "--queryformat", query, rpmPath], { cwd: tmpdir() }).split("\n").sort().join("\n"));
}
/** @param {string} releaseRoot */
async function normalizedManifest(releaseRoot) {
  /** @type {Record<string, unknown> & { immutableFiles?: Array<{ path?: unknown, sha256?: unknown, bytes?: unknown }> }} */
  const parsed = JSON.parse(await readFile(join(releaseRoot, "manifest.json"), "utf8"));
  for (const record of parsed.immutableFiles ?? []) if (typeof record.path === "string" && record.path.endsWith(".rpm")) { record.sha256 = `rpm-payload:${normalizedRpmPayload(join(releaseRoot, record.path))}`; record.bytes = 0; }
  return parsed;
}

/**
 * @param {string} releaseRoot
 * @returns {Promise<NormalizedRelease>}
 */
async function normalizedRelease(releaseRoot) {
  /** @type {NormalizedRelease} */
  const files = {};
  for (const path of await regularFiles(releaseRoot)) {
    const name = relative(releaseRoot, path).replaceAll(sep, "/");
    if (name.endsWith(".rpm")) { files[name] = `rpm-payload:${normalizedRpmPayload(path)}`; continue; }
    if (name === "checksums.json") {
      /** @type {ChecksumsDocument} */
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const normalizedManifestSha256 = sha256(Buffer.from(JSON.stringify(await normalizedManifest(releaseRoot))));
      for (const record of parsed.files) {
        if (record.path.endsWith(".rpm")) { record.sha256 = `rpm-payload:${normalizedRpmPayload(join(releaseRoot, record.path))}`; record.bytes = 0; }
        else if (record.path === "manifest.json") { record.sha256 = `normalized-manifest:${normalizedManifestSha256}`; record.bytes = 0; }
      }
      files[name] = sha256(Buffer.from(JSON.stringify(parsed)));
      continue;
    }
    if (name === "manifest.json") {
      files[name] = sha256(Buffer.from(JSON.stringify(await normalizedManifest(releaseRoot))));
      continue;
    }
    files[name] = sha256(await readFile(path));
  }
  return files;
}
/** @param {CliOptions} options */
async function reproducibility(options) {
  const workRoot = await resolvedOutsideSource(required(options, "work-root"), "work root");
  const expectedSha = required(options, "expected-sha");
  try { await lstat(workRoot); fail(`reproducibility work root already exists: ${workRoot}`); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  await mkdir(workRoot, { recursive: true });
  const firstRoot = await buildRelease({ "output-root": join(workRoot, "first"), "expected-sha": expectedSha, "tested-browser": options["tested-browser"] ?? "not-tested-in-ci" });
  const secondRoot = await buildRelease({ "output-root": join(workRoot, "second"), "expected-sha": expectedSha, "tested-browser": options["tested-browser"] ?? "not-tested-in-ci" });
  assert.deepEqual(await normalizedRelease(firstRoot), await normalizedRelease(secondRoot), "release builds are not reproducible after reviewed RPM normalization");
  const report = { schemaVersion: 1, ok: true, gitSha: expectedSha, releaseId: basename(firstRoot), normalizedExceptions: [{ glob: "share/artifacts/*.rpm", reason: "RPM container metadata can contain build timestamps. Reproducibility compares the RPM file inventory, payload file digests, sizes, modes, owners, and groups; it does not ignore payload differences." }] };
  const reportPath = join(workRoot, "reproducibility.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, report: reportPath }, null, 2)}\n`);
}

export const releaseInternals = { assertAbsoluteOutsideSource, buildNodeBundles, buildRelease, deterministicTreeDigest, immutablePayloadDigests, normalizedRelease, parse, publishImmutableRelease, removeOwnedTree, resolvedOutsideSource, setImmutableModes, tauriBuildArguments, validateBuildIdentity, validateFixedQualificationRunner, verifyRelease, withFixedPythonInterpreter, writeBundledLicenses, writeChecksums, writeRustLicenses };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === releaseFile) {
  const { operation, options } = parse(process.argv.slice(2));
  if (operation === "build") await buildRelease(options);
  else if (operation === "verify") process.stdout.write(`${JSON.stringify({ ok: true, ...(await verifyRelease(required(options, "release-root"), required(options, "expected-sha"))) }, null, 2)}\n`);
  else await reproducibility(options);
}
