import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileHash = (file) => hash(fs.readFileSync(file));
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const objectHash = (value) => hash(JSON.stringify(canonical(value)));
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const digest = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());

function safePath(relative) {
  assert.equal(typeof relative, "string");
  assert(relative && !relative.includes("\\") && !relative.includes("\0") && !path.isAbsolute(relative));
  assert(relative.split("/").every((part) => part && part !== "." && part !== ".."));
}

export function inventory(root, exclude = []) {
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(relative ? `${relative}/${name}` : name);
      return;
    }
    if (exclude.includes(relative)) return;
    safePath(relative);
    assert.equal(stat.mode & 0o7000, 0, `special permission bits: ${relative}`);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      assert(!path.isAbsolute(target), `absolute symlink: ${relative}`);
      const resolved = fs.realpathSync(absolute);
      assert(resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`), `escaping symlink: ${relative}`);
      files.push({ path: relative, type: "symlink", target });
    } else {
      assert(stat.isFile(), `special file: ${relative}`);
      files.push({ path: relative, type: "file", mode, size: stat.size, sha256: fileHash(absolute) });
    }
  }
  walk("");
  return files;
}

export function sourceIdentity(root) {
  const files = [...new Set(git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))].sort();
  const inputs = files.map((relative) => {
    safePath(relative);
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return { path: relative, missing: true };
    const stat = fs.lstatSync(absolute);
    assert(stat.isFile(), `source must be a regular file: ${relative}`);
    return { path: relative, mode: stat.mode & 0o777, sha256: fileHash(absolute) };
  });
  return { commit: git(root, "rev-parse", "HEAD").trim(), dirty: Boolean(git(root, "status", "--porcelain", "--untracked-files=all").trim()), treeSha256: objectHash(inputs) };
}

export const electronExecutable = (platform) => platform.startsWith("linux") ? "electron/electron" : "electron/terminal-browser.app/Contents/MacOS/terminal-browser";
export const requiredFiles = (platform) => ["VERSION", "CHANNEL", "LICENSE", "bin/terminal-browser", "browser/dist/main.js", "browser/dist/runtime-check.js", "browser/dist/package.json", "browser/native/pixel.node", "cli/dist/main.js", "cli/dist/package.json", electronExecutable(platform), "agent-browser/bin/agent-browser", "assets/fonts/JetBrainsMono-Regular.ttf", "assets/fonts/LICENSE.txt", "assets/react-grab/index.global.js", "pi-extension/package.json", "pi-extension/dist/extension.js", "pi-extension/dist/client.js", "pi-extension/dist/web-research.js", "pi-extension/dist/launch.js", "pi-extension/dist/launch-mode.js", "herdr-plugin/herdr-plugin.toml", "herdr-plugin/launch.sh", "herdr-plugin/focus-companion.sh", "herdr-plugin/open-companion.sh", "scripts/dist-manifest.mjs", "metadata/pnpm-lock.yaml", "metadata/Cargo.lock", "metadata/upstreams.lock.json", "metadata/agent-browser-Cargo.lock", "licenses/node-packages.json", "licenses/rust-packages.json"];

export function validateManifest(manifest) {
  keys(manifest, ["schemaVersion", "artifactId", "identity", "files"]);
  assert.equal(manifest.schemaVersion, 1);
  digest(manifest.artifactId);
  const identity = manifest.identity;
  keys(identity, ["version", "channel", "platform", "source", "locks", "runtimes", "tools", "integrations"]);
  assert.match(identity.version, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.match(identity.channel, /^[a-z][a-z0-9-]*$/);
  assert(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(identity.platform));
  keys(identity.source, ["commit", "dirty", "treeSha256"]);
  assert.match(identity.source.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof identity.source.dirty, "boolean");
  digest(identity.source.treeSha256);
  keys(identity.locks, ["pnpm", "cargo", "upstreams", "agentBrowserCargo"]);
  Object.values(identity.locks).forEach(digest);
  keys(identity.runtimes, ["electron", "agentcursor", "agentBrowser"]);
  keys(identity.runtimes.electron, ["version", "archiveSha256"]);
  assert.equal(identity.runtimes.electron.version, "43.3.0");
  digest(identity.runtimes.electron.archiveSha256);
  keys(identity.runtimes.agentcursor, ["version", "commit"]);
  assert.equal(identity.runtimes.agentcursor.commit, "b23c633c66fd240f836f5edd1034f6fcf678e237");
  assert.equal(identity.runtimes.agentcursor.version, "0.3.0");
  keys(identity.runtimes.agentBrowser, ["tag", "commit"]);
  assert.equal(identity.runtimes.agentBrowser.tag, "v0.33.0");
  assert.equal(identity.runtimes.agentBrowser.commit, "1ed371f3af472cc0d6cd8fdaea75d1a085ff7534");
  keys(identity.tools, ["node", "pnpm", "rustc", "esbuild", "host"]);
  for (const value of Object.values(identity.tools)) assert.equal(typeof value, "string");
  keys(identity.integrations, ["pi", "herdr"]);
  keys(identity.integrations.pi, ["name", "version", "peerDependencies", "node"]);
  assert.equal(identity.integrations.pi.name, "pi-terminal-browser");
  keys(identity.integrations.pi.peerDependencies, ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]);
  for (const value of Object.values(identity.integrations.pi.peerDependencies)) assert.equal(typeof value, "string");
  assert.equal(typeof identity.integrations.pi.version, "string");
  assert.equal(typeof identity.integrations.pi.node, "string");
  keys(identity.integrations.herdr, ["id", "version", "minimumVersion"]);
  assert.equal(identity.integrations.herdr.id, "zenbu-labs.terminal-browser");
  assert.equal(typeof identity.integrations.herdr.version, "string");
  assert.equal(typeof identity.integrations.herdr.minimumVersion, "string");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0);
  const paths = new Set();
  for (const entry of manifest.files) {
    safePath(entry.path);
    assert.notEqual(entry.path, "build-manifest.json");
    assert(!paths.has(entry.path), `duplicate file: ${entry.path}`);
    paths.add(entry.path);
    if (entry.type === "file") {
      keys(entry, ["path", "type", "mode", "size", "sha256"]);
      assert(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777);
      assert(Number.isSafeInteger(entry.size) && entry.size >= 0);
      digest(entry.sha256);
    } else {
      keys(entry, ["path", "type", "target"]);
      assert.equal(entry.type, "symlink");
      assert.equal(typeof entry.target, "string");
      assert(!path.isAbsolute(entry.target));
      safePath(path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target)));
    }
  }
  const electron = electronExecutable(identity.platform);
  for (const required of requiredFiles(identity.platform)) {
    assert(paths.has(required), `missing required artifact file: ${required}`);
  }
  for (const executable of ["bin/terminal-browser", electron, "agent-browser/bin/agent-browser"]) {
    const entry = manifest.files.find((file) => file.path === executable);
    assert(entry.type === "file" && (entry.mode & 0o111), `not executable: ${executable}`);
  }
  assert.equal(manifest.artifactId, objectHash({ identity, files: manifest.files }));
  return manifest;
}

export function validateBundle(root, expectedArtifactId) {
  const manifest = validateManifest(readJson(path.join(root, "build-manifest.json")));
  if (expectedArtifactId !== undefined) assert.equal(manifest.artifactId, expectedArtifactId);
  assert.deepEqual(inventory(root, ["build-manifest.json"]), manifest.files, "artifact file inventory differs");
  assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), manifest.identity.version);
  assert.equal(fs.readFileSync(path.join(root, "CHANNEL"), "utf8").trim(), manifest.identity.channel);
  const locks = manifest.identity.locks;
  for (const [file, expected] of Object.entries({ "pnpm-lock.yaml": locks.pnpm, "Cargo.lock": locks.cargo, "upstreams.lock.json": locks.upstreams, "agent-browser-Cargo.lock": locks.agentBrowserCargo })) assert.equal(fileHash(path.join(root, "metadata", file)), expected);
  const pins = readJson(path.join(root, "metadata/upstreams.lock.json"));
  assert.equal(pins.electron.archives[manifest.identity.platform], manifest.identity.runtimes.electron.archiveSha256);
  const pi = readJson(path.join(root, "pi-extension/package.json"));
  assert.deepEqual(pi.peerDependencies, manifest.identity.integrations.pi.peerDependencies);
  assert.equal(pi.name, manifest.identity.integrations.pi.name);
  assert.equal(pi.version, manifest.identity.integrations.pi.version);
  assert.deepEqual(pi.pi.extensions, ["./dist/extension.js"]);
  return manifest;
}

export function validateArchive(archive, manifestFile) {
  const outer = readJson(manifestFile);
  keys(outer, ["schemaVersion", "version", "channel", "platform", "file", "sha256", "size", "published", "artifactId", "manifestSha256"]);
  assert.equal(outer.schemaVersion, 1);
  assert.match(outer.version, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.match(outer.channel, /^[a-z][a-z0-9-]*$/);
  assert(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(outer.platform));
  assert.equal(typeof outer.published, "string");
  assert(Number.isFinite(Date.parse(outer.published)));
  assert(Number.isSafeInteger(outer.size) && outer.size > 0);
  safePath(outer.file);
  assert.equal(path.basename(outer.file), outer.file);
  assert.equal(path.basename(archive), outer.file);
  digest(outer.sha256); digest(outer.artifactId); digest(outer.manifestSha256);
  assert.equal(fs.statSync(archive).size, outer.size);
  assert.equal(fileHash(archive), outer.sha256);
  return outer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [action, root, extra] = process.argv.slice(2);
  if (action === "source") writeJson(extra, sourceIdentity(root));
  else if (action === "verify") {
    const manifest = validateBundle(root);
    if (extra) {
      const outer = validateArchive(path.join(path.dirname(extra), readJson(extra).file), extra);
      assert.equal(outer.artifactId, manifest.artifactId);
      assert.equal(outer.manifestSha256, fileHash(path.join(root, "build-manifest.json")));
      for (const field of ["version", "channel", "platform"]) assert.equal(outer[field], manifest.identity[field]);
    }
    console.log(manifest.artifactId);
  } else throw new Error("usage: dist-manifest.mjs source ROOT OUTPUT | verify BUNDLE [OUTER_MANIFEST]");
}
