import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { root } from "./dist-fixture.mjs";

const aliases = {
  "pixel-terminals": path.join(root, "terminals/src/index.ts"),
  "pixel-react": path.join(root, "engine/packages/pixel-react/src/index.ts"),
};

function storeStub(box) {
  const file = path.join(box.home, "pixel-store.ts");
  if (!fs.existsSync(file)) fs.writeFileSync(file, `import path from "node:path"; export const APP_DIR_NAME="test-profile"; export const INSTALLATION=null; export const DAEMON_SOCKET=path.join(process.env.XDG_RUNTIME_DIR!,APP_DIR_NAME,"daemon.sock"); export const RUNTIME_IDENTITY={build:"test",instanceId:"test"}; export function runtimeMatches(){return true}`);
  return file;
}

function isolated(t, prefix = "profile-cleanup-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: path.join(home, "home"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_RUNTIME_DIR: path.join(home, "runtime"),
    TERMINAL_BROWSER_APPDATA: path.join(home, "appdata"),
    TERMINAL_BROWSER_DIST_ROOT: path.join(home, "dist"),
    PI_OFFLINE: "1",
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("HERDR_") || name.startsWith("TERMINAL_BROWSER_OWNER_") || name.startsWith("TERMINAL_BROWSER_COMPANION_") || name === "TERMINAL_BROWSER_INSTALLATION" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  }
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR, env.TERMINAL_BROWSER_APPDATA, env.TERMINAL_BROWSER_DIST_ROOT]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { home, env };
}

async function profileRunner(box) {
  const electron = path.join(box.home, "electron.ts");
  fs.writeFileSync(electron, `import {EventEmitter} from "node:events"; export const app=Object.assign(new EventEmitter(),{getPath(){return process.env.TERMINAL_BROWSER_APPDATA},setPath(){if(process.env.FAIL_SET_PATH)throw Error("setPath failed")}});`);
  const entry = path.join(box.home, "profile-runner.ts");
  fs.writeFileSync(entry, `import {claimProfile} from ${JSON.stringify(path.join(root, "browser/src/profile.ts"))}; try { const claim=claimProfile(); process.stdout.write("READY "+process.pid+"\\n"); process.stdin.once("data",()=>{claim.release();process.exit(0)}); } catch(error) { process.stderr.write(String(error)); process.exit(2); }`);
  const output = path.join(box.home, "profile-runner.cjs");
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs", alias: { ...aliases, "pixel-store": storeStub(box) }, plugins: [{ name: "electron", setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: electron })); } }], logLevel: "silent" });
  return output;
}

function startHolder(output, env) {
  const child = spawn(process.execPath, [output], { env, stdio: ["pipe", "pipe", "pipe"] });
  return once(child.stdout, "data").then(([data]) => {
    const match = data.toString().match(/READY (\d+)/);
    assert(match);
    return { child, pid: Number(match[1]) };
  });
}

function findLock(appData) {
  const namespace = fs.readdirSync(appData)[0];
  return path.join(appData, namespace, "terminal-browser.lock");
}

test("profile releases normal and handled initialization failures", async (t) => {
  const box = isolated(t);
  const output = await profileRunner(box);
  assert.throws(() => execFileSync(process.execPath, [output], { env: { ...box.env, FAIL_SET_PATH: "1" }, stdio: "pipe" }));
  const profileDirs = fs.readdirSync(box.env.TERMINAL_BROWSER_APPDATA);
  assert.equal(profileDirs.length, 1);
  assert(!fs.existsSync(path.join(box.env.TERMINAL_BROWSER_APPDATA, profileDirs[0], "terminal-browser.lock")));
  const holder = await startHolder(output, box.env);
  const lock = findLock(box.env.TERMINAL_BROWSER_APPDATA);
  holder.child.stdin.end("release\n");
  assert.equal((await once(holder.child, "close"))[0], 0);
  assert(!fs.existsSync(lock));
});

test("profile preserves exclusive refusal and replacement lock identity", async (t) => {
  const box = isolated(t);
  const output = await profileRunner(box);
  const holder = await startHolder(output, box.env);
  const lock = findLock(box.env.TERMINAL_BROWSER_APPDATA);
  const occupied = spawn(process.execPath, [output], { env: box.env, stdio: "ignore" });
  assert.equal((await once(occupied, "close"))[0], 2);
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(holder.pid), { mode: 0o600 });
  holder.child.stdin.end("release\n");
  assert.equal((await once(holder.child, "close"))[0], 0);
  assert.equal(fs.readFileSync(lock, "utf8"), String(holder.pid));
});

test("abrupt death retains a diagnosable PID lock", async (t) => {
  const box = isolated(t);
  const output = await profileRunner(box);
  const holder = await startHolder(output, box.env);
  const lock = findLock(box.env.TERMINAL_BROWSER_APPDATA);
  holder.child.kill("SIGKILL");
  assert.equal((await once(holder.child, "close"))[1], "SIGKILL");
  assert.equal(fs.readFileSync(lock, "utf8"), String(holder.pid));
});

async function daemonRunner(box) {
  const electron = path.join(box.home, "daemon-electron.ts");
  fs.writeFileSync(electron, `import {EventEmitter} from "node:events"; export const app=Object.assign(new EventEmitter(),{setPath(){}});`);
  const session = path.join(box.home, "session.ts");
  fs.writeFileSync(session, `export function createSession(){throw Error("unused")}`);
  const entry = path.join(box.home, "daemon-runner.ts");
  fs.writeFileSync(entry, `import fs from "node:fs"; import {app} from "electron"; import {claimProfile} from ${JSON.stringify(path.join(root, "browser/src/profile.ts"))}; import {runDaemon} from ${JSON.stringify(path.join(root, "browser/src/daemon.ts"))}; import {DAEMON_SOCKET} from "pixel-store"; const claim=claimProfile(); const finish=(code:number)=>{claim.release();process.stdout.write("EXIT "+code+"\\n");setTimeout(()=>process.exit(code),20)}; void runDaemon(null,finish); if(process.argv[2]==="shutdown"){const timer=setInterval(()=>{if(fs.existsSync(DAEMON_SOCKET)){clearInterval(timer);app.emit("will-quit");setTimeout(()=>{process.stdout.write("SOCKET "+fs.existsSync(DAEMON_SOCKET)+"\\n");process.exit(0)},20)}},5)} else if(process.argv[2]==="replace"){const timer=setInterval(()=>{if(fs.existsSync(DAEMON_SOCKET)){clearInterval(timer);setTimeout(()=>{fs.unlinkSync(DAEMON_SOCKET);fs.writeFileSync(DAEMON_SOCKET,"foreign");app.emit("will-quit");setTimeout(()=>process.exit(0),20)},20)}},5)}`);
  const output = path.join(box.home, "daemon-runner.cjs");
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs", alias: { ...aliases, "pixel-store": storeStub(box) }, plugins: [{ name: "seams", setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: electron })); builder.onResolve({ filter: /^\.\/session\/session$/ }, () => ({ path: session })); } }], logLevel: "silent" });
  return output;
}

test("daemon failures release profile without changing occupied sockets", async (t) => {
  const sentinelBox = isolated(t, "daemon-sentinel-");
  const sentinelRunner = await daemonRunner(sentinelBox);
  const sentinel = path.join(sentinelBox.env.XDG_RUNTIME_DIR, "test-profile", "daemon.sock");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "sentinel");
  const occupied = spawn(process.execPath, [sentinelRunner], { env: sentinelBox.env, stdio: ["ignore", "pipe", "pipe"] });
  assert.match((await once(occupied.stdout, "data"))[0].toString(), /EXIT 3/);
  assert.equal((await once(occupied, "close"))[0], 3);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "sentinel");
  assert(!fs.existsSync(findLock(sentinelBox.env.TERMINAL_BROWSER_APPDATA)));

  const bindBox = isolated(t, "daemon-bind-");
  bindBox.env.XDG_RUNTIME_DIR = path.join(bindBox.home, "r".repeat(140));
  fs.mkdirSync(bindBox.env.XDG_RUNTIME_DIR);
  const bindRunner = await daemonRunner(bindBox);
  const failed = spawn(process.execPath, [bindRunner], { env: bindBox.env, stdio: ["ignore", "pipe", "pipe"] });
  assert.match((await once(failed.stdout, "data"))[0].toString(), /EXIT 1/);
  assert.equal((await once(failed, "close"))[0], 1);
  assert(!fs.existsSync(findLock(bindBox.env.TERMINAL_BROWSER_APPDATA)));
});

test("daemon shutdown removes owned socket and preserves a replacement", async (t) => {
  const box = isolated(t);
  const output = await daemonRunner(box);
  const normal = execFileSync(process.execPath, [output, "shutdown"], { env: box.env, encoding: "utf8", timeout: 5000 });
  assert.match(normal, /SOCKET false/);
  assert(!fs.existsSync(findLock(box.env.TERMINAL_BROWSER_APPDATA)));
  execFileSync(process.execPath, [output, "replace"], { env: box.env, timeout: 5000 });
  const namespace = fs.readdirSync(box.env.TERMINAL_BROWSER_APPDATA)[0];
  assert.equal(fs.readFileSync(path.join(box.env.XDG_RUNTIME_DIR, namespace, "daemon.sock"), "utf8"), "foreign");
});

test("real Electron app.exit and app.quit release the acquired lock", { skip: !process.env.TERMINAL_BROWSER_TEST_ELECTRON }, async (t) => {
  const box = isolated(t, "electron-profile-");
  const output = path.join(box.home, "fixture", "main.js");
  fs.mkdirSync(path.dirname(output));
  execFileSync("bash", [path.join(root, "scripts/bundle.sh"), path.join(root, "browser/test/profile-startup-fixture.ts"), output], { cwd: root });
  for (const mode of ["exit", "quit"]) {
    const child = spawn(process.env.TERMINAL_BROWSER_TEST_ELECTRON, ["--no-sandbox", "--disable-gpu", "--ozone-platform=headless", output, mode], { env: box.env, stdio: "ignore" });
    const [code] = await once(child, "close");
    assert.equal(code, mode === "exit" ? 21 : 0);
    assert(!fs.existsSync(findLock(box.env.TERMINAL_BROWSER_APPDATA)));
  }
});
