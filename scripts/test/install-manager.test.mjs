import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { activate, rollback, stage, status } from "../install-manager.mjs";
import { fileHash, inventory, objectHash, writeJson } from "../dist-manifest.mjs";
import { fixture, root as repository } from "./dist-fixture.mjs";

function sandbox(t, fresh = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "install");
  fs.mkdirSync(root, { mode: 0o700 });
  const settings = path.join(home, "settings.json");
  if (!fresh) writeJson(settings, { packages: ["first", { source: "packages/pi-terminal-browser", extensions: ["+dist/extension.js"], skills: [], autoload: true }, "last"], canary: "private-settings-do-not-report" });
  const selection = { cli: path.join(home, "terminal-browser"), herdr: path.join(home, "herdr-plugin"), piSettings: settings, piSource: fresh ? null : "packages/pi-terminal-browser" };
  selection.herdrRegistry = path.join(home, "plugins.json");
  selection.herdrSource = fresh ? null : path.join(home, "original-herdr");
  if (!fresh) writeJson(selection.herdrRegistry, [{plugin_id:"unrelated",enabled:true}, {plugin_id:"zenbu-labs.terminal-browser",name:"Terminal Browser",version:"0.2.0",plugin_root:selection.herdrSource,manifest_path:path.join(selection.herdrSource,"herdr-plugin.toml"),enabled:true,build:[{command:["pnpm","build"]}],source:{kind:"local"}}, {plugin_id:"other",enabled:true}]);
  const paths = Object.fromEntries(["appData", "cacheHome", "dataHome", "interopState", "interopShare", "runtimeHome", "stateHome"].map((key) => [key, path.join(home, key)]));
  const receipt = path.join(home, "receipt.json");
  writeJson(receipt, { schemaVersion: 1, namespace: "terminal-browser-dev-61753e09", paths, selection });
  fs.chmodSync(receipt, 0o600);
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(repository, "scripts/install-manager.mjs"), ...args], { encoding: "utf8" }));
  run("configure", root, receipt);
  assert(run("configure", root, receipt).repeated);
  return { home, root, settings, selection, paths, run };
}
function archive(t, change = () => {}) {
  const { dir, manifest } = fixture(t);
  change(dir, manifest);
  fs.unlinkSync(path.join(dir, "build-manifest.json"));
  manifest.files = inventory(dir);
  manifest.artifactId = objectHash({ identity: manifest.identity, files: manifest.files });
  writeJson(path.join(dir, "build-manifest.json"), manifest);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-archive-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const bundle = path.join(output, "terminal-browser");
  fs.cpSync(dir, bundle, { recursive: true });
  const tarball = path.join(output, "terminal-browser-linux-x64.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", output, "terminal-browser"]);
  const outerFile = path.join(output, "manifest.json");
  const outer = { schemaVersion: 1, version: manifest.identity.version, channel: "dev", platform: "linux-x64", file: path.basename(tarball), sha256: fileHash(tarball), size: fs.statSync(tarball).size, published: new Date().toISOString(), artifactId: manifest.artifactId, manifestSha256: fileHash(path.join(bundle, "build-manifest.json")) };
  writeJson(outerFile, outer);
  return { tarball, outerFile, outer, manifest };
}

test("fresh and repeated install; stage never selects; rollback retains releases", (t) => {
  const box = sandbox(t, true);
  const candidate = archive(t);
  assert.equal(stage(candidate.tarball, candidate.outerFile, box.root).candidate, candidate.manifest.artifactId);
  assert(stage(candidate.tarball, candidate.outerFile, box.root).repeated);
  assert.equal(status(box.root).selected, null);
  assert(!fs.existsSync(box.selection.cli));
  const result = activate(box.root, candidate.manifest.artifactId);
  assert.equal(result.selected, candidate.manifest.artifactId);
  assert(activate(box.root, candidate.manifest.artifactId).repeated);
  assert.equal(JSON.parse(fs.readFileSync(box.settings)).packages.length, 1);
  rollback(box.root);
  assert.equal(status(box.root).selected, null);
  assert(!fs.existsSync(box.settings));
  assert(!fs.existsSync(box.selection.herdrRegistry));
  assert(!fs.existsSync(box.selection.cli));
  assert.equal(status(box.root).candidates.length, 1);
});

test("A/B activation preserves exact Pi slot, filters, unrelated subsequent edits and original launcher", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.selection.cli, "#!/bin/sh\necho prior\n", { mode: 0o755 });
  const a = archive(t);
  const b = archive(t, (dir, manifest) => { fs.appendFileSync(path.join(dir, "browser/dist/main.js"), " B"); manifest.identity.source.commit = "b".repeat(40); });
  stage(a.tarball, a.outerFile, box.root);
  activate(box.root, a.manifest.artifactId);
  const selected = fs.readlinkSync(box.selection.cli);
  const before = fs.readFileSync(box.settings, "utf8");
  stage(b.tarball, b.outerFile, box.root);
  assert.equal(fs.readlinkSync(box.selection.cli), selected);
  assert.equal(fs.readFileSync(box.settings, "utf8"), before);
  activate(box.root, b.manifest.artifactId);
  const settings = JSON.parse(fs.readFileSync(box.settings));
  assert.equal(settings.packages[0], "first");
  assert.equal(settings.packages[2], "last");
  assert.deepEqual(settings.packages[1].extensions, ["+dist/extension.js"]);
  const plugins = JSON.parse(fs.readFileSync(box.selection.herdrRegistry));
  assert.equal(plugins[1].plugin_root, path.join(box.root,"releases",b.manifest.artifactId,"terminal-browser/herdr-plugin"));
  assert.deepEqual(plugins[1].build,[]);
  plugins[0].unrelated = "retained"; plugins[1].enabled = false;
  writeJson(box.selection.herdrRegistry, plugins);
  settings.unrelated = { retained: true };
  settings.packages[1].skills = ["+new-skill"];
  writeJson(box.settings, settings);
  rollback(box.root);
  const restored = JSON.parse(fs.readFileSync(box.settings));
  const restoredHerdr=JSON.parse(fs.readFileSync(box.selection.herdrRegistry));
  assert.equal(restoredHerdr[0].unrelated,"retained");
  assert.equal(restoredHerdr[1].enabled,false);
  assert.equal(restoredHerdr[1].plugin_root,path.join(box.root,"releases",a.manifest.artifactId,"terminal-browser/herdr-plugin"));
  assert.equal(fs.readlinkSync(box.selection.cli), selected);
  assert.deepEqual(restored.unrelated, { retained: true });
  assert.deepEqual(restored.packages[1].skills, ["+new-skill"]);
  assert.equal(restored.packages[1].source, JSON.parse(before).packages[1].source);
  rollback(box.root);
  assert.equal(fs.readFileSync(box.selection.cli, "utf8"), "#!/bin/sh\necho prior\n");
  assert.equal(JSON.parse(fs.readFileSync(box.selection.herdrRegistry))[1].plugin_root,box.selection.herdrSource);
});

test("activation failure restores scoped selections and refuses unrelated changed links", (t) => {
  const box = sandbox(t);
  const a = archive(t);
  stage(a.tarball, a.outerFile, box.root);
  const receipt = JSON.parse(fs.readFileSync(path.join(box.root, "installation.json")));
  receipt.selection.herdr = path.join(box.home, "missing-parent", "herdr");
  writeJson(path.join(box.root, "installation.json"), receipt);
  const before = fs.readFileSync(box.settings, "utf8");
  const herdrBefore = fs.readFileSync(box.selection.herdrRegistry, "utf8");
  assert.throws(() => activate(box.root, a.manifest.artifactId));
  assert.equal(fs.readFileSync(box.settings, "utf8"), before);
  assert.equal(fs.readFileSync(box.selection.herdrRegistry, "utf8"), herdrBefore);
  assert(!fs.existsSync(box.selection.cli));
  fs.mkdirSync(path.dirname(receipt.selection.herdr));
  activate(box.root, a.manifest.artifactId);
  fs.unlinkSync(box.selection.cli);
  fs.symlinkSync("/unrelated", box.selection.cli);
  assert.throws(() => rollback(box.root));
  assert.equal(fs.readlinkSync(box.selection.cli), "/unrelated");
});

test("corrupt, incomplete, wrong target and wrong runtime archives do not stage", (t) => {
  const box = sandbox(t);
  const corrupt = archive(t);
  fs.appendFileSync(corrupt.tarball, "corrupt");
  assert.throws(() => stage(corrupt.tarball, corrupt.outerFile, box.root));
  const incomplete = archive(t, (dir) => fs.unlinkSync(path.join(dir, "pi-extension/dist/extension.js")));
  assert.throws(() => stage(incomplete.tarball, incomplete.outerFile, box.root));
  const target = archive(t);
  target.outer.platform = "darwin-x64";
  writeJson(target.outerFile, target.outer);
  assert.throws(() => stage(target.tarball, target.outerFile, box.root));
  const runtime = archive(t, (_dir, manifest) => { manifest.identity.runtimes.electron.version = "wrong"; });
  assert.throws(() => stage(runtime.tarball, runtime.outerFile, box.root));
  assert.equal(status(box.root).candidates.length, 0);
});

test("archive extraction rejects traversal, external links, link writes, hardlinks and duplicate paths before writing", (t) => {
  const box = sandbox(t);
  for (const kind of ["traversal", "absolute", "link", "link-write", "hardlink", "duplicate"]) {
    const tarball = path.join(box.home, `${kind}.tar.gz`);
    execFileSync("python3", ["-c", `import tarfile,io,sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
 k=sys.argv[2]
 name={'traversal':'terminal-browser/../../escape','absolute':'/escape'}.get(k,'terminal-browser/file')
 m=tarfile.TarInfo(name)
 if k in ('link','link-write','hardlink'):
  m.type=tarfile.LNKTYPE if k=='hardlink' else tarfile.SYMTYPE
  m.linkname='/tmp/escape' if k=='link' else 'target'
 t.addfile(m)
 if k=='duplicate': t.addfile(m)
 if k=='link-write': t.addfile(tarfile.TarInfo('terminal-browser/file/child'))
`, tarball, kind]);
    const destination = path.join(box.home, kind);
    fs.mkdirSync(destination);
    assert.throws(() => execFileSync("python3", [path.join(repository, "scripts/extract-dist.py"), tarball, destination], { stdio: "pipe" }));
    assert.deepEqual(fs.readdirSync(destination), []);
  }
});

test("activation refuses mutable state aliases and release-root state without touching selections", (t) => {
  const box = sandbox(t), candidate = archive(t);
  stage(candidate.tarball, candidate.outerFile, box.root);
  const file = path.join(box.root, "installation.json"), receipt = JSON.parse(fs.readFileSync(file));
  const before = fs.readFileSync(box.settings, "utf8");
  fs.mkdirSync(box.paths.dataHome);fs.mkdirSync(path.join(box.home,"elsewhere"));fs.symlinkSync(path.join(box.home,"elsewhere"),path.join(box.paths.dataHome,receipt.namespace));
  assert.throws(()=>activate(box.root,candidate.manifest.artifactId));
  assert.equal(fs.readFileSync(box.settings,"utf8"),before);
  receipt.paths.dataHome=path.join(box.root,"releases");writeJson(file,receipt);
  assert.throws(()=>activate(box.root,candidate.manifest.artifactId));
  assert.equal(fs.readFileSync(box.settings,"utf8"),before);
});

test("SIGKILL at every activation and rollback write has explicit repeatable recovery", (t) => {
  const box = sandbox(t), a = archive(t), b = archive(t, (dir, manifest) => {
    fs.appendFileSync(path.join(dir, "browser/dist/main.js"), " B");
    manifest.identity.source.commit = "b".repeat(40);
  });
  for (const candidate of [a, b]) stage(candidate.tarball, candidate.outerFile, box.root);
  activate(box.root, a.manifest.artifactId);
  const hook = path.join(box.home, "crash.cjs");
  fs.writeFileSync(hook, `const fs=require('node:fs');const rename=fs.renameSync;let writes=0;fs.renameSync=function(...args){const result=rename.apply(this,args);if(++writes===Number(process.env.CRASH_WRITE))process.kill(process.pid,'SIGKILL');return result;};`);
  for (const operation of ["activate", "rollback"]) {
    for (let write = 1; write <= 6; write++) {
      if (operation === "rollback") activate(box.root, b.manifest.artifactId);
      const before = status(box.root).selected;
      const args = ["--require", hook, path.join(repository, "scripts/install-manager.mjs"), operation, box.root, ...(operation === "activate" ? [b.manifest.artifactId] : [])];
      assert.throws(() => execFileSync(process.execPath, args, { env: { PATH: process.env.PATH, CRASH_WRITE: String(write) }, stdio: "pipe" }), error => error.signal === "SIGKILL");
      assert.equal(status(box.root).recoveryRequired, true);
      assert.throws(() => activate(box.root, a.manifest.artifactId));
      const result = box.run("recover", box.root);
      assert.equal(result.committed, write === 6);
      assert.equal(status(box.root).selected, write === 6 ? (operation === "activate" ? b : a).manifest.artifactId : before);
      assert.equal(status(box.root).recoveryRequired, false);
      assert.equal(box.run("recover", box.root).recovered, false);
      activate(box.root, a.manifest.artifactId);
    }
  }
});

test("recovery refuses a live manager and preserves later unrelated edits after a crash", (t) => {
  const box = sandbox(t), a = archive(t);
  stage(a.tarball, a.outerFile, box.root);
  const lock = path.join(box.root, ".manager-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  writeJson(path.join(lock, "owner.json"), { pid: process.pid });
  assert.throws(() => box.run("recover", box.root));
  fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock);
  const hook = path.join(box.home, "crash.cjs");
  fs.writeFileSync(hook, `const fs=require('node:fs');const rename=fs.renameSync;let writes=0;fs.renameSync=function(...args){const result=rename.apply(this,args);if(++writes===4)process.kill(process.pid,'SIGKILL');return result;};`);
  assert.throws(() => execFileSync(process.execPath, ["--require", hook, path.join(repository, "scripts/install-manager.mjs"), "activate", box.root, a.manifest.artifactId], { stdio: "pipe" }));
  const settings = JSON.parse(fs.readFileSync(box.settings)); settings.later = true; settings.packages[1].skills = ["later"]; writeJson(box.settings, settings);
  const registry = JSON.parse(fs.readFileSync(box.selection.herdrRegistry)); registry[0].later = true; registry[1].enabled = false; writeJson(box.selection.herdrRegistry, registry);
  box.run("recover", box.root);
  assert.equal(JSON.parse(fs.readFileSync(box.settings)).later, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(box.settings)).packages[1].skills, ["later"]);
  assert.equal(JSON.parse(fs.readFileSync(box.settings)).packages[1].source, box.selection.piSource);
  assert.equal(JSON.parse(fs.readFileSync(box.selection.herdrRegistry))[0].later, true);
  assert.equal(JSON.parse(fs.readFileSync(box.selection.herdrRegistry))[1].enabled, false);
  assert.equal(status(box.root).selected, null);
});
