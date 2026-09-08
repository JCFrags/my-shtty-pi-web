import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { fileHash, inventory, objectHash, readJson, requiredFiles, validateArchive, validateBundle, validateManifest, writeJson } from "../dist-manifest.mjs";
import { validateClosure } from "../dist-seal.mjs";

import { root, fixture } from "./dist-fixture.mjs";

test("bundle verifier checks all bytes, modes, unexpected files and identity", (t) => {
  const { dir, manifest } = fixture(t);
  assert.equal(validateBundle(dir).artifactId, manifest.artifactId);
  assert.throws(() => validateBundle(dir, "0".repeat(64)));
  const file = path.join(dir, "browser/dist/main.js");
  fs.appendFileSync(file, "changed");
  assert.throws(() => validateBundle(dir));
  fs.writeFileSync(file, "browser/dist/main.js");
  fs.chmodSync(file, 0o755);
  assert.throws(() => validateBundle(dir));
  fs.chmodSync(file, manifest.files.find((entry) => entry.path === "browser/dist/main.js").mode);
  fs.writeFileSync(path.join(dir, "unexpected"), "extra");
  assert.throws(() => validateBundle(dir));
});

test("manifest rejects omitted components, traversal, duplicates, wrong pins and unknown fields", (t) => {
  const { manifest } = fixture(t);
  for (const mutate of [
    (m) => m.files.pop(),
    (m) => { m.files[0].path = "../escape"; },
    (m) => m.files.push(m.files[0]),
    (m) => { m.identity.runtimes.electron.version = "43.3.1"; },
    (m) => { m.identity.source.dirty = "false"; },
    (m) => { m.extra = true; },
  ]) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(() => validateManifest(candidate));
  }
});

test("inventory rejects links outside the artifact", (t) => {
  const { dir } = fixture(t);
  fs.symlinkSync("../outside", path.join(dir, "escape"));
  assert.throws(() => inventory(dir));
});

test("archive checksum and size must agree with strict outer metadata", (t) => {
  const { dir, manifest } = fixture(t);
  const archive = path.join(dir, "candidate.tar.gz");
  const outer = path.join(dir, "outer.json");
  fs.writeFileSync(archive, "archive bytes");
  writeJson(outer, { schemaVersion: 1, version: "test", channel: "dev", platform: "linux-x64", file: path.basename(archive), sha256: fileHash(archive), size: fs.statSync(archive).size, published: new Date().toISOString(), artifactId: manifest.artifactId, manifestSha256: fileHash(path.join(dir, "build-manifest.json")) });
  assert.equal(validateArchive(archive, outer).artifactId, manifest.artifactId);
  fs.writeFileSync(archive, "changed bytes");
  assert.throws(() => validateArchive(archive, outer));
});

test("compiled closure permits only Node builtins, Electron and staged pixel.node", () => {
  const meta = (names) => ({ outputs: { "main.js": { imports: names.map((name) => ({ path: name, external: true })) } } });
  assert.doesNotThrow(() => validateClosure(meta(["node:sqlite", "fs", "electron", "../native/pixel.node"])));
  for (const name of ["agentcursor", "better-sqlite3", "bufferutil", "../../checkout/file.js"]) assert.throws(() => validateClosure(meta([name])));
});

test("Pi source and generated bundle modes select explicit runners without touching live dist", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "browser launch "));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source/pi-extension/dist");
  execFileSync(path.join(root, "pi-extension/node_modules/.bin/tsc"), ["-p", path.join(root, "pi-extension/tsconfig.json"), "--outDir", source]);
  writeJson(path.join(temp, "source/pi-extension/package.json"), { type: "module" });
  const development = await import(pathToFileURL(path.join(source, "launch.js")).href);
  assert.deepEqual(development.cliCommand(["help"]), [process.execPath, [path.join(temp, "source/cli/dist/main.js"), "help"]]);
  const artifact = path.join(temp, "artifact");
  fs.cpSync(path.join(temp, "source"), artifact, { recursive: true });
  fs.writeFileSync(path.join(artifact, "pi-extension/dist/launch-mode.js"), 'export const launchMode = "bundle";\n');
  fs.mkdirSync(path.join(artifact, "bin"));
  const launcher = path.join(artifact, "bin/terminal-browser");
  fs.writeFileSync(launcher, "#!/bin/sh\nprintf '{\"ok\":true}'\n", { mode: 0o755 });
  const packaged = await import(pathToFileURL(path.join(artifact, "pi-extension/dist/launch.js")).href);
  assert.deepEqual(packaged.cliCommand(["help"]), [launcher, ["help"]]);
  fs.unlinkSync(launcher);
  assert.throws(() => packaged.cliCommand(["help"]));
  fs.symlinkSync(process.execPath, launcher);
  assert.throws(() => packaged.cliCommand(["help"]));
});
