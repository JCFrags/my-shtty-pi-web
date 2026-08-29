import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { CdpConnection } from "../cdp/connection.js";

const EXECUTABLES = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
const SAFE_EXTRA_FLAGS = new Set(["--disable-gpu", "--enable-features=UseOzonePlatform", "--ozone-platform=wayland", "--ozone-platform=x11"]);
const FORBIDDEN_FLAG_PARTS = ["no-sandbox", "disable-web-security", "ignore-certificate", "disable-site-isolation", "user-data-dir", "remote-debugging"];
const MANIFEST = "browserd-owned.json";

interface OwnedManifest { version: 1; marker: "browserd-temporary-profile"; pid: number; processStartTicks: string; createdAt: string }

export interface ChromeHostOptions {
  hostId: string;
  executable?: string;
  profileRoot?: string;
  startupTimeoutMs?: number;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  extraFlags?: readonly string[];
}

export class ChromeHost extends EventEmitter {
  readonly startupMs: number;
  readonly pid: number;
  private processExited = false;
  private cdpDisconnected = false;
  private closed = false;

  private constructor(
    readonly hostId: string,
    readonly executable: string,
    readonly profileRoot: string,
    readonly profileDirectory: string,
    private readonly child: ChildProcess,
    readonly cdp: CdpConnection,
    startedAt: number,
  ) {
    super();
    this.startupMs = performance.now() - startedAt;
    this.pid = child.pid ?? -1;
    child.once("exit", () => { this.processExited = true; this.emit("exit"); });
    cdp.once("disconnect", () => { this.cdpDisconnected = true; this.emit("disconnect"); });
  }

  static async launch(options: ChromeHostOptions): Promise<ChromeHost> {
    const startedAt = performance.now();
    const executable = options.executable ?? await findChromeExecutable();
    await access(executable, constants.X_OK);
    const extraFlags = validateExtraFlags(options.extraFlags ?? []);
    const profileRoot = resolve(options.profileRoot ?? join(tmpdir(), "pi-browserd-profiles"));
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    await chmod(profileRoot, 0o700);
    await cleanupOrphanProfiles(profileRoot);
    const profileDirectory = await mkdtemp(join(profileRoot, "session-"));
    await chmod(profileDirectory, 0o700);
    const provisionalManifest: OwnedManifest = { version: 1, marker: "browserd-temporary-profile", pid: 0, processStartTicks: "pending", createdAt: new Date().toISOString() };
    await writeFile(join(profileDirectory, MANIFEST), `${JSON.stringify(provisionalManifest)}\n`, { mode: 0o600 });
    const size = options.windowSize ?? { width: 900, height: 700 };
    const position = options.windowPosition ?? { x: 40, y: 40 };
    const args = [
      `--user-data-dir=${profileDirectory}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--password-store=basic",
      `--window-size=${size.width},${size.height}`, `--window-position=${position.x},${position.y}`,
      ...extraFlags, "about:blank",
    ];
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (diagnostics.length < 16_384) diagnostics += chunk.toString("utf8", 0, 16_384 - diagnostics.length); });
    try {
      if (child.pid === undefined) throw new Error("Chrome did not provide a process ID.");
      const processStartTicks = await waitForProcessStartTicks(child.pid, 2_000);
      const manifest: OwnedManifest = { version: 1, marker: "browserd-temporary-profile", pid: child.pid, processStartTicks, createdAt: new Date().toISOString() };
      await writeFile(join(profileDirectory, MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const [port, browserPath] = await waitForActivePort(join(profileDirectory, "DevToolsActivePort"), child, options.startupTimeoutMs ?? 20_000, () => diagnostics);
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`, { timeoutMs: 5_000 });
      await cdp.send("Browser.getVersion");
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      return new ChromeHost(options.hostId, executable, profileRoot, profileDirectory, child, cdp, startedAt);
    } catch (error) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000);
      if (isRunning(child)) child.kill("SIGKILL");
      await waitForExit(child, 1_000);
      await safeDeleteOwnedProfile(profileRoot, profileDirectory).catch(() => undefined);
      throw new Error(`Chrome startup failed${diagnostics ? ": diagnostics captured" : ""}`, { cause: error });
    }
  }

  get running(): boolean { return !this.processExited && isRunning(this.child); }
  get connected(): boolean { return !this.cdpDisconnected && this.cdp.connected; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connected) {
      try { await this.cdp.send("Browser.close", {}, undefined, { timeoutMs: 2_000 }); } catch { /* Socket often closes before the response. */ }
    }
    await waitForExit(this.child, 3_000);
    if (this.running) { this.child.kill("SIGTERM"); await waitForExit(this.child, 2_000); }
    if (this.running) { this.child.kill("SIGKILL"); await waitForExit(this.child, 1_000); }
    this.cdp.close();
    await safeDeleteOwnedProfile(this.profileRoot, this.profileDirectory);
  }

  killForTest(signal: NodeJS.Signals = "SIGKILL"): void { if (this.running) this.child.kill(signal); }
}

export async function findChromeExecutable(configured = process.env.BROWSERD_CHROME_BIN): Promise<string> {
  for (const candidate of configured ? [configured] : EXECUTABLES) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue fixed candidates. */ }
  }
  throw new Error("No reviewed Chrome or Chromium executable is available.");
}

export function validateExtraFlags(flags: readonly string[]): string[] {
  if (flags.length > 8) throw new Error("Too many Chrome flags.");
  return flags.map((flag) => {
    const lowered = flag.toLowerCase();
    if (!SAFE_EXTRA_FLAGS.has(flag) || FORBIDDEN_FLAG_PARTS.some((part) => lowered.includes(part))) throw new Error("Chrome flag is not allowed.");
    return flag;
  });
}

export async function cleanupOrphanProfiles(profileRoot: string): Promise<void> {
  const root = await realpath(profileRoot);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const directory = join(root, entry.name);
    const manifest = await readOwnedManifest(directory).catch(() => undefined);
    if (manifest === undefined) continue;
    const currentTicks = await readProcessStartTicks(manifest.pid).catch(() => undefined);
    if (currentTicks === manifest.processStartTicks) continue;
    await safeDeleteOwnedProfile(root, directory);
  }
}

async function safeDeleteOwnedProfile(profileRoot: string, directory: string): Promise<void> {
  const root = await realpath(profileRoot);
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${root}${sep}`) || !basename(absolute).startsWith("session-")) throw new Error("Profile deletion escaped its owned root.");
  const info = await lstat(absolute).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Owned profile path is not a real directory.");
  await readOwnedManifest(absolute);
  await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
}

async function readOwnedManifest(directory: string): Promise<OwnedManifest> {
  const path = join(directory, MANIFEST);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Invalid owned-profile manifest.");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.marker !== "browserd-temporary-profile" || typeof parsed.pid !== "number" || typeof parsed.processStartTicks !== "string" || typeof parsed.createdAt !== "string") throw new Error("Invalid owned-profile manifest.");
  return { version: 1, marker: "browserd-temporary-profile", pid: parsed.pid, processStartTicks: parsed.processStartTicks, createdAt: parsed.createdAt };
}

async function waitForActivePort(path: string, child: ChildProcess, timeoutMs: number, diagnostics: () => string): Promise<[number, string]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isRunning(child)) throw new Error(`Chrome exited during startup${diagnostics() ? " with diagnostics" : ""}.`);
    try {
      const [portText, browserPath] = (await readFile(path, "utf8")).trim().split("\n");
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && browserPath?.startsWith("/devtools/browser/")) return [port, browserPath];
    } catch { /* File appears after loopback endpoint starts. */ }
    await sleep(50);
  }
  throw new Error("Chrome startup timed out.");
}

async function waitForProcessStartTicks(pid: number, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { try { return await readProcessStartTicks(pid); } catch { await sleep(10); } }
  throw new Error("Could not read Chrome process identity.");
}

async function readProcessStartTicks(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).split(" ");
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) throw new Error("Invalid process stat.");
  return startTicks;
}

function isRunning(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return;
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), sleep(timeoutMs)]);
}
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
