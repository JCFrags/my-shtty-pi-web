import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { CdpConnection, type CdpEvent } from "../cdp/connection.js";
import { cleanupLegacyOrphanProfiles, ProfileManager, type ProfileLease, readProcessStartTicks } from "./profile-manager.js";

const EXECUTABLES = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
const SAFE_EXTRA_FLAGS = new Set(["--disable-gpu", "--enable-features=UseOzonePlatform", "--ozone-platform=wayland", "--ozone-platform=x11"]);
const FORBIDDEN_FLAG_PARTS = ["no-sandbox", "disable-web-security", "ignore-certificate", "disable-site-isolation", "user-data-dir", "remote-debugging"];

export interface ChromeHostOptions {
  hostId: string;
  executable?: string;
  profileRoot?: string;
  profileManager?: ProfileManager;
  startupTimeoutMs?: number;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  extraFlags?: readonly string[];
  egressProxy?: { readonly host: "127.0.0.1" | "::1"; readonly port: number };
}

export interface DownloadDenialEvent { readonly code: "DOWNLOAD_DENIED"; readonly guid: string; readonly state: "cancel-requested" | "cancel-failed" }

export class ChromeHost extends EventEmitter {
  readonly startupMs: number;
  readonly pid: number;
  private processExited = false;
  private cdpDisconnected = false;
  private closeState: "open" | "closing" | "closed" | "cleanup-failed" = "open";
  private closePromise: Promise<void> | undefined;
  private readonly downloadDenials: DownloadDenialEvent[] = [];
  private removeDownloadDenial: (() => void) | undefined;

  private constructor(
    readonly hostId: string,
    readonly executable: string,
    readonly profileRoot: string,
    readonly profileDirectory: string,
    private readonly lease: ProfileLease,
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

  static async launch(options: ChromeHostOptions, signal?: AbortSignal, markProcessDispatched?: () => void): Promise<ChromeHost> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const executable = options.executable ?? await findChromeExecutable();
    signal?.throwIfAborted();
    await access(executable, constants.X_OK);
    const extraFlags = validateExtraFlags(options.extraFlags ?? []);
    const egressFlags = proxyFlags(options.egressProxy);
    const manager = options.profileManager ?? new ProfileManager(options.profileRoot);
    const lease = await manager.allocate();
    let child: ChildProcess | undefined;
    let diagnostics = "";
    try {
      signal?.throwIfAborted();
      await lease.markStarting(executable);
      const size = options.windowSize ?? { width: 900, height: 700 };
      const position = options.windowPosition ?? { x: 40, y: 40 };
      const args = [
        `--user-data-dir=${lease.directory}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
        "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--disable-component-update", "--disable-default-apps", "--password-store=basic",
        `--window-size=${size.width},${size.height}`, `--window-position=${position.x},${position.y}`,
        ...egressFlags, ...extraFlags, "about:blank",
      ];
      signal?.throwIfAborted();
      markProcessDispatched?.();
      child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
      child.stderr?.on("data", (chunk: Buffer) => { if (diagnostics.length < 16_384) diagnostics += chunk.toString("utf8", 0, 16_384 - diagnostics.length); });
      if (child.pid === undefined) throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome did not provide a process ID.");
      signal?.throwIfAborted();
      const processStartTicks = await waitForProcessStartTicks(child.pid, 2_000, signal);
      await lease.markRunning(child.pid, processStartTicks, executable);
      const [port, browserPath] = await waitForActivePort(`${lease.directory}/DevToolsActivePort`, child, options.startupTimeoutMs ?? 20_000, () => diagnostics, signal);
      signal?.throwIfAborted();
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`, { timeoutMs: 5_000, ...(signal ? { signal } : {}) });
      await cdp.send("Browser.getVersion", {}, undefined, signal ? { signal } : {});
      await cdp.send("Target.setDiscoverTargets", { discover: true }, undefined, signal ? { signal } : {});
      const host = new ChromeHost(options.hostId, executable, manager.baseRoot, lease.directory, lease, child, cdp, startedAt);
      host.removeDownloadDenial = await installDownloadDenial(cdp, (event) => host.recordDownloadDenial(event), () => { void host.close(); }, signal);
      signal?.throwIfAborted();
      return host;
    } catch (error) {
      if (child !== undefined) await stopChild(child);
      await lease.remove().catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BrowserProtocolError) throw error;
      throw new BrowserProtocolError("BROWSER_START_FAILED", diagnostics ? "Chrome startup failed with redacted diagnostics." : "Chrome startup failed.", true);
    }
  }

  get running(): boolean { return !this.processExited && isRunning(this.child); }
  get connected(): boolean { return !this.cdpDisconnected && this.cdp.connected; }
  get deniedDownloads(): readonly DownloadDenialEvent[] { return [...this.downloadDenials]; }

  async close(): Promise<void> {
    if (this.closeState === "closed") return;
    if (this.closePromise !== undefined) return await this.closePromise;
    this.closeState = "closing";
    const promise = this.closeInternal();
    this.closePromise = promise;
    try { await promise; this.closeState = "closed"; }
    catch (error) { this.closeState = "cleanup-failed"; throw error; }
    finally { if (this.closePromise === promise) this.closePromise = undefined; }
  }

  private async closeInternal(): Promise<void> {
    const failures: unknown[] = [];
    if (this.connected) {
      try { await this.cdp.send("Browser.close", {}, undefined, { timeoutMs: 2_000 }); }
      catch { /* Process settlement below is authoritative. */ }
    }
    await waitForExit(this.child, 3_000);
    if (this.running) {
      try { this.child.kill("SIGTERM"); } catch (error) { failures.push(error); }
      await waitForExit(this.child, 2_000);
    }
    if (this.running) {
      try { this.child.kill("SIGKILL"); } catch (error) { failures.push(error); }
      await waitForExit(this.child, 1_000);
    }
    if (this.running) failures.push(new BrowserProtocolError("BROWSER_EXITED", "Chrome did not settle during cleanup.", true));
    this.removeDownloadDenial?.();
    this.removeDownloadDenial = undefined;
    try { this.cdp.close(); } catch (error) { failures.push(error); }
    try { await this.lease.remove(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Chrome cleanup failed.");
  }

  killForTest(signal: NodeJS.Signals = "SIGKILL"): void { if (this.running) this.child.kill(signal); }

  private recordDownloadDenial(event: DownloadDenialEvent): void {
    this.downloadDenials.push(event);
    while (this.downloadDenials.length > 32) this.downloadDenials.shift();
    this.emit("downloadDenied", event);
  }
}

export async function installDownloadDenial(cdp: CdpConnection, onDenied: (event: DownloadDenialEvent) => void, failClosed: () => void, signal?: AbortSignal): Promise<() => void> {
  const listener = (event: CdpEvent): void => {
    if (event.method !== "Browser.downloadWillBegin") return;
    const guid = typeof event.params.guid === "string" && event.params.guid.length > 0 && event.params.guid.length <= 256 ? event.params.guid : "invalid-download-guid";
    onDenied({ code: "DOWNLOAD_DENIED", guid, state: "cancel-requested" });
    void cdp.send("Browser.cancelDownload", { guid }, undefined, { timeoutMs: 1_000 }).catch(() => { onDenied({ code: "DOWNLOAD_DENIED", guid, state: "cancel-failed" }); failClosed(); });
  };
  cdp.on("event", listener);
  try { await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }, undefined, signal ? { signal } : {}); }
  catch (error) { cdp.off("event", listener); throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome cannot enforce download denial.", false); }
  return () => cdp.off("event", listener);
}

export async function findChromeExecutable(configured = process.env.BROWSERD_CHROME_BIN): Promise<string> {
  for (const candidate of configured ? [configured] : EXECUTABLES) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue fixed candidates. */ }
  }
  throw new BrowserProtocolError("BROWSER_START_FAILED", "No reviewed Chrome or Chromium executable is available.");
}

export function validateExtraFlags(flags: readonly string[]): string[] {
  if (flags.length > 8) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Too many Chrome flags.");
  return flags.map((flag) => {
    const lowered = flag.toLowerCase();
    if (!SAFE_EXTRA_FLAGS.has(flag) || FORBIDDEN_FLAG_PARTS.some((part) => lowered.includes(part))) throw new BrowserProtocolError("INVALID_REQUEST", "Chrome flag is not allowed.");
    return flag;
  });
}

export async function cleanupOrphanProfiles(profileRoot: string): Promise<void> { await cleanupLegacyOrphanProfiles(profileRoot); }

function proxyFlags(proxy: ChromeHostOptions["egressProxy"]): string[] {
  if (proxy === undefined) return [];
  if ((proxy.host !== "127.0.0.1" && proxy.host !== "::1") || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) throw new BrowserProtocolError("INVALID_REQUEST", "Browser egress proxy configuration is invalid.");
  const authority = proxy.host === "::1" ? `[::1]:${proxy.port}` : `127.0.0.1:${proxy.port}`;
  return [
    `--proxy-server=http://${authority}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

async function waitForActivePort(path: string, child: ChildProcess, timeoutMs: number, diagnostics: () => string, signal?: AbortSignal): Promise<[number, string]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    if (!isRunning(child)) throw new BrowserProtocolError("BROWSER_START_FAILED", diagnostics() ? "Chrome exited during startup with redacted diagnostics." : "Chrome exited during startup.");
    try {
      const [portText, browserPath] = (await readFile(path, "utf8")).trim().split("\n");
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && browserPath?.startsWith("/devtools/browser/")) return [port, browserPath];
    } catch { /* File appears after loopback endpoint starts. */ }
    await sleep(50, signal);
  }
  throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome startup timed out.", true);
}

async function waitForProcessStartTicks(pid: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { signal?.throwIfAborted(); try { return await readProcessStartTicks(pid); } catch { await sleep(10, signal); } }
  throw new BrowserProtocolError("BROWSER_START_FAILED", "Could not read Chrome process identity.");
}

function isRunning(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return;
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))]);
}
async function stopChild(child: ChildProcess): Promise<void> { if (isRunning(child)) child.kill("SIGTERM"); await waitForExit(child, 2_000); if (isRunning(child)) child.kill("SIGKILL"); await waitForExit(child, 1_000); }
async function sleep(ms: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); await new Promise<void>((resolvePromise, reject) => { const abort = (): void => { cleanup(); reject(signal?.reason); }; const timer = setTimeout(() => { cleanup(); resolvePromise(); }, ms); const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); }
