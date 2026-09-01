import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { CdpConnection, type CdpEvent } from "../cdp/connection.js";
import { cleanupLegacyOrphanProfiles, ProfileManager, type ProfileLease, readProcessStartTicks } from "./profile-manager.js";
import { parseProcessStat, type BrowserProcessIdentity } from "../resources/supervisor.js";

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
  readonly processStartTicks: string;
  readonly processSessionId: number;
  private processExited = false;
  private cdpDisconnected = false;
  private closeState: "open" | "closing" | "closed" | "cleanup-failed" = "open";
  private closePromise: Promise<void> | undefined;
  private readonly downloadDenials: DownloadDenialEvent[] = [];
  private readonly knownProcessTree = new Map<number, BrowserProcessIdentity>();
  private removeDownloadDenial: (() => void) | undefined;

  private constructor(
    readonly hostId: string,
    readonly executable: string,
    readonly profileRoot: string,
    readonly profileDirectory: string,
    private readonly lease: ProfileLease,
    private readonly child: ChildProcess,
    readonly cdp: CdpConnection,
    processStartTicks: string,
    processSessionId: number,
    startedAt: number,
  ) {
    super();
    this.startupMs = performance.now() - startedAt;
    this.pid = child.pid ?? -1;
    this.processStartTicks = processStartTicks;
    this.processSessionId = processSessionId;
    this.knownProcessTree.set(this.pid, this.processIdentity);
    child.once("exit", () => { this.processExited = true; this.emit("exit"); });
    cdp.once("disconnect", () => { this.cdpDisconnected = true; this.emit("disconnect"); });
  }

  static async launch(options: ChromeHostOptions, signal?: AbortSignal, markProcessDispatched?: () => void): Promise<ChromeHost> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const executable = options.executable ?? await findChromeExecutable();
    signal?.throwIfAborted();
    await access(executable, constants.X_OK);
    const extraFlags = prepareChromeExtraFlags(options.extraFlags ?? []);
    const egressFlags = proxyFlags(options.egressProxy);
    const manager = options.profileManager ?? new ProfileManager(options.profileRoot);
    const lease = await manager.allocate();
    let child: ChildProcess | undefined;
    let launchedIdentity: LaunchedProcessIdentity | undefined;
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
      signal?.throwIfAborted();
      child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env, detached: true });
      child.stderr?.on("data", (chunk: Buffer) => { if (diagnostics.length < 16_384) diagnostics += chunk.toString("utf8", 0, 16_384 - diagnostics.length); });
      if (child.pid === undefined) throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome did not provide a process ID.");
      signal?.throwIfAborted();
      launchedIdentity = await waitForLaunchedProcessIdentity(child.pid, 2_000, signal);
      const { processStartTicks, sessionId: processSessionId } = launchedIdentity;
      await lease.markRunning(child.pid, processStartTicks, executable);
      const [port, browserPath] = await waitForActivePort(`${lease.directory}/DevToolsActivePort`, child, options.startupTimeoutMs ?? 20_000, () => diagnostics, signal);
      signal?.throwIfAborted();
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`, { timeoutMs: 5_000, ...(signal ? { signal } : {}) });
      await cdp.send("Browser.getVersion", {}, undefined, signal ? { signal } : {});
      await cdp.send("Target.setDiscoverTargets", { discover: true }, undefined, signal ? { signal } : {});
      const host = new ChromeHost(options.hostId, executable, manager.baseRoot, lease.directory, lease, child, cdp, processStartTicks, processSessionId, startedAt);
      host.removeDownloadDenial = await installDownloadDenial(cdp, (event) => host.recordDownloadDenial(event), () => { void host.close(); }, signal);
      signal?.throwIfAborted();
      return host;
    } catch (error) {
      await cleanupFailedLaunch(child, launchedIdentity, lease).catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BrowserProtocolError) throw error;
      throw new BrowserProtocolError("BROWSER_START_FAILED", diagnostics ? "Chrome startup failed with redacted diagnostics." : "Chrome startup failed.", true);
    }
  }

  get running(): boolean { return !this.processExited && isRunning(this.child); }
  get connected(): boolean { return !this.cdpDisconnected && this.cdp.connected; }
  get processIdentity(): { readonly pid: number; readonly processStartTicks: string } { return { pid: this.pid, processStartTicks: this.processStartTicks }; }
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
    let processTreeObserved = false;
    try {
      const tree = await readExactProcessTree(this.processIdentity);
      const session = await readExactProcessSession(this.processIdentity, this.processSessionId);
      this.rememberProcessTree(uniqueProcessIdentities([...tree, ...session]));
      processTreeObserved = true;
    }
    catch { /* Uncertain tree capture retains the profile below. */ }
    if (this.connected) {
      try { await this.cdp.send("Browser.close", {}, undefined, { timeoutMs: 2_000 }); }
      catch { /* Process settlement below is authoritative. */ }
    }
    await waitForExit(this.child, 3_000);
    if (this.running) {
      try { await this.signalExact("SIGTERM"); } catch (error) { failures.push(error); }
      await waitForExit(this.child, 2_000);
    }
    if (this.running) {
      try { await this.signalExact("SIGKILL"); } catch (error) { failures.push(error); }
      await waitForExit(this.child, 1_000);
    }
    const descendants = [...this.knownProcessTree.values()].filter((identity) => identity.pid !== this.pid);
    try { await terminateExactProcesses(descendants); } catch (error) { failures.push(error); }
    const descendantStates = await Promise.all(descendants.map(async (identity) => await exactIdentityState(identity))).catch(() => undefined);
    const finalIdentity = await this.exactProcessState();
    const profileUsers = await profileUsingProcesses(this.profileDirectory).catch(() => undefined);
    const sessionMembers = await settledSessionMembers(this.processSessionId).catch(() => undefined);
    const removalSafe = closedProfileRemovalSafe({ processTreeObserved, finalIdentity, descendantStates, profileUsers, sessionMembers });
    if (this.running || !removalSafe) failures.push(new BrowserProtocolError("BROWSER_EXITED", "Chrome did not settle during cleanup.", true));
    this.removeDownloadDenial?.();
    this.removeDownloadDenial = undefined;
    try { this.cdp.close(); } catch (error) { failures.push(error); }
    if (removalSafe) {
      try { await this.lease.remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Chrome cleanup failed.");
  }

  killForTest(signal: NodeJS.Signals = "SIGKILL"): void { if (this.running) this.child.kill(signal); }

  private rememberProcessTree(identities: readonly BrowserProcessIdentity[]): void { for (const identity of identities) this.knownProcessTree.set(identity.pid, identity); }

  private async signalExact(signal: NodeJS.Signals): Promise<void> {
    const state = await this.exactProcessState();
    if (state === "gone" || state === "identity-changed") return;
    if (state !== "alive") throw new BrowserProtocolError("BROWSER_EXITED", "Chrome process identity could not be verified.", true);
    const before = await readProcessStartTicks(this.pid);
    if (before !== this.processStartTicks) return;
    process.kill(this.pid, signal);
  }

  private async exactProcessState(): Promise<"alive" | "gone" | "identity-changed" | "unknown"> {
    try { return await readProcessStartTicks(this.pid) === this.processStartTicks ? "alive" : "identity-changed"; }
    catch (error) {
      if (isMissingProcessError(error)) return "gone";
      return this.processExited || !isRunning(this.child) ? "gone" : "unknown";
    }
  }

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
  catch { cdp.off("event", listener); throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome cannot enforce download denial.", false); }
  return () => cdp.off("event", listener);
}

export async function findChromeExecutable(configured = process.env.BROWSERD_CHROME_BIN): Promise<string> {
  for (const candidate of configured ? [configured] : EXECUTABLES) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue fixed candidates. */ }
  }
  throw new BrowserProtocolError("BROWSER_START_FAILED", "No reviewed Chrome or Chromium executable is available.");
}

export function prepareChromeExtraFlags(flags: readonly string[]): string[] {
  const validated = validateExtraFlags(flags);
  const useOzonePlatform = validated.includes("--enable-features=UseOzonePlatform");
  const remaining = validated.filter((flag) => flag !== "--enable-features=UseOzonePlatform");
  const features = useOzonePlatform ? "CDPScreenshotNewSurface,UseOzonePlatform" : "CDPScreenshotNewSurface";
  return [`--enable-features=${features}`, ...remaining];
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

async function cleanupFailedLaunch(child: ChildProcess | undefined, launchedIdentity: LaunchedProcessIdentity | undefined, lease: ProfileLease): Promise<void> {
  if (child === undefined) { await lease.remove(); return; }
  const root = launchedIdentity;
  if (root === undefined) return;
  let tree: BrowserProcessIdentity[] | undefined;
  try {
    const descendants = await readExactProcessTree(root);
    const session = await readExactProcessSession(root, root.sessionId);
    tree = uniqueProcessIdentities([...descendants, ...session]);
  } catch { /* Retain the profile when the exact tree cannot be proved. */ }
  if (tree === undefined) return;
  try { await terminateExactProcesses(tree); } catch { return; }
  await waitForExit(child, 1_000);
  const states = await Promise.all(tree.map(async (identity) => await exactIdentityState(identity))).catch(() => undefined);
  if (states === undefined || states.some((state) => state === "alive" || state === "unknown")) return;
  const profileUsers = await profileUsingProcesses(lease.directory).catch(() => undefined);
  if (profileUsers === undefined || profileUsers.length > 0) return;
  const sessionMembers = await settledSessionMembers(root.sessionId).catch(() => undefined);
  if (sessionMembers === undefined || sessionMembers.length > 0) return;
  await lease.remove();
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

interface LaunchedProcessIdentity extends BrowserProcessIdentity { readonly sessionId: number }

async function waitForLaunchedProcessIdentity(pid: number, timeoutMs: number, signal?: AbortSignal): Promise<LaunchedProcessIdentity> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const record = parseHostProcessRecord(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
      if (record.sessionId !== pid) throw new BrowserProtocolError("BROWSER_START_FAILED", "Chrome did not enter its isolated process session.");
      return { pid, processStartTicks: record.processStartTicks, sessionId: record.sessionId };
    } catch (error) {
      if (error instanceof BrowserProtocolError) throw error;
      await sleep(10, signal);
    }
  }
  throw new BrowserProtocolError("BROWSER_START_FAILED", "Could not read Chrome process identity.");
}

interface HostProcessRecord extends BrowserProcessIdentity { readonly parentPid: number; readonly sessionId: number }

function parseHostProcessRecord(pid: number, text: string): HostProcessRecord {
  const identity = parseProcessStat(pid, text);
  const end = text.lastIndexOf(")");
  if (end < 2) throw new Error("Invalid process stat.");
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const sessionId = Number(fields[3]);
  if (!Number.isInteger(sessionId) || sessionId < 0) throw new Error("Invalid process session.");
  return { ...identity, sessionId };
}

async function readExactProcessTree(root: BrowserProcessIdentity): Promise<BrowserProcessIdentity[]> {
  if (await exactIdentityState(root) !== "alive") throw new Error("Browser process identity is unavailable.");
  const records: HostProcessRecord[] = [];
  let observed = 0;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    observed++;
    if (observed > 65_536) throw new Error("Process table is too large.");
    const pid = Number(entry.name);
    try { records.push(parseHostProcessRecord(pid, await readFile(`/proc/${pid}/stat`, "utf8"))); }
    catch (error) { if (!isMissingProcessError(error)) throw error; }
  }
  const rootRecord = records.find((record) => record.pid === root.pid && record.processStartTicks === root.processStartTicks);
  if (rootRecord === undefined) throw new Error("Browser process identity is unavailable.");
  const byParent = new Map<number, HostProcessRecord[]>();
  for (const record of records) {
    const values = byParent.get(record.parentPid) ?? [];
    values.push(record);
    byParent.set(record.parentPid, values);
  }
  const result: HostProcessRecord[] = [rootRecord];
  const seen = new Set([rootRecord.pid]);
  for (let index = 0; index < result.length; index++) {
    for (const child of byParent.get(result[index]?.pid ?? -1) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      if (result.length > 16_384) throw new Error("Browser process tree is too large.");
    }
  }
  if (await exactIdentityState(root) !== "alive") throw new Error("Browser process identity changed.");
  return result.map(({ pid, processStartTicks }) => ({ pid, processStartTicks }));
}

async function readExactProcessSession(root: BrowserProcessIdentity, sessionId: number): Promise<BrowserProcessIdentity[]> {
  if (await exactIdentityState(root) !== "alive") throw new Error("Browser process identity is unavailable.");
  const members = await processSessionMembers(sessionId);
  if (!members.some((identity) => identity.pid === root.pid && identity.processStartTicks === root.processStartTicks)) throw new Error("Browser process session is unavailable.");
  if (await exactIdentityState(root) !== "alive") throw new Error("Browser process identity changed.");
  return members;
}

function uniqueProcessIdentities(identities: readonly BrowserProcessIdentity[]): BrowserProcessIdentity[] {
  const result = new Map<number, BrowserProcessIdentity>();
  for (const identity of identities) {
    const existing = result.get(identity.pid);
    if (existing !== undefined && existing.processStartTicks !== identity.processStartTicks) throw new Error("Process identity changed during capture.");
    result.set(identity.pid, identity);
  }
  return [...result.values()];
}

async function terminateExactProcesses(identities: readonly BrowserProcessIdentity[]): Promise<void> {
  for (const identity of identities) await signalExactIdentity(identity, "SIGTERM");
  await waitForExactProcesses(identities, 2_000);
  for (const identity of identities) await signalExactIdentity(identity, "SIGKILL");
  await waitForExactProcesses(identities, 1_000);
  for (const identity of identities) {
    const state = await exactIdentityState(identity);
    if (state === "alive" || state === "unknown") throw new Error("Browser descendant did not settle.");
  }
}

async function signalExactIdentity(identity: BrowserProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  if (await exactIdentityState(identity) !== "alive") return;
  if (await readProcessStartTicks(identity.pid) !== identity.processStartTicks) return;
  try { process.kill(identity.pid, signal); } catch (error) { if (!isMissingProcessError(error)) throw error; }
}

async function waitForExactProcesses(identities: readonly BrowserProcessIdentity[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(identities.map(async (identity) => await exactIdentityState(identity)));
    if (states.every((state) => state !== "alive" && state !== "unknown")) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function settledSessionMembers(sessionId: number): Promise<BrowserProcessIdentity[]> {
  for (let scan = 0; scan < 2; scan++) {
    const members = await processSessionMembers(sessionId);
    if (members.length > 0) return members;
    if (scan === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return [];
}

async function processSessionMembers(sessionId: number): Promise<BrowserProcessIdentity[]> {
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Invalid process session.");
  const result: BrowserProcessIdentity[] = [];
  let observed = 0;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    observed++;
    if (observed > 65_536) throw new Error("Process table is too large.");
    const pid = Number(entry.name);
    try {
      if (!await processOwnedByCurrentUser(pid)) continue;
      const record = parseHostProcessRecord(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
      if (record.sessionId === sessionId) result.push({ pid, processStartTicks: record.processStartTicks });
    } catch (error) { if (!isMissingProcessError(error)) throw error; }
  }
  return result;
}

async function profileUsingProcesses(profileDirectory: string): Promise<BrowserProcessIdentity[]> {
  const argument = `--user-data-dir=${profileDirectory}`;
  const result: BrowserProcessIdentity[] = [];
  let observed = 0;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    observed++;
    if (observed > 65_536) throw new Error("Process table is too large.");
    const pid = Number(entry.name);
    try {
      if (!await processOwnedByCurrentUser(pid)) continue;
      const before = await readProcessStartTicks(pid);
      const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean);
      const after = await readProcessStartTicks(pid);
      if (before === after && commandLine.includes(argument)) result.push({ pid, processStartTicks: before });
    } catch (error) { if (!isMissingProcessError(error)) throw error; }
  }
  return result;
}

async function processOwnedByCurrentUser(pid: number): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const match = /^Uid:\s+([0-9]+)\s+/mu.exec(await readFile(`/proc/${pid}/status`, "utf8"));
  return match?.[1] !== undefined && Number(match[1]) === uid;
}

type ExactProcessState = "alive" | "gone" | "identity-changed" | "unknown";

export function closedProfileRemovalSafe(value: {
  readonly processTreeObserved: boolean;
  readonly finalIdentity: ExactProcessState;
  readonly descendantStates: readonly ExactProcessState[] | undefined;
  readonly profileUsers: readonly BrowserProcessIdentity[] | undefined;
  readonly sessionMembers: readonly BrowserProcessIdentity[] | undefined;
}): boolean {
  return value.processTreeObserved
    && value.finalIdentity === "gone"
    && value.descendantStates !== undefined
    && value.descendantStates.every((state) => state === "gone")
    && value.profileUsers !== undefined
    && value.profileUsers.length === 0
    && value.sessionMembers !== undefined
    && value.sessionMembers.length === 0;
}

async function exactIdentityState(identity: BrowserProcessIdentity): Promise<ExactProcessState> {
  try { return await readProcessStartTicks(identity.pid) === identity.processStartTicks ? "alive" : "identity-changed"; }
  catch (error) { return isMissingProcessError(error) ? "gone" : "unknown"; }
}

function isRunning(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return;
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))]);
}
function isMissingProcessError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ESRCH"); }
async function sleep(ms: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); await new Promise<void>((resolvePromise, reject) => { const abort = (): void => { cleanup(); reject(signal?.reason); }; const timer = setTimeout(() => { cleanup(); resolvePromise(); }, ms); const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); }
