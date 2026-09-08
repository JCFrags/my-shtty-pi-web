import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifact = process.env.RUNTIME_A_ROOT ?? "/artifact";
let cli = artifact + "/bin/terminal-browser";
const owner = pane => ({ TERMINAL_BROWSER_OWNER_WORKSPACE_ID: "fixture", TERMINAL_BROWSER_OWNER_TAB_ID: "tab", TERMINAL_BROWSER_OWNER_PANE_ID: pane, TERMINAL_BROWSER_OWNER_PROJECT_DIR: "/tmp/project" });
const run = async (args, pane = "one", command = cli) => {
  const { stdout } = await execute(command, args, { env: { ...process.env, ...owner(pane) }, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
};
fs.mkdirSync("/tmp/project", { mode: 0o700 });
const fixture = await createRequire(import.meta.url)("/test/dynamic-live.cjs").start();
const url = `http://127.0.0.1:${fixture.address().port}/`;
const pty = spawn("python3", ["/test/pty-fixture.py"], { stdio: ["pipe", "pipe", "inherit"] });
const [line] = await once(pty.stdout, "data");
const ttys = JSON.parse(line);
let daemon;
let closed;
let errors = "";
function startDaemon(root) {
  daemon = spawn(root + "/electron/electron", [root + "/browser/dist/main.js", "--daemon", "--ozone-platform=headless", "--screen-info={8192x8192}", "--disable-gpu"], { env: { ...process.env, TERMINAL_BROWSER_DIST_ROOT: root }, stdio: ["ignore", "ignore", "pipe"] });
  closed = once(daemon, "exit");
  daemon.stderr.on("data", chunk => { errors = (errors + chunk).slice(-16000); });
}
async function stopped() {
  let timer;
  try {
    const [code, signal] = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`approved daemon exit timed out (pid=${daemon.pid}, exit=${daemon.exitCode}): ${errors}`)), 15000); })]);
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
    assert.equal(fs.existsSync(socket), false, "daemon must remove its owned socket before exit");
  } finally {
    clearTimeout(timer);
    if (daemon.exitCode !== null || daemon.signalCode !== null) daemon.stderr.destroy();
  }
}
startDaemon(artifact);
const namespace = process.env.TERMINAL_BROWSER_INSTALLATION ? JSON.parse(fs.readFileSync(process.env.TERMINAL_BROWSER_INSTALLATION)).namespace : "terminal-browser-" + createHash("sha256").update(artifact).digest("hex").slice(0, 8);
const socket = process.env.XDG_RUNTIME_DIR + "/" + namespace + "/daemon.sock";
const peers = [];
let pi;
let piA;
function request(message, keep = false) {
  return new Promise((resolve, reject) => {
    const peer = net.connect(socket); peers.push(peer);
    let buffer = "";
    peer.setTimeout(10000, () => peer.destroy(new Error("daemon timeout")));
    peer.on("error", reject);
    peer.on("connect", () => peer.write(JSON.stringify(message) + "\n"));
    peer.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const value = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      if (!keep) peer.destroy(); else peer.setTimeout(0);
      resolve(value);
    });
  });
}
async function until(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await check();
    if (value) return value;
    assert.equal(daemon.exitCode, null, errors);
    await sleep(100);
  }
  throw Error(label + "\n" + errors);
}
try {
  await until(() => fs.existsSync(socket), "daemon startup");
  const initial = await request({ cmd: "status" });
  assert.equal(initial.identity.artifactId, JSON.parse(fs.readFileSync(artifact + "/build-manifest.json")).artifactId);
  if (process.env.RUNTIME_B_ROOT && process.env.PI_ROOT) {
    pi = await (await import("/test/packaged-pi.mjs")).piLoader();
    piA = await pi.load(initial.identity.artifactId);
  }
  const open = async (index, pane) => {
    const result = await request({ cmd: "open", identity: initial.identity, expectedInstance: initial.identity.instanceId, tty: ttys[index], argv: [url], cwd: "/tmp/project", env: { TERM: "xterm-kitty", ...owner(pane) } }, true);
    assert.equal(result.ok, true);
    return result;
  };
  await open(0, "one");
  const tabs = async pane => run(["companion", "tabs", "--action", "list"], pane);
  await until(async () => (await tabs("one").catch(() => null))?.tabs?.some(tab => tab.url === url), "first companion registration");
  await open(1, "two");
  await until(async () => (await tabs("two").catch(() => null))?.tabs?.some(tab => tab.url === url), "second companion registration");
  const observe = (pane = "one", args = []) => run(["agent", "observe", ...args], pane);
  const text = value => JSON.stringify(value);
  await until(async () => text(await observe()).includes("Right card"), "local page load");
  const act = async (action, locator, args = [], pane = "one") => {
    const seen = await observe(pane);
    const result = await run(["agent", action, "--locator-json", JSON.stringify(locator), "--observation", seen.observationId, "--control-epoch", String(seen.controlEpoch), ...args], pane);
    assert.notEqual(result.status, "interrupted", JSON.stringify(result));
    return result;
  };
  await act("click", [{ kind: "css", value: 'section[aria-label="Right card"] button' }]);
  assert.match(text(await observe()), /Right count 1/);
  assert.match(text(await observe("two")), /Right count 0/);
  await act("click", [{ kind: "role", value: "button", name: "Prepare delayed control" }]);
  await act("click", [{ kind: "role", value: "button", name: "Delayed action" }]);
  assert.match(text(await observe()), /Delayed count 1/);
  async function frameAction(name, capture) {
    const main = await observe("one", ["--frame", "main"]);
    const frame = main.frames.find(frame => frame.name === "contact-form");
    assert(frame && new URL(frame.url).hostname === "localhost");
    await observe("one", ["--frame", frame.ref]);
    await act("type", [{ kind: "label", value: "Contact name" }], ["--text", name]);
    await act("click", [{ kind: "role", value: "button", name: "Submit embedded" }]);
    const result = await observe();
    assert.match(text(result), new RegExp("Submitted " + name + " — count 1"));
    await observe("one", ["--view", "both", "--image-output", capture]);
    assert(fs.statSync(capture).size > 1000);
  }
  await frameAction("Packaged", "/tmp/frame.png");
  await observe("one", ["--frame", "main"]);
  const prior = await tabs("one");
  await act("click", [{ kind: "role", value: "button", name: "Open frame popup" }]);
  const popup = await until(async () => (await tabs("one")).tabs.find(tab => !prior.tabs.some(old => old.id === tab.id)), "popup context");
  await run(["companion", "tabs", "--action", "activate", "--tab", String(popup.id)]);
  await frameAction("Popup", "/tmp/popup-frame.png");
  assert.equal((await tabs("two")).tabs.length, 1);
  await observe("one", ["--frame", "main"]);
  const history = {};
  for (const pane of ["one", "two"]) {
    await act("click", [{ kind: "role", value: "link", name: "Download fixture" }], [], pane);
    const item = await until(async () => (await run(["companion", "tabs", "--action", "downloads"], pane)).downloads.find(item => item.state === "completed"), "owner download completion");
    assert.equal(fs.readFileSync("/tmp/project/" + item.savePath, "utf8"), "download fixture");
    history[pane] = item.id;
  }
  assert.notEqual(history.one, history.two);
  for (const pane of ["one", "two"]) assert.deepEqual((await run(["companion", "tabs", "--action", "downloads"], pane)).downloads.map(item => item.id), [history[pane]]);
  const historyDirectory = "/tmp/project/.terminal-browser-downloads";
  const retained = fs.readdirSync(historyDirectory).filter(name => /^history-[a-f0-9]{64}\.json$/.test(name)).map(name => [name, fs.readFileSync(historyDirectory + "/" + name, "utf8")]);
  assert.equal(retained.length, 2);
  const checkHistory = () => { for (const [name, bytes] of retained) assert.equal(fs.readFileSync(historyDirectory + "/" + name, "utf8"), bytes); };
  const status = await run(["agent", "status"]);
  const paused = await run(["agent", "pause", "--control-epoch", String(status.controlEpoch)]);
  assert.equal(paused.state, "paused");
  if (process.env.RUNTIME_B_ROOT) {
    const other = process.env.RUNTIME_B_ROOT;
    const otherId = JSON.parse(fs.readFileSync(other + "/build-manifest.json")).artifactId;
    const install = process.env.INSTALL_ROOT;
    await execute("/host-node", [other + "/scripts/install-manager.mjs", "activate", install, otherId]);
    const selected = await run(["doctor", "--json"], "one", other + "/bin/terminal-browser");
    assert.equal(selected.candidate.artifactId, otherId);
    assert.equal(selected.selectedNextLaunch.cli.artifactId, otherId);
    assert.equal(selected.daemon.identity.artifactId, initial.identity.artifactId);
    assert.equal(selected.daemon.matchesCandidate, false);
    checkHistory();
    if (pi) {
      assert.equal(selected.pi.loaded.length, 1);
      assert.equal(selected.pi.loaded[0].identity.artifactId, piA.artifactId);
      assert.equal(selected.pi.loaded[0].matchesSelected, false);
      const piB = await pi.load(otherId);
      assert.notEqual(piB.instanceId, piA.instanceId);
      const loaded = await run(["doctor", "--json"], "one", other + "/bin/terminal-browser");
      assert.equal(loaded.pi.loaded[0].matchesSelected, true);
    }
    await assert.rejects(run(["agent", "click", "--locator-json", JSON.stringify([{ kind: "role", value: "button", name: "Submit embedded" }]), "--observation", "must-not-replay", "--control-epoch", String(paused.controlEpoch)], "one", other + "/bin/terminal-browser"), /runtime mismatch/);
    assert.deepEqual(await run(["agent", "status"]), paused);
    await execute("/host-node", [other + "/scripts/install-manager.mjs", "rollback", install]);
    if (pi) assert.equal((await pi.load(initial.identity.artifactId)).instanceId, piA.instanceId);
    checkHistory();
    assert.deepEqual(await run(["agent", "status"]), paused);
    assert.deepEqual((await run(["daemon-status"])).identity, initial.identity);
  }
  const inventory = await run(["daemon-status"]);
  assert.equal(inventory.sessions.length, 2);
  await open(2, "three");
  await until(async () => (await tabs("three").catch(() => null))?.tabs?.some(tab => tab.url === url), "third companion registration");
  fs.writeFileSync("/tmp/approval.json", JSON.stringify(inventory), { mode: 0o600 });
  await assert.rejects(run(["shutdown", "--expect", "/tmp/approval.json"]));
  const fresh = await run(["daemon-status"]);
  assert.equal(fresh.sessions.length, 3);
  assert.deepEqual(fresh.identity, initial.identity);
  assert.deepEqual(await run(["agent", "status"]), paused);
  fs.writeFileSync("/tmp/approval.json", JSON.stringify(fresh));
  await run(["shutdown", "--expect", "/tmp/approval.json"]);
  await stopped();
  if (process.env.RUNTIME_B_ROOT) {
    await pi?.shutdown();
    const other = process.env.RUNTIME_B_ROOT;
    const otherId = JSON.parse(fs.readFileSync(other + "/build-manifest.json")).artifactId;
    await execute("/host-node", [other + "/scripts/install-manager.mjs", "activate", process.env.INSTALL_ROOT, otherId]);
    startDaemon(other);
    cli = other + "/bin/terminal-browser";
    await until(() => fs.existsSync(socket), "explicit B startup");
    const current = await request({ cmd: "status" });
    assert.equal(current.identity.artifactId, otherId);
    assert.notEqual(current.identity.instanceId, initial.identity.instanceId);
    for (const [index, pane] of ["one", "two"].entries()) {
      assert.equal((await request({ cmd: "open", identity: current.identity, expectedInstance: current.identity.instanceId, tty: ttys[index], argv: [url], cwd: "/tmp/project", env: { TERM: "xterm-kitty", ...owner(pane) } }, true)).ok, true);
      await until(async () => (await tabs(pane).catch(() => null))?.tabs?.some(tab => tab.url === url), "recovered owner registration");
      assert.deepEqual((await run(["companion", "tabs", "--action", "downloads"], pane)).downloads.map(item => item.id), [history[pane]]);
    }
    const approval = await run(["daemon-status"]);
    fs.writeFileSync("/tmp/approval.json", JSON.stringify(approval));
    await run(["shutdown", "--expect", "/tmp/approval.json"]);
    await stopped();
  }
  console.log(JSON.stringify({ packagedMain: true, localAction: true, crossOriginActionCapture: true, popupActionCapture: true, twoOwners: true, ownerHistoryAcrossReleases: Boolean(process.env.RUNTIME_B_ROOT), paused: true, fullInventoryRace: true, pausedSelectionChange: Boolean(process.env.RUNTIME_B_ROOT), graphics: "unknown" }));
} finally {
  await pi?.shutdown();
  for (const peer of peers) peer.destroy();
  if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill("SIGTERM"); const timer = setTimeout(() => daemon.kill("SIGKILL"), 5000); await closed; clearTimeout(timer); daemon.stderr.destroy(); }
  pty.stdin.end();
  fixture.close();
}
