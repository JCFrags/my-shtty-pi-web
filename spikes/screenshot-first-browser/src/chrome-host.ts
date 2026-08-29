import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CdpConnection } from "./cdp.js";

export interface ChromeHostOptions {
  hostId: string;
  executable?: string;
  windowPosition?: { x: number; y: number };
  startupTimeoutMs?: number;
}

export interface ChromeHostMetrics {
  startupMs: number;
  pid: number;
  debuggingPort: number;
  profileDirectory: string;
}

const EXECUTABLE_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export class ChromeHost {
  readonly hostId: string;
  readonly executable: string;
  readonly profileDirectory: string;
  readonly process: ChildProcess;
  readonly cdp: CdpConnection;
  readonly metrics: ChromeHostMetrics;
  private processExited = false;
  private cdpDisconnected = false;
  private closed = false;

  private constructor(
    options: ChromeHostOptions,
    executable: string,
    profileDirectory: string,
    process: ChildProcess,
    cdp: CdpConnection,
    metrics: ChromeHostMetrics,
  ) {
    this.hostId = options.hostId;
    this.executable = executable;
    this.profileDirectory = profileDirectory;
    this.process = process;
    this.cdp = cdp;
    this.metrics = metrics;
    process.once("exit", () => { this.processExited = true; });
    cdp.once("disconnect", () => { this.cdpDisconnected = true; });
  }

  static async launch(options: ChromeHostOptions): Promise<ChromeHost> {
    const started = performance.now();
    const executable = options.executable ?? await findChromeExecutable();
    const profileDirectory = await mkdtemp(join(tmpdir(), `pi-phase0-${options.hostId}-`));
    await assertPrivateDirectory(profileDirectory);
    const position = options.windowPosition ?? { x: 40, y: 40 };
    const args = [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--password-store=basic",
      "--window-size=900,700",
      `--window-position=${position.x},${position.y}`,
      "about:blank",
    ];
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let diagnostics = "";
    child.stderr?.on("data", (data: Buffer) => {
      if (diagnostics.length < 16_384) diagnostics += data.toString();
    });
    try {
      const activePortFile = join(profileDirectory, "DevToolsActivePort");
      const [port, browserPath] = await waitForActivePort(activePortFile, child, options.startupTimeoutMs ?? 15_000, () => diagnostics);
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`);
      await cdp.send("Browser.getVersion");
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      const metrics: ChromeHostMetrics = {
        startupMs: performance.now() - started,
        pid: child.pid ?? -1,
        debuggingPort: port,
        profileDirectory,
      };
      return new ChromeHost(options, executable, profileDirectory, child, cdp, metrics);
    } catch (error) {
      child.kill("SIGTERM");
      await rm(profileDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  get connected(): boolean {
    return !this.cdpDisconnected && this.cdp.connected;
  }

  get running(): boolean {
    return !this.processExited && this.process.exitCode === null && this.process.signalCode === null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connected) {
      try {
        await this.cdp.send("Browser.close", {}, undefined, 2_000);
      } catch {
        // The socket commonly closes before Browser.close returns.
      }
    }
    await waitForExit(this.process, 3_000);
    if (this.running) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 2_000);
    }
    if (this.running) {
      this.process.kill("SIGKILL");
      await waitForExit(this.process, 1_000);
    }
    this.cdp.close();
    await rm(this.profileDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function findChromeExecutable(): Promise<string> {
  const configured = process.env.SPIKE_CHROME_BIN;
  const candidates = configured ? [configured] : EXECUTABLE_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed candidate.
    }
  }
  throw new Error(`No Chrome executable found. Set SPIKE_CHROME_BIN. Tried: ${candidates.join(", ")}`);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`Temporary profile is not private: ${path} mode ${mode.toString(8)}`);
}

async function waitForActivePort(
  path: string,
  child: ChildProcess,
  timeoutMs: number,
  diagnostics: () => string,
): Promise<[number, string]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited during startup (${child.exitCode ?? child.signalCode}): ${diagnostics()}`);
    }
    try {
      const [portText, browserPath] = (await readFile(path, "utf8")).trim().split("\n");
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && browserPath?.startsWith("/devtools/browser/")) {
        return [port, browserPath];
      }
    } catch {
      // The file appears after Chrome opens the debugging endpoint.
    }
    await sleep(50);
  }
  throw new Error(`Chrome startup timeout after ${timeoutMs} ms: ${diagnostics()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
