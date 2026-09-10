#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

import {
  DAEMON_SOCKET,
  RUNTIME_IDENTITY,
  runtimeMatches,
  INSTALLATION,
  APP_DIR_NAME,
  LOGS_DIR,
  appId,
  ensureDataDir,
  instanceKey,
  listApps,
  registerApp,
  unregisterApp,
} from "pixel-store";
import type { OpenSpec } from "pixel-store";
import {
  callerTty,
  canSplit,
  cannotOpenPanes,
  checkTerminal,
  detect,
  unsupportedGraphicsMessage,
} from "pixel-terminals";
import type { Direction, Terminal, TerminalCheck } from "pixel-terminals";
import { actionCommand } from "./action";
import { agentCommand } from "./agent";
import { companionTabs, currentBrowserOwner, openCompanion } from "./companion";
import { control } from "./control";
import { setupCommand } from "./editors";
import { ensureSetup, linkSkills, markSetupDone } from "./setup";
import { commandHelp, helpTopics, rootHelp } from "./help";
import { browsers, describe, recordKey } from "./instances";
import type { Browser } from "./instances";
import { findHosts, openInHost } from "./interop";
import { lsCommand } from "./ls";
import { instances } from "./registry";
import { apparmorSetup, deniedRefusal, linuxSandboxError, sandboxRefusal } from "./sandbox";
import { openSshTunnel, startBundle, validateBundleDir, validateSshTarget } from "./ssh";
import type { RemoteBundle } from "./ssh";
import type { InstanceRecord } from "./registry";
import { installedVersion, upgradeCommand } from "./upgrade";
import { daemonRequest } from "./daemon-status";
import { doctor, safeDaemonStatus } from "./doctor";
import {
  bindStartupPane,
  createStartupAttempt,
  StartupFailure,
  removeStartupAttempt,
  startupAttempt,
  startupEnvironment,
  startupFailureError,
  waitForSpawnedDaemon,
  waitForStartup,
  writeStartupFailure,
} from "./startup";

const DIST_ROOT = process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;
const launchCommand = process.argv[2];
const reportsStartup = !launchCommand || launchCommand === "open" || launchCommand === "new-tab" || launchCommand === "companion";
const ownsStartupAttempt = !startupAttempt() && reportsStartup;
const rootStartup = ownsStartupAttempt ? createStartupAttempt() : null;
if (rootStartup) Object.assign(process.env, startupEnvironment(rootStartup));
if (rootStartup) process.once("exit", () => removeStartupAttempt(rootStartup));
const startupSignalHandlers = new Map<NodeJS.Signals, () => void>();
for (const [signal, exitCode] of reportsStartup ? [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const : []) {
  const handler = () => {
    const report = writeStartupFailure(new Error(`browser startup interrupted by ${signal}`), {
      exitCode: null,
      signal,
    });
    if (report && rootStartup) process.stderr.write(`terminal-browser: ${JSON.stringify(report)}\n`);
    process.exit(exitCode);
  };
  startupSignalHandlers.set(signal, handler);
  process.once(signal, handler);
}
function finishStartupReporting(): void {
  for (const [signal, handler] of startupSignalHandlers) process.removeListener(signal, handler);
  startupSignalHandlers.clear();
  if (rootStartup) removeStartupAttempt(rootStartup);
}

async function finishReportingWhenRegistered(): Promise<void> {
  const attempt = startupAttempt();
  if (!attempt) { finishStartupReporting(); return; }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await instances()).some((record) => record.startupAttempt === attempt)) {
      finishStartupReporting();
      return;
    }
    await sleep(100);
  }
}
delete process.env.ELECTRON_RUN_AS_NODE;

function fail(message: string): never {
  process.stderr.write(`terminal-browser: ${message}\n`);
  process.exit(1);
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ELECTRON_DIST_BIN =
  process.platform === "darwin"
    ? ["terminal-browser.app", "Contents", "MacOS", "terminal-browser"]
    : ["electron"];
const ELECTRON_DEV_BIN =
  process.platform === "darwin"
    ? ["Electron.app", "Contents", "MacOS", "Electron"]
    : ["electron"];

function browserDirectory(): string {
  return path.resolve(__dirname, "..", "..", "browser");
}

function electronBinary(): string {
  return DIST_ROOT
    ? path.join(DIST_ROOT, "electron", ...ELECTRON_DIST_BIN)
    : path.join(browserDirectory(), "node_modules", "electron", "dist", ...ELECTRON_DEV_BIN);
}

function browserLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const browserDir = browserDirectory();
  const electron = electronBinary();
  const main = path.join(browserDir, "dist", "main.js");
  for (const required of [electron, main]) {
    if (!fs.existsSync(required)) {
      fail(`missing ${required} — build the browser first (pnpm --filter terminal-browser build)`);
    }
  }
  if (process.platform === "linux") {
    let sandboxError = linuxSandboxError(electron);
    if (sandboxError) {
      apparmorSetup(electron);
      sandboxError = linuxSandboxError(electron);
    }
    if (sandboxError) fail(sandboxError);
  }
  // headless ozone reports a 1x1 screen unless told otherwise:
  // https://source.chromium.org/chromium/chromium/src/+/refs/tags/150.0.7871.212:ui/ozone/platform/headless/headless_screen.cc;l=37-46
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    argv = [...argv, "--ozone-platform=headless", "--screen-info={8192x8192}"];
  }
  ensureDataDir();
  const logDir = LOGS_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const quoted = [electron, main, ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  const line = `exec ${quoted}`;
  return { command: ["/bin/sh", "-c", line], cwd: browserDir };
}

function cliRunner(): string[] {
  return DIST_ROOT
    ? [path.join(DIST_ROOT, "bin", "terminal-browser")]
    : [process.execPath, path.resolve(__dirname, "main.js")];
}

function clientLaunchCommand(argv: string[], environment: NodeJS.ProcessEnv = {}): string[] {
  const runner = cliRunner();
  const assigned = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  return assigned.length > 0
    ? ["env", ...assigned, ...runner, "supervise-startup", "--", "open", ...argv]
    : [...runner, "open", ...argv];
}

async function superviseStartup(args: string[]): Promise<number> {
  if (args.shift() !== "--" || args.length === 0) throw new Error("invalid startup supervisor command");
  finishStartupReporting();
  const runner = cliRunner();
  const child = spawn(runner[0], [...runner.slice(1), ...args], {
    env: { ...process.env, TERMINAL_BROWSER_STARTUP_SUPERVISED: "1" },
    stdio: ["inherit", "inherit", "pipe"],
  });
  let stderr = "";
  let ready = false;
  let stopped = false;
  const attempt = startupAttempt();
  const watch = async () => {
    while (!stopped && !ready && attempt) {
      ready = (await instances()).some((record) => record.startupAttempt === attempt);
      if (!ready) await sleep(100);
    }
  };
  void watch().catch(() => {});
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    const remaining = 8192 - Buffer.byteLength(stderr);
    if (remaining > 0) stderr += chunk.subarray(0, remaining).toString("utf8");
  });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      stopped = true;
      if (!ready) {
        const error = new Error(stderr.trim() || `browser process exited before startup readiness${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`);
        if (typeof code === "number") Object.assign(error, { code: `BROWSER_EXIT_${code}`, exitCode: code });
        if (signal) Object.assign(error, { code: "BROWSER_EXIT_SIGNAL", signal, exitCode: null });
        writeStartupFailure(error);
      }
      resolve(signal ? 128 : code ?? 1);
    });
  });
}

function ownTtyPath(): string | null {
  try {
    const out = execFileSync("tty", {
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.startsWith("/dev/") ? out : null;
  } catch {
    return null;
  }
}

function interactiveTty(): string | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return ownTtyPath();
}

function connectDaemon(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(DAEMON_SOCKET);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("daemon connection timed out")); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function spawnDaemon(): { failure: () => Error | null } {
  const { command, cwd } = browserLaunchCommand(["--daemon"]);
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let failed: Error | null = null;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    try { fs.appendFileSync(path.join(LOGS_DIR, "stderr.log"), text); } catch {}
    const remaining = 8192 - Buffer.byteLength(stderr);
    if (remaining > 0) stderr += Buffer.from(text).subarray(0, remaining).toString("utf8");
  });
  child.once("error", (error) => { failed = error; });
  child.once("close", (code, signal) => {
    const detail = stderr.trim();
    failed = new Error(detail || `daemon process exited before socket acquisition with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`);
    if (typeof code === "number") {
      (failed as NodeJS.ErrnoException).code = `DAEMON_EXIT_${code}`;
      Object.assign(failed, { exitCode: code });
    }
    if (signal) Object.assign(failed, { signal, exitCode: null });
  });
  (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();
  child.unref();
  return { failure: () => failed };
}

async function daemonSocket(): Promise<net.Socket> {
  try {
    return await connectDaemon();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || fs.existsSync(DAEMON_SOCKET)) throw new Error("existing daemon is unavailable; inspect status before explicit recovery");
  }
  const appData = INSTALLATION?.paths.appData ?? process.env.TERMINAL_BROWSER_APPDATA ?? (process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support") : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  if (fs.existsSync(path.join(appData, APP_DIR_NAME, "terminal-browser.lock"))) throw new Error("profile ownership is occupied or uncertain; no daemon was started. Inspect doctor before explicit recovery.");
  const launch = spawnDaemon();
  return waitForSpawnedDaemon({
    connect: connectDaemon,
    failure: launch.failure,
    timeoutMs: 15_000,
  });
}

interface DaemonReply {
  ok?: boolean;
  error?: string;
  session?: string;
  event?: string;
  code?: number;
  sessions?: number;
}

function nextReply(socket: net.Socket, onLine: (reply: DaemonReply) => void): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      try {
        onLine(JSON.parse(line) as DaemonReply);
      } catch {}
    }
  });
}


async function openSession(argv: string[], tty: string): Promise<{ socket: net.Socket; reply: DaemonReply }> {
  const payload = {
    cmd: "open",
    tty,
    argv,
    env: process.env,
    cwd: process.cwd(),
  };
  let expectedInstance: string;
  const ask = (socket: net.Socket) =>
    new Promise<DaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("daemon open timed out")); }, 20_000);
      nextReply(socket, (reply) => { clearTimeout(timer); resolve(reply); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("daemon closed the connection")); });
      socket.write(`${JSON.stringify({ ...payload, identity: RUNTIME_IDENTITY, expectedInstance })}\n`);
    });
  const socket = await daemonSocket();
  try {
    const hello = await daemonRequest({ cmd: "hello" }) as { identity?: { instanceId?: string } };
    if (!runtimeMatches(hello.identity) || typeof hello.identity?.instanceId !== "string") throw new Error("daemon runtime mismatch; explicit replacement approval is required");
    expectedInstance = hello.identity.instanceId;
  } catch (error) { socket.destroy(); throw error; }
  const reply = await ask(socket);
  return { socket, reply };
}

async function shutdownDaemon(args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "--expect") throw new Error("shutdown requires --expect STATUS_FILE after explicit approval of all affected sessions; use daemon-status first");
  const stat = fs.lstatSync(args[1]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("invalid expected daemon status file");
  const expected = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const answer = await daemonRequest({ cmd: "shutdown", expected: { identity: expected.identity, sessions: expected.sessions, complete: expected.complete } }) as { ok?: boolean };
  if (!answer.ok) throw new Error("daemon identity or session inventory changed; request fresh status and approval");
  print({ stopped: true, automaticRestart: false });
  return 0;
}

async function attachHere(argv: string[]): Promise<never> {
  const tty = ownTtyPath();
  if (!tty) throw new Error("not running on a tty");
  const { socket, reply } = await openSession(argv, tty);
  if (reply.ok === false || !reply.session) {
    socket.destroy();
    throw new Error(reply.error ?? "daemon refused the session");
  }
  void finishReportingWhenRegistered().catch(() => {});
  nextReply(socket, (message) => {
    if (message.event === "closed") process.exit(message.code ?? 0);
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
  process.on("SIGWINCH", () => {
    try {
      socket.write('{"cmd":"resize"}\n');
    } catch {}
  });
  const requestClose = () => {
    try {
      socket.write('{"cmd":"close"}\n');
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", requestClose);
  process.on("SIGTERM", requestClose);
  process.on("SIGHUP", requestClose);
  return new Promise<never>(() => {});
}

async function openHere(argv: string[]): Promise<never> {
  await sshSetup(argv);
  return attachHere(argv);
}

function flagEq(argv: string[], flag: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function sshSetup(argv: string[]): Promise<void> {
  const target = flagEq(argv, "--ssh");
  if (!target) return;
  const status = (line: string) => process.stdout.write(`ssh: ${line}\n`);
  const interrupt = () => process.exit(130);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);
  let bundle: RemoteBundle | null = null;
  const tunnel = await openSshTunnel(target, status);
  process.on("exit", () => {
    try {
      bundle?.stop();
    } catch {}
    tunnel.stop();
  });
  argv.push(`--socks-port=${tunnel.socksPort}`);
  const bundleDir = flagEq(argv, "--ssh-bundle");
  if (bundleDir) {
    const remoteBase = flagEq(argv, "--ssh-bundle-dir");
    bundle = await startBundle(tunnel, bundleDir, status, remoteBase || undefined);
    if (!argv.some((arg) => !arg.startsWith("-"))) argv.unshift(bundle.url);
  }
  for (const signal of signals) process.removeListener(signal, interrupt);
}

const DIRECTIONS: Direction[] = ["right", "left", "down", "up"];

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as string[]).includes(value);
}

function takeSplitFlag(args: string[]): Direction | null {
  const raw = takeFlag(args, "--split");
  if (raw === undefined) return null;
  if (!isDirection(raw)) fail(`invalid --split ${raw} (right, left, down, up)`);
  return raw;
}

function takeSizeFlag(args: string[]): number | null {
  const raw = takeFlag(args, "--size");
  if (raw === undefined || raw === null) return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || size < 0.2 || size > 0.95) {
    fail(`invalid --size ${raw} (fraction between 0.2 and 0.95)`);
  }
  return size;
}





async function launchInSplit(
  terminal: Terminal,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const from = await terminal.getCurrentPane?.({ tty: ownTtyPath() ?? callerTty().path, cwd: process.cwd() });
  if (!from) fail(`could not work out which ${terminal.name} pane you are in`);
  const startup = createStartupAttempt();
  let pane: string | null = null;
  try {
    try {
      const opened = await terminal.split!({
        from,
        direction,
        command: clientLaunchCommand(argv, startupEnvironment(startup)),
        size: size ?? null,
        tty: ownTtyPath() ?? callerTty().path,
        onPaneCreated: (created) => {
          pane = created.id;
          bindStartupPane(startup, created.id);
        },
      });
      pane = opened?.id ?? null;
    } catch (error) {
      const created = (error as { pane?: { id?: unknown } })?.pane;
      pane = typeof created?.id === "string" ? created.id : null;
      const report = writeStartupFailure(error, { pane }, startupEnvironment(startup));
      if (!report) throw error;
      report.cleanup = {
        status: "retained",
        nextStep: `Inspect${pane ? ` pane ${pane}` : " the launch target"} and run terminal-browser doctor --json before explicit recovery.`,
      };
      throw startupFailureError(report);
    }
    const patience = argv.some((arg) => arg.startsWith("--ssh=")) ? 600_000 : 20_000;
    return await waitForStartup({
      startup,
      pane,
      timeoutMs: patience,
      timeoutMessage: `browser did not register within ${Math.round(patience / 1000)}s`,
      findReady: async (attempt) => (await instances()).find((record) => record.startupAttempt === attempt) ?? null,
      paneStatus: terminal.paneStatus,
    });
  } finally {
    removeStartupAttempt(startup);
  }
}

let asked: Promise<TerminalCheck> | null = null;

function currentTerminal(): Promise<TerminalCheck> {
  asked ??= checkTerminal(detect());
  return asked;
}

async function newTabCommand(url: string | undefined, key: string | undefined): Promise<number> {
  const check = await currentTerminal();
  const found = await browsers(check.terminal);
  const here = key
    ? found.filter((browser) => recordKey(browser) === key)
    : found.filter((browser) => browser.inCurrentTab);
  const list = (browsers: Browser[]) => browsers.map((browser) => `  ${describe(browser)}`).join("\n");
  if (key && here.length === 0) fail(`no browser ${key}. Running:\n${list(found)}`);
  if (here.length > 1) {
    fail(`${here.length} browsers in this tab, so say which with --browser:\n${list(here)}`);
  }
  const target = here[0];
  if (target) {
    const where = url ? { cmd: "open-tab", url, cwd: process.cwd() } : { cmd: "open-tab" };
    print(await control(target.socket, where));
    return 0;
  }
  if (!key && !mergeDisabled() && (await tryAdopt(url ? [url] : []))) return 0;
  await requireGraphics(check);
  const argv = url ? [url] : [];
  if (interactiveTty()) return openHere(argv);
  if (!canSplit(check.terminal)) fail(cannotOpenPanes(check.terminal));
  const split = url && fs.existsSync(url) ? [path.resolve(url)] : argv;
  split.push("--split-dir=right");
  const tty = ownTtyPath() ?? callerTty().path;
  if (tty) split.push(`--parent-tty=${tty}`);
  print(await launchInSplit(check.terminal!, "right", split, null));
  return 0;
}

async function requireGraphics(check: TerminalCheck) {
  if (check.graphics !== "unsupported") return;
  process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
  process.exit(1);
}

const BROWSER_FLAGS = [
  "--app-mode",
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--open-tabs-in-popup-stack",
  "--allow-clipboard-read",
  "--partition=",
  "--ssh=",
  "--ssh-bundle=",
  "--ssh-bundle-dir=",
  "--preload=",
  "--main-script=",
  "--app-name=",
  "--app-id=",
  "--palette-key=",
  "--find-key=",
  "--devtools-key=",
  "--console-key=",
  "--split-dir=",
  "--parent-tty=",
];

function rejectUnknownFlags(args: string[]) {
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const known = BROWSER_FLAGS.some((flag) =>
      flag.endsWith("=") ? arg.startsWith(flag) : arg === flag,
    );
    if (!known) fail(`unknown option ${arg.split("=")[0]} (terminal-browser open --help)`);
  }
}

function takeSshFlags(args: string[]): void {
  const ssh = takeFlag(args, "--ssh");
  if (ssh !== undefined) args.push(`--ssh=${ssh}`);
  const bundle = takeFlag(args, "--ssh-bundle");
  if (bundle !== undefined) args.push(`--ssh-bundle=${bundle}`);
  const bundleDir = takeFlag(args, "--ssh-bundle-dir");
  if (bundleDir !== undefined) args.push(`--ssh-bundle-dir=${bundleDir}`);
  const at = args.findIndex((arg) => arg.startsWith("--ssh-bundle="));
  if (at >= 0) {
    args[at] = `--ssh-bundle=${path.resolve(args[at].slice("--ssh-bundle=".length))}`;
  }
  const target = args.find((arg) => arg.startsWith("--ssh="))?.slice("--ssh=".length);
  if (at >= 0 && !target) fail("--ssh-bundle needs --ssh");
  if (args.some((arg) => arg.startsWith("--ssh-bundle-dir=")) && at < 0) {
    fail("--ssh-bundle-dir needs --ssh-bundle");
  }
  try {
    if (target) validateSshTarget(target);
    if (at >= 0) validateBundleDir(args[at].slice("--ssh-bundle=".length));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function requirePaneAccess(): void {
  const refusal = sandboxRefusal();
  if (refusal) fail(refusal);
}

function mergeDisabled(): boolean {
  return process.env.TERMINAL_BROWSER_NO_MERGE === "1";
}

async function tryAdopt(args: string[]): Promise<boolean> {
  const terminal = (await currentTerminal()).terminal;
  const hosts = await findHosts(terminal).catch(() => []);
  if (hosts.length === 0) return false;
  const url = args.find((arg) => !arg.startsWith("-"));
  const resolved = url && fs.existsSync(url) ? path.resolve(url) : url;
  if (!args.includes("--app-mode")) {
    for (const host of hosts) {
      try {
        const opened = await openInHost(host.socket, { url: resolved });
        print({ adopted: instanceKey(host), socket: host.socket, tab: opened.tab });
        return true;
      } catch {}
    }
    return false;
  }
  if (!resolved) return false;
  const name = flagEq(args, "--app-name");
  const idFlag = flagEq(args, "--app-id");
  const app: NonNullable<OpenSpec["app"]> = { id: appId(idFlag ?? name ?? "app") };
  if (name !== undefined) app.name = name;
  const partition = flagEq(args, "--partition");
  if (partition) app.partition = partition;
  const preload = flagEq(args, "--preload");
  if (preload) app.preload = path.resolve(preload);
  const mainScript = flagEq(args, "--main-script");
  if (mainScript) app.mainScript = path.resolve(mainScript);
  const spec: OpenSpec = { url: resolved, app };
  for (const host of hosts) {
    try {
      const opened = await openInHost(host.socket, spec);
      print({ adopted: instanceKey(host), socket: host.socket, tab: opened.tab });
      return true;
    } catch {}
  }
  return false;
}

async function companionCommand(args: string[]): Promise<number> {
  const subcommand = args.shift();
  const owner = currentBrowserOwner(process.env, process.cwd());
  if (subcommand === "open") {
    const newTab = takeBoolFlag(args, "--new-tab");
    const noFocus = takeBoolFlag(args, "--no-focus");
    const url = args.shift();
    if (url?.startsWith("-")) fail(`unknown option ${url}`);
    if (args.length > 0) fail(`unexpected ${args[0]}`);
    print(await openCompanion(owner, { url, newTab, focus: !noFocus }, process.env));
    return 0;
  }
  if (subcommand === "tabs") {
    const action = takeFlag(args, "--action") ?? "list";
    if (action !== "list" && action !== "activate" && action !== "open" && action !== "close" && action !== "wait" && action !== "downloads" && action !== "download_wait" && action !== "download_cancel") {
      fail("companion tabs --action must be list, activate, open, close, wait, downloads, download_wait, or download_cancel");
    }
    const tabValue = takeFlag(args, "--tab");
    const downloadId = takeFlag(args, "--download-id");
    const afterValue = takeFlag(args, "--after-id");
    const timeoutValue = takeFlag(args, "--timeout-ms");
    const url = takeFlag(args, "--url");
    if (args.length > 0) fail(`unexpected ${args[0]}`);
    const tab = tabValue === undefined ? undefined : Number(tabValue.replace(/^t/, ""));
    print(await companionTabs(owner, { action, tab, url, downloadId, afterId: afterValue === undefined ? undefined : Number(afterValue), timeoutMs: timeoutValue === undefined ? undefined : Number(timeoutValue), cwd: process.cwd() }));
    return 0;
  }
  fail("companion needs open or tabs");
}

async function openCommand(args: string[]) {
  requirePaneAccess();
  const split = takeSplitFlag(args);
  const size = takeSizeFlag(args);
  const noMerge = takeBoolFlag(args, "--no-merge") || mergeDisabled();
  if (size !== null && !split) fail("--size only applies to a split (--split <direction>)");
  takeSshFlags(args);
  rejectUnknownFlags(args);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length > 1) {
    fail(`unexpected ${positionals[1]} (one url; --split <direction> opens a new pane)`);
  }
  const targeted = Boolean(process.env.TERMINAL_BROWSER_INTEROP_TARGET);
  const wouldSplit = split !== null || !interactiveTty();
  if (!noMerge && (wouldSplit || targeted) && !args.some((arg) => arg.startsWith("--ssh="))) {
    if (await tryAdopt(args)) return;
  }
  await requireGraphics(await currentTerminal());
  if (!split && interactiveTty()) {
    return openHere(args);
  }
  const terminal = (await currentTerminal()).terminal;
  const direction = split ?? "right";
  if (!canSplit(terminal)) fail(cannotOpenPanes(terminal));
  const url = args.find((arg) => !arg.startsWith("-"));
  const own = ownTtyPath();
  const caller = own ? null : callerTty();
  if (caller?.denied) {
    const refusal = deniedRefusal();
    if (refusal) fail(refusal);
  }
  const tty = own ?? caller?.path ?? null;
  const argv = args.map((arg) => (arg === url && fs.existsSync(arg) ? path.resolve(arg) : arg));
  argv.push(`--split-dir=${direction}`);
  if (tty) argv.push(`--parent-tty=${tty}`);
  print(await launchInSplit(terminal!, direction, argv, size));
}

function splitPassthrough(args: string[]): { own: string[]; passthrough: string[] } {
  const at = args.indexOf("--");
  if (at < 0) return { own: args, passthrough: [] };
  return { own: args.slice(0, at), passthrough: args.slice(at + 1) };
}

function takeTabFlag(args: string[]): number | undefined {
  const raw = takeFlag(args, "--tab");
  if (raw === undefined) return undefined;
  const id = Number(raw.replace(/^t/, ""));
  if (!Number.isInteger(id)) fail(`invalid --tab ${raw} (a tab id from terminal-browser ls)`);
  return id;
}

function asksForHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  return own.includes("--help") || own.includes("-h");
}

function registerAppCommand(args: string[]): number {
  const idFlag = takeFlag(args, "--id");
  const name = takeFlag(args, "--name");
  const bin = takeFlag(args, "--bin");
  const argsFlag = takeFlag(args, "--args");
  if (!name) fail("register-app needs --name");
  if (!bin) fail("register-app needs --bin");
  const binPath = path.resolve(bin);
  if (!fs.existsSync(binPath)) fail(`no such file ${binPath}`);
  const id = appId(idFlag ?? name);
  registerApp({
    id,
    name,
    bin: binPath,
    args: argsFlag ? argsFlag.split(/\s+/).filter(Boolean) : [],
  });
  process.stdout.write(`registered ${name} (${id})\n`);
  return 0;
}

function unregisterAppCommand(args: string[]): number {
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!id) fail("unregister-app needs an app id (terminal-browser apps)");
  if (!unregisterApp(appId(id))) fail(`no registered app ${id}`);
  process.stdout.write(`unregistered ${id}\n`);
  return 0;
}

function appsCommand(args: string[]): number {
  const json = takeBoolFlag(args, "--json");
  const apps = listApps();
  if (json) {
    print(apps);
    return 0;
  }
  if (apps.length === 0) {
    process.stdout.write("no apps registered\n");
    return 0;
  }
  const rows = apps.map((app) => [app.id, app.name, app.bin]);
  const header = ["id", "name", "bin"];
  const widths = header.map((label, col) =>
    Math.max(label.length, ...rows.map((row) => row[col].length)),
  );
  for (const row of [header, ...rows]) {
    const line = row.map((cell, col) => cell.padEnd(widths[col])).join("  ");
    process.stdout.write(`${line.trimEnd()}\n`);
  }
  return 0;
}

function helpCommand(topic: string | undefined): number {
  if (!topic) {
    process.stdout.write(rootHelp());
    return 0;
  }
  const help = commandHelp(topic);
  if (!help) fail(`no help for ${topic} (try ${helpTopics().join(", ")})`);
  process.stdout.write(help);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`terminal-browser ${installedVersion() ?? "dev"}\n`);
    return 0;
  }
  if (command === "help") return helpCommand(args[0]);
  if (asksForHelp(args)) {
    process.stdout.write(commandHelp(command) ?? rootHelp());
    return 0;
  }
  if (command === "supervise-startup") return superviseStartup(args);
  if (command === "doctor") { print(await doctor()); return 0; }
  if (command === "daemon-status") { print(safeDaemonStatus(await daemonRequest({ cmd: "status" }))); return 0; }
  if (command === "shutdown") return shutdownDaemon(args);
  if (command === "upgrade") return upgradeCommand();
  if (command !== "setup") ensureSetup();
  if (command === "open") {
    await openCommand(args);
    return 0;
  }
  if (command === "ls") {
    requirePaneAccess();
    const all = takeBoolFlag(args, "--all");
    const json = takeBoolFlag(args, "--json");
    await lsCommand((await currentTerminal()).terminal, all, json);
    return 0;
  }
  if (command === "setup") {
    const sandbox = apparmorSetup(electronBinary());
    linkSkills();
    const editors = setupCommand();
    markSetupDone();
    return editors !== 0 ? editors : sandbox;
  }
  if (command === "register-app") return registerAppCommand(args);
  if (command === "unregister-app") return unregisterAppCommand(args);
  if (command === "apps") return appsCommand(args);
  if (command === "new-tab") {
    requirePaneAccess();
    const key = takeFlag(args, "--browser");
    return newTabCommand(args.find((arg) => !arg.startsWith("-")), key);
  }
  if (command === "companion") {
    requirePaneAccess();
    return companionCommand(args);
  }
  if (command === "agent") {
    requirePaneAccess();
    return agentCommand((await currentTerminal()).terminal, args);
  }
  if (command === "action") {
    requirePaneAccess();
    const { own, passthrough } = splitPassthrough(args);
    const options = {
      browserKey: takeFlag(own, "--browser"),
      tabId: takeTabFlag(own),
      targetId: takeFlag(own, "--target"),
      follow: takeBoolFlag(own, "--follow"),
      done: false,
      passthrough,
    };
    if (own[0] === "done") {
      own.shift();
      options.done = true;
      if (passthrough.length > 0) fail("[PLACEHOLDER COPY]");
    }
    if (own.length > 0) fail(`unexpected ${own[0]} — put agent-browser arguments after --`);
    return actionCommand((await currentTerminal()).terminal, options);
  }
  const rest = process.argv.slice(2);
  if (asksForHelp(rest)) {
    process.stdout.write(commandHelp("open") ?? rootHelp());
    return 0;
  }
  await openCommand(rest);
  return 0;
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => {
    const report = error instanceof StartupFailure ? error.report : writeStartupFailure(error);
    if (rootStartup) removeStartupAttempt(rootStartup);
    fail(report ? JSON.stringify(report) : error instanceof Error ? error.message : String(error));
  });
