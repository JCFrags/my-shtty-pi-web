import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileHash, readJson, validateArchive, validateBundle } from "./dist-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const id = (value) => { assert.match(value, /^[a-f0-9]{64}$/); return value; };
const absolute = (value) => { assert.equal(typeof value, "string"); assert(path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value)); return value; };
function privateDirectory(directory, create = false) {
  absolute(directory);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), "installation directory must be owned by you and mode 0700");
  assert.equal(fs.realpathSync(directory), directory, "installation path must not contain symlinks");
}
function atomic(file, bytes, expected) {
  assert.equal(snapshot(file), expected, "selection changed; refusing overwrite");
  if (bytes === null) { if (expected !== null) fs.unlinkSync(file); return; }
  const temporary = `${file}.${randomUUID()}.new`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  assert.equal(snapshot(file), expected, "selection changed; refusing overwrite");
  fs.renameSync(temporary, file);
}
function snapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, "expected bounded regular file");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function linkSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return fs.readlinkSync(file);
    assert(stat.isFile() && stat.size <= 65536 && stat.uid === process.getuid(), "selection is an occupied directory or unsafe file");
    return { bytes: fs.readFileSync(file).toString("base64"), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function replaceLink(file, target, expected) {
  assert.deepEqual(linkSnapshot(file), expected, "link selection changed");
  if (target === null) { fs.unlinkSync(file); return; }
  const temporary = `${file}.${randomUUID()}.new`;
  if (typeof target === "string") fs.symlinkSync(target, temporary);
  else fs.writeFileSync(temporary, Buffer.from(target.bytes, "base64"), { mode: target.mode, flag: "wx" });
  assert.deepEqual(linkSnapshot(file), expected, "link selection changed");
  fs.renameSync(temporary, file);
}
function config(root) {
  const file = path.join(root, "installation.json");
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384 && stat.uid === process.getuid() && !(stat.mode & 0o077), "invalid installation receipt");
  const value = readJson(file);
  assert.equal(value.schemaVersion, 1);
  assert.match(value.namespace, /^terminal-browser(?:-dev)?-[a-f0-9]{8}$/);
  assert.deepEqual(Object.keys(value.paths).sort(), ["appData", "cacheHome", "dataHome", "interopState", "interopShare", "runtimeHome", "stateHome"].sort());
  Object.values(value.paths).forEach(absolute);
  const targets = ["cli", "herdr", "piSettings", "herdrRegistry"].map((key) => absolute(value.selection[key]));
  assert.equal(new Set(targets).size, targets.length, "selection paths must differ");
  for (const target of targets) assert(!["installation.json", "selection.json"].some((name) => target === path.join(root, name)), "selection conflicts with manager state");
  assert(value.selection.piSource === null || (typeof value.selection.piSource === "string" && value.selection.piSource.length > 0));
  if (value.selection.herdrSource !== null) absolute(value.selection.herdrSource);
  assert.deepEqual(Object.keys(value.selection).sort(), ["cli", "herdr", "piSettings", "piSource", "herdrRegistry", "herdrSource"].sort());
  for (const key of ["cli", "herdr", "piSettings", "herdrRegistry"]) assert(!value.selection[key].startsWith(`${root}/releases/`), "selections must be outside immutable artifacts");
  for (const valuePath of Object.values(value.paths)) {
    assert(valuePath !== path.join(root, "releases") && !valuePath.startsWith(`${root}/releases/`), "runtime state cannot be in immutable artifacts");
    if (fs.existsSync(valuePath)) assert.equal(fs.realpathSync(valuePath), valuePath, "state bases must be physical paths");
  }
  for (const key of ["dataHome", "stateHome", "cacheHome", "runtimeHome", "appData"]) {
    const directory = path.join(value.paths[key], value.namespace);
    if (fs.existsSync(directory)) assert.equal(fs.realpathSync(directory), directory, "state namespace must not be a mutable symlink");
  }
  return value;
}
function withLock(root, action, recovering = false) {
  privateDirectory(root, true);
  const lock = path.join(root, ".manager-lock");
  if (recovering && fs.existsSync(lock)) {
    privateDirectory(lock);
    const owner = readJson(path.join(lock, "owner.json"));
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, "unknown lock owner");
    let absent = false;
    try { process.kill(owner.pid, 0); } catch (error) { absent = error.code === "ESRCH"; }
    assert(absent, "manager owner is live or unknown; recovery refused");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), json({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try {
    assert(recovering || !fs.existsSync(path.join(root, "pending.json")), "interrupted transaction requires explicit recover");
    return action();
  } finally { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); }
}
export function stage(archive, manifestFile, root) {
  return withLock(root, () => {
    const outer = validateArchive(archive, manifestFile);
    assert.equal(outer.platform, platform, "archive target does not match this host");
    const releases = path.join(root, "releases");
    privateDirectory(releases, true);
    const destination = path.join(releases, id(outer.artifactId));
    if (fs.existsSync(destination)) {
      validateBundle(path.join(destination, "terminal-browser"), outer.artifactId);
      assert.equal(fileHash(path.join(destination, "terminal-browser/build-manifest.json")), outer.manifestSha256);
      return { candidate: outer.artifactId, repeated: true };
    }
    const work = fs.mkdtempSync(path.join(root, ".stage-"));
    fs.chmodSync(work, 0o700);
    const copied = path.join(work, outer.file);
    fs.copyFileSync(archive, copied, fs.constants.COPYFILE_EXCL);
    validateArchive(copied, manifestFile);
    const extracted = path.join(work, "extracted");
    fs.mkdirSync(extracted, { mode: 0o700 });
    execFileSync("python3", [path.join(here, "extract-dist.py"), copied, extracted], { stdio: "pipe" });
    const bundle = path.join(extracted, "terminal-browser");
    const inner = validateBundle(bundle, outer.artifactId);
    assert.equal(fileHash(path.join(bundle, "build-manifest.json")), outer.manifestSha256);
    for (const field of ["version", "channel", "platform"]) assert.equal(outer[field], inner.identity[field]);
    fs.renameSync(extracted, destination);
    return { candidate: outer.artifactId, repeated: false };
  });
}
function packageSource(entry) { return typeof entry === "string" ? entry : entry?.source; }
function changePackage(file, from, to, requiredIndex) {
  const before = snapshot(file);
  const settings = JSON.parse(before ?? "{}");
  if (settings.packages === undefined && from === null) settings.packages = [];
  assert(Array.isArray(settings.packages), "Pi packages must be an array");
  const indices = settings.packages.flatMap((entry, index) => packageSource(entry) === from ? [index] : []);
  if (from !== null) assert.equal(indices.length, 1, "expected exactly one approved Pi package source");
  else assert(!settings.packages.some((entry) => packageSource(entry) === to), "Pi package source already exists");
  const index = from === null ? settings.packages.length : indices[0];
  if (requiredIndex !== undefined) assert.equal(index, requiredIndex, "Pi package order changed");
  const entry = settings.packages[index];
  if (to === null) settings.packages.splice(index, 1);
  else settings.packages[index] = from === null || typeof entry === "string" ? to : { ...entry, source: to };
  return { file, before, after: json(settings), index, from, to };
}
const HERDR_ID = "zenbu-labs.terminal-browser";
const HERDR_FIELDS = ["plugin_id", "name", "version", "min_herdr_version", "description", "manifest_path", "plugin_root", "platforms", "build", "startup", "actions", "panes", "source"];
function herdrEntry(file) {
  const entries = JSON.parse(snapshot(file) ?? "[]");
  assert(Array.isArray(entries), "Herdr registry must be an array");
  const matches = entries.filter((entry) => entry.plugin_id === HERDR_ID);
  assert(matches.length <= 1, "duplicate Herdr plugin registration");
  return matches[0] ?? null;
}
function bundledHerdr(bundle) {
  const manifestPath = path.join(bundle, "herdr-plugin/herdr-plugin.toml");
  assert(fs.statSync(manifestPath).size <= 65536);
  const manifest = JSON.parse(execFileSync("python3", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", manifestPath], { encoding: "utf8", maxBuffer: 65536 }));
  assert.equal(manifest.id, HERDR_ID);
  assert(!manifest.build?.length, "packaged Herdr plugin must not build from a checkout");
  const identity = readJson(path.join(bundle, "build-manifest.json")).identity.integrations.herdr;
  assert.equal(manifest.version, identity.version);
  assert.equal(manifest.min_herdr_version, identity.minimumVersion);
  const entry = { ...manifest, plugin_id: manifest.id, manifest_path: manifestPath, plugin_root: path.dirname(manifestPath), enabled: true, source: { kind: "local" }, build: [] };
  delete entry.id;
  assert(Object.keys(entry).every((key) => HERDR_FIELDS.includes(key) || key === "enabled"), "unsupported Herdr manifest field");
  return entry;
}
function changeHerdr(file, from, to) {
  const before = snapshot(file);
  const entries = JSON.parse(before ?? "[]");
  assert(Array.isArray(entries));
  const indices = entries.flatMap((entry, index) => entry.plugin_id === HERDR_ID ? [index] : []);
  assert.equal(indices.length, from === null ? 0 : 1, "Herdr registration changed");
  const index = from === null ? entries.length : indices[0];
  const entry = from === null ? null : entries[index];
  if (from) for (const field of HERDR_FIELDS) {
    const actual = field === "build" && entry[field] === undefined ? [] : entry[field];
    const expected = field === "build" && from[field] === undefined ? [] : from[field];
    assert.deepEqual(actual, expected, "Herdr plugin selection changed");
  }
  if (to === null) entries.splice(index, 1);
  else {
    const replacement = entry ? { ...entry } : { enabled: true };
    for (const field of HERDR_FIELDS) {
      if (Object.hasOwn(to, field)) replacement[field] = to[field];
      else delete replacement[field];
    }
    entries[index] = replacement;
  }
  return { file, before, after: json(entries), from, to };
}
function current(root) { const raw = snapshot(path.join(root, "selection.json")); return raw ? JSON.parse(raw) : null; }
export function activate(root, artifactId) {
  return withLock(root, () => {
    const installation = config(root);
    const selected = current(root);
    const bundle = path.join(root, "releases", id(artifactId), "terminal-browser");
    privateDirectory(path.dirname(bundle));
    validateBundle(bundle, artifactId);
    assert.equal(readJson(path.join(bundle, "build-manifest.json")).identity.platform, platform);
    const source = path.join(bundle, "pi-extension");
    const expectedSource = selected?.source ?? installation.selection.piSource;
    if (selected?.artifactId === artifactId) {
      assert.equal(linkSnapshot(installation.selection.cli), path.join(bundle, "bin/terminal-browser"));
      assert.equal(linkSnapshot(installation.selection.herdr), path.join(bundle, "herdr-plugin"));
      changePackage(installation.selection.piSettings, source, source);
      changeHerdr(selected.herdr.file, selected.herdr.to, selected.herdr.to);
      return { selected: artifactId, repeated: true };
    }
    const pi = changePackage(installation.selection.piSettings, expectedSource, source);
    const previousHerdr = selected?.herdr.to ?? herdrEntry(installation.selection.herdrRegistry);
    if (!selected) {
      assert.equal(previousHerdr?.plugin_root ?? null, installation.selection.herdrSource, "unapproved Herdr plugin root");
      if (previousHerdr) {
        assert.equal(previousHerdr.manifest_path, path.join(installation.selection.herdrSource, "herdr-plugin.toml"));
        assert.equal(previousHerdr.version, "0.2.0");
        assert.equal(previousHerdr.source?.kind, "local");
      }
    }
    const herdr = changeHerdr(installation.selection.herdrRegistry, previousHerdr, bundledHerdr(bundle));
    const links = [
      { file: installation.selection.cli, before: linkSnapshot(installation.selection.cli), after: path.join(bundle, "bin/terminal-browser") },
      { file: installation.selection.herdr, before: linkSnapshot(installation.selection.herdr), after: path.join(bundle, "herdr-plugin") },
    ];
    if (selected) for (const link of links) assert.deepEqual(link.before, selected.links.find((entry) => entry.file === link.file)?.after, "selected link was changed outside this manager");
    const selectionFile = path.join(root, "selection.json");
    const beforeSelection = snapshot(selectionFile);
    const transaction = { artifactId, source, pi, herdr, links, previous: selected };
    const backups = path.join(root, "backups");
    privateDirectory(backups, true);
    fs.writeFileSync(path.join(backups, `${randomUUID()}.json`), json(transaction), { flag: "wx", mode: 0o600 });
    transact(root, { pi, herdr, links, selection: { file: selectionFile, before: beforeSelection, after: json(transaction) } });
    return { selected: artifactId, previous: selected?.artifactId ?? null, loadedRuntime: "unchanged" };
  });
}
export function rollback(root) {
  return withLock(root, () => {
    config(root);
    const selected = current(root);
    assert(selected, "no managed activation to roll back");
    const pi = changePackage(selected.pi.file, selected.pi.to, selected.pi.from, selected.pi.index);
    const herdr = changeHerdr(selected.herdr.file, selected.herdr.to, selected.herdr.from);
    if (selected.pi.before === null && pi.before === selected.pi.after) pi.after = null;
    if (selected.herdr.before === null && herdr.before === selected.herdr.after) herdr.after = null;
    for (const link of selected.links) assert.equal(linkSnapshot(link.file), link.after, "link changed since activation");
    const selectionFile = path.join(root, "selection.json");
    const before = snapshot(selectionFile);
    transact(root, { pi, herdr, links: selected.links.map(link => ({ file: link.file, before: link.after, after: link.before })), selection: { file: selectionFile, before, after: json(selected.previous) } });
    return { selected: selected.previous?.artifactId ?? null, loadedRuntime: "unchanged" };
  });
}
function reverseTransaction(transaction) {
  const { pi, herdr, links, selection } = transaction;
  assert.equal(snapshot(selection.file), selection.before, "selection changed during interrupted operation");
  const plans = [];
  for (const link of [...links].reverse()) {
    const actual = linkSnapshot(link.file);
    if (JSON.stringify(actual) === JSON.stringify(link.before)) continue;
    assert.deepEqual(actual, link.after, "interrupted link was changed");
    plans.push(() => replaceLink(link.file, link.before, link.after));
  }
  for (const [change, reverse] of [[herdr, () => changeHerdr(herdr.file, herdr.to, herdr.from)], [pi, () => changePackage(pi.file, pi.to, pi.from, pi.index)]]) {
    const actual = snapshot(change.file);
    if (actual === change.before) continue;
    if (actual === change.after) plans.push(() => atomic(change.file, change.before, actual));
    else {
      let undo;
      try { undo = reverse(); }
      catch {
        if (change === pi) changePackage(pi.file, pi.from, pi.from, pi.index);
        else changeHerdr(herdr.file, herdr.from, herdr.from);
        continue;
      }
      plans.push(() => atomic(undo.file, undo.after, undo.before));
    }
  }
  for (const apply of plans) apply();
}
function transact(root, transaction) {
  const pending = path.join(root, "pending.json");
  atomic(pending, json(transaction), null);
  try {
    for (const change of [transaction.pi, transaction.herdr]) atomic(change.file, change.after, change.before);
    for (const link of transaction.links) replaceLink(link.file, link.after, link.before);
    atomic(transaction.selection.file, transaction.selection.after, transaction.selection.before);
  } catch (error) {
    reverseTransaction(transaction);
    fs.unlinkSync(pending);
    throw error;
  }
  fs.unlinkSync(pending);
}
export function recover(root) {
  return withLock(root, () => {
    const installation = config(root);
    const pending = path.join(root, "pending.json");
    const raw = snapshot(pending);
    if (raw === null) return { recovered: false, loadedRuntime: "unchanged" };
    const transaction = JSON.parse(raw);
    assert.equal(transaction.pi.file, installation.selection.piSettings);
    assert.equal(transaction.herdr.file, installation.selection.herdrRegistry);
    assert.deepEqual(transaction.links.map(link => link.file), [installation.selection.cli, installation.selection.herdr]);
    assert.equal(transaction.selection.file, path.join(root, "selection.json"));
    const committed = snapshot(transaction.selection.file) === transaction.selection.after;
    if (committed) {
      changePackage(transaction.pi.file, transaction.pi.to, transaction.pi.to, transaction.pi.index);
      changeHerdr(transaction.herdr.file, transaction.herdr.to, transaction.herdr.to);
      for (const link of transaction.links) assert.deepEqual(linkSnapshot(link.file), link.after);
    } else reverseTransaction(transaction);
    fs.unlinkSync(pending);
    return { recovered: true, committed, selected: current(root)?.artifactId ?? null, loadedRuntime: "unchanged" };
  }, true);
}
export function status(root) {
  privateDirectory(root);
  const selected = current(root);
  return { schemaVersion: 1, candidates: fs.existsSync(path.join(root, "releases")) ? fs.readdirSync(path.join(root, "releases")).filter((entry) => /^[a-f0-9]{64}$/.test(entry)).sort() : [], selected: selected?.artifactId ?? null, recoveryRequired: fs.existsSync(path.join(root, "pending.json")) || fs.existsSync(path.join(root, ".manager-lock")), loadedRuntime: "unknown", graphics: "unknown", automaticRepair: false };
}
function configure(root, receipt) {
  return withLock(root, () => {
    const file = path.join(root, "installation.json");
    const bytes = snapshot(receipt);
    assert(bytes !== null);
    const existing = snapshot(file);
    if (existing !== null) { assert.equal(existing, bytes, "installation namespace is already pinned"); return { configured: true, repeated: true }; }
    atomic(file, bytes, null);
    try { config(root); } catch (error) { fs.renameSync(file, `${file}.rejected-${randomUUID()}`); throw error; }
    return { configured: true };
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const result = command === "stage" ? stage(...args) : command === "configure" ? configure(...args) : command === "activate" ? activate(...args) : command === "rollback" ? rollback(...args) : command === "status" ? status(...args) : command === "recover" ? recover(...args) : null;
    assert(result, "usage: install-manager.mjs stage ARCHIVE MANIFEST ROOT | configure ROOT RECEIPT | activate ROOT ARTIFACT_ID | rollback ROOT | recover ROOT | status ROOT");
    process.stdout.write(json(result));
  } catch { process.stderr.write("installation refused; verify archive, owner-only paths, namespace receipt and unchanged selections. No runtime was restarted.\n"); process.exitCode = 1; }
}
