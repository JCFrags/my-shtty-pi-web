const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { profileOwnership, socketEvidence } = require("../dist/profile-ownership.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-diagnosis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile"), proc = path.join(root, "proc");
  fs.mkdirSync(profile); fs.mkdirSync(proc);
  const lock = path.join(profile, "terminal-browser.lock");
  return { root, profile, proc, lock };
}

test("missing PID is reported without declaring a PID-only lock abandoned", t => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, "1234", { mode: 0o600 });
  const before = fs.statSync(f.lock);
  let value = profileOwnership(f.profile, f.proc);
  assert.equal(value.state, "occupied");
  assert.equal(value.recordedPid, 1234);
  assert.equal(value.ownerProcess.state, "missing");
  assert.equal(value.recordFormat, "pid-only");
  assert.match(value.processIdentity, /not-recorded/);
  fs.mkdirSync(path.join(f.proc, "1234"));
  value = profileOwnership(f.profile, f.proc);
  assert.equal(value.ownerProcess.state, "present-unverified");
  assert.equal(fs.statSync(f.lock).ino, before.ino);
  assert.equal(fs.readFileSync(f.lock, "utf8"), "1234");
});

test("unsafe, malformed, missing and symlink locks stay distinct", t => {
  const f = fixture(t);
  assert.equal(profileOwnership(f.profile, f.proc).state, "not-observed");
  for (const text of ["0", "123\n", "2147483648", "credentials-not-a-pid", "x".repeat(65)]) {
    fs.writeFileSync(f.lock, text, { mode: 0o600 });
    const value = profileOwnership(f.profile, f.proc);
    assert.equal(value.state, "unverifiable");
    assert.equal(value.recordedPid, undefined);
    if (text === "credentials-not-a-pid") assert(!JSON.stringify(value).includes(text));
  }
  fs.chmodSync(f.lock, 0o644);
  assert.equal(profileOwnership(f.profile, f.proc).reason, "unsafe-lock-metadata");
  fs.unlinkSync(f.lock);
  fs.symlinkSync(path.join(f.root, "absent"), f.lock);
  assert.equal(profileOwnership(f.profile, f.proc).reason, "unsafe-lock-metadata");
});

test("inaccessible and replaced metadata never become missing or an owned lock", t => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, "1234", { mode: 0o600 });
  const original = fs.lstatSync;
  t.mock.method(fs, "lstatSync", () => { throw Object.assign(new Error("private"), { code: "EACCES" }); });
  assert.equal(profileOwnership(f.profile, f.proc).state, "unverifiable");
  assert.equal(socketEvidence(path.join(f.root, "daemon.sock")).code, "EACCES");
  t.mock.restoreAll();
  let calls = 0;
  t.mock.method(fs, "lstatSync", (...args) => {
    if (args[0] === f.lock && ++calls === 2) {
      fs.renameSync(f.lock, f.lock + ".old");
      fs.writeFileSync(f.lock, "1234", { mode: 0o600 });
    }
    return original(...args);
  });
  assert.equal(profileOwnership(f.profile, f.proc).reason, "lock-changed");
  assert.equal(fs.readFileSync(f.lock, "utf8"), "1234");
  t.mock.restoreAll();
  calls = 0;
  t.mock.method(fs, "lstatSync", (...args) => {
    if (args[0] === f.lock && ++calls === 2) fs.unlinkSync(f.lock);
    return original(...args);
  });
  assert.equal(profileOwnership(f.profile, f.proc).state, "unverifiable");
});

test("socket metadata distinguishes missing from a non-socket without deleting either", t => {
  const f = fixture(t), socket = path.join(f.root, "daemon.sock");
  assert.equal(socketEvidence(socket).state, "missing");
  fs.writeFileSync(socket, "sentinel");
  assert.equal(socketEvidence(socket).state, "wrong-file-type");
  assert.equal(fs.readFileSync(socket, "utf8"), "sentinel");
});
