import { EventEmitter } from "node:events";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserProtocolError } from "@webx/browser-protocol";

export const MIB = 1024 * 1024;

export interface BrowserProcessIdentity {
  readonly pid: number;
  readonly processStartTicks: string;
}

export interface BrowserResourceLimits {
  readonly perSessionSoftPssBytes: number;
  readonly perSessionHardPssBytes: number;
  readonly globalChromePssBytes: number;
  readonly profileSoftBytes: number;
  readonly profileHardBytes: number;
  readonly samplingIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly emergencyTimeoutMs: number;
}

export const DEFAULT_BROWSER_RESOURCE_LIMITS: BrowserResourceLimits = Object.freeze({
  perSessionSoftPssBytes: 1024 * MIB,
  perSessionHardPssBytes: 1280 * MIB,
  globalChromePssBytes: 4096 * MIB,
  profileSoftBytes: 512 * MIB,
  profileHardBytes: 1024 * MIB,
  samplingIntervalMs: 5_000,
  drainTimeoutMs: 30_000,
  emergencyTimeoutMs: 15_000,
});

export type BrowserResourceState = "normal" | "warning" | "draining" | "resource-limited" | "closing" | "closed";
export type BrowserResourceReason = "none" | "session-memory" | "profile-storage" | "global-memory" | "sampling-unavailable";

export interface BrowserResourceStatus {
  readonly state: BrowserResourceState;
  readonly reason: BrowserResourceReason;
}

export interface BrowserResourceSummary {
  readonly state: "normal" | "warning" | "resource-limited";
  readonly supervisedSessions: number;
  readonly warningSessions: number;
  readonly limitedSessions: number;
  readonly terminalLimitEvents: number;
  readonly lastTerminalReason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable"> | "none";
}

export interface BrowserResourceSample {
  readonly pssBytes: number;
  readonly privateDirtyBytes: number;
  readonly profileBytes: number;
  readonly processCount: number;
  readonly rendererCount: number;
}

export interface BrowserResourceSampler {
  sample(identity: BrowserProcessIdentity, profileDirectory: string): Promise<BrowserResourceSample>;
}

export interface BrowserResourceSessionHooks {
  readonly browserSessionId: string;
  readonly processIdentity: BrowserProcessIdentity;
  readonly profileDirectory: string;
  controlState(): "agent" | "takeover-pending" | "human" | "human-disconnected" | "return-pending";
  hasRunningWork(): boolean;
  fence(reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): void;
  cancelOperations(): void;
  awaitOperationSettlement(signal: AbortSignal): Promise<void>;
  returnHumanControl(signal: AbortSignal): Promise<void>;
  close(reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void>;
  changed(status: BrowserResourceStatus): void;
}

export interface BrowserResourceSupervisorOptions {
  readonly sampler?: BrowserResourceSampler;
  readonly autoStart?: boolean;
  readonly maxTerminalEvents?: number;
}

interface CloseAttempt {
  readonly promise: Promise<void>;
  settled: boolean;
  succeeded: boolean;
}

interface SessionRecord {
  readonly hooks: BrowserResourceSessionHooks;
  readonly sequence: number;
  status: BrowserResourceStatus;
  sample: BrowserResourceSample | undefined;
  drainPromise: Promise<void> | undefined;
  closeAttempt: CloseAttempt | undefined;
}

interface TerminalEvent {
  readonly reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">;
}

export class BrowserResourceSupervisor extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly terminalEvents: TerminalEvent[] = [];
  private readonly sampler: BrowserResourceSampler;
  private readonly maxTerminalEvents: number;
  private nextSequence = 0;
  private timer: NodeJS.Timeout | undefined;
  private sampleTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly limits: BrowserResourceLimits = DEFAULT_BROWSER_RESOURCE_LIMITS, options: BrowserResourceSupervisorOptions = {}) {
    super();
    validateBrowserResourceLimits(limits);
    this.sampler = options.sampler ?? new ProcfsBrowserResourceSampler();
    this.maxTerminalEvents = boundedInteger(options.maxTerminalEvents ?? 64, 1, 256, "terminal event limit");
    if (options.autoStart !== false) this.start();
  }

  start(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.sampleNow(); }, this.limits.samplingIntervalMs);
    this.timer.unref?.();
  }

  register(hooks: BrowserResourceSessionHooks): void {
    if (this.closed) throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Browser resource supervision is closed.", true);
    if (this.sessions.has(hooks.browserSessionId)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Browser resource session is already supervised.");
    const record: SessionRecord = { hooks, sequence: this.nextSequence++, status: { state: "normal", reason: "none" }, sample: undefined, drainPromise: undefined, closeAttempt: undefined };
    this.sessions.set(hooks.browserSessionId, record);
    hooks.changed(record.status);
  }

  unregister(browserSessionId: string): void {
    const record = this.sessions.get(browserSessionId);
    if (record === undefined) return;
    this.sessions.delete(browserSessionId);
  }

  status(browserSessionId: string): BrowserResourceStatus {
    return this.sessions.get(browserSessionId)?.status ?? { state: "closed", reason: "none" };
  }

  summary(): BrowserResourceSummary {
    let warningSessions = 0;
    let limitedSessions = 0;
    for (const record of this.sessions.values()) {
      if (record.status.state === "warning") warningSessions++;
      if (record.status.state === "draining" || record.status.state === "resource-limited" || record.status.state === "closing") limitedSessions++;
    }
    const last = this.terminalEvents.at(-1)?.reason ?? "none";
    return {
      state: limitedSessions > 0 ? "resource-limited" : warningSessions > 0 ? "warning" : "normal",
      supervisedSessions: this.sessions.size,
      warningSessions,
      limitedSessions,
      terminalLimitEvents: this.terminalEvents.length,
      lastTerminalReason: last,
    };
  }

  assertAdmission(browserSessionId: string): void {
    const record = this.sessions.get(browserSessionId);
    if (record === undefined) return;
    if (record.status.state === "draining" || record.status.state === "resource-limited" || record.status.state === "closing" || record.status.state === "closed") {
      throw resourceLimitError(record.status.reason);
    }
  }

  sampleNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const prior = this.sampleTail;
    const next = prior.catch(() => undefined).then(async () => await this.sampleAndEnforce());
    this.sampleTail = next;
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.sampleTail.catch(() => undefined);
    this.sessions.clear();
  }

  private async sampleAndEnforce(): Promise<void> {
    for (const record of [...this.sessions.values()]) {
      if (record.status.state === "resource-limited" && isHardReason(record.status.reason)) {
        await this.closeLimitedRecord(record, record.status.reason);
        continue;
      }
      if (!isSampleable(record.status.state)) continue;
      try {
        record.sample = await this.sampler.sample(record.hooks.processIdentity, record.hooks.profileDirectory);
      } catch {
        record.sample = undefined;
        this.setStatus(record, { state: "warning", reason: "sampling-unavailable" });
        continue;
      }
      if (record.sample.pssBytes >= this.limits.perSessionHardPssBytes) {
        await this.beginDrain(record, "session-memory");
        continue;
      }
      if (record.sample.profileBytes >= this.limits.profileHardBytes) {
        await this.beginDrain(record, "profile-storage");
        continue;
      }
      if (record.sample.pssBytes >= this.limits.perSessionSoftPssBytes) this.setStatus(record, { state: "warning", reason: "session-memory" });
      else if (record.sample.profileBytes >= this.limits.profileSoftBytes) this.setStatus(record, { state: "warning", reason: "profile-storage" });
      else this.setStatus(record, { state: "normal", reason: "none" });
    }

    while (this.globalPssBytes() > this.limits.globalChromePssBytes) {
      const victim = this.globalVictims()[0];
      if (victim === undefined) break;
      await this.beginDrain(victim, "global-memory");
      await this.resampleOpenSessions();
    }
  }

  private async resampleOpenSessions(): Promise<void> {
    for (const record of this.sessions.values()) {
      if (!isSampleable(record.status.state)) continue;
      try { record.sample = await this.sampler.sample(record.hooks.processIdentity, record.hooks.profileDirectory); }
      catch { record.sample = undefined; this.setStatus(record, { state: "warning", reason: "sampling-unavailable" }); }
    }
  }

  private globalPssBytes(): number {
    let total = 0;
    for (const record of this.sessions.values()) {
      if (!isSampleable(record.status.state) || record.sample === undefined) continue;
      total = safeAdd(total, record.sample.pssBytes);
    }
    return total;
  }

  private globalVictims(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((record) => isSampleable(record.status.state) && record.sample !== undefined)
      .sort((left, right) => victimRank(left) - victimRank(right) || left.sequence - right.sequence);
  }

  private async beginDrain(record: SessionRecord, reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void> {
    if (record.drainPromise !== undefined) return await record.drainPromise;
    if (!isSampleable(record.status.state)) return;
    this.setStatus(record, { state: "draining", reason });
    record.hooks.fence(reason);
    record.hooks.cancelOperations();
    const promise = this.drain(record, reason);
    record.drainPromise = promise;
    try { await promise; }
    finally { if (record.drainPromise === promise) record.drainPromise = undefined; }
  }

  private async drain(record: SessionRecord, reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void> {
    try {
      await withBudget(this.limits.drainTimeoutMs, async (signal) => {
        await record.hooks.awaitOperationSettlement(signal);
        signal.throwIfAborted();
        await record.hooks.returnHumanControl(signal);
      });
    } catch {
      // Admission remains fenced. Exact session cleanup is the safe terminal boundary.
    }
    this.setStatus(record, { state: "resource-limited", reason });
    await this.closeLimitedRecord(record, reason);
  }

  private async closeLimitedRecord(record: SessionRecord, reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void> {
    this.setStatus(record, { state: "closing", reason });
    let attempt = record.closeAttempt;
    if (attempt === undefined || (attempt.settled && !attempt.succeeded)) {
      attempt = { promise: Promise.resolve().then(async () => await record.hooks.close(reason)), settled: false, succeeded: false };
      record.closeAttempt = attempt;
      const created = attempt;
      void created.promise.then(() => { created.settled = true; created.succeeded = true; }, () => { created.settled = true; });
    }
    const activeAttempt = attempt;
    try { await withBudget(this.limits.emergencyTimeoutMs, async (signal) => await abortable(activeAttempt.promise, signal)); }
    catch {
      if (activeAttempt.settled && !activeAttempt.succeeded && record.closeAttempt === activeAttempt) record.closeAttempt = undefined;
      this.setStatus(record, { state: "resource-limited", reason });
      return;
    }
    this.setStatus(record, { state: "closed", reason });
    this.sessions.delete(record.hooks.browserSessionId);
    this.terminalEvents.push({ reason });
    while (this.terminalEvents.length > this.maxTerminalEvents) this.terminalEvents.shift();
    this.emit("terminal", { browserSessionId: record.hooks.browserSessionId, reason });
  }

  private setStatus(record: SessionRecord, status: BrowserResourceStatus): void {
    if (record.status.state === status.state && record.status.reason === status.reason) return;
    record.status = status;
    record.hooks.changed(status);
    this.emit("changed", { browserSessionId: record.hooks.browserSessionId, status });
  }
}

export interface ProcfsBrowserResourceSamplerOptions {
  readonly procRoot?: string;
  readonly maxProcesses?: number;
  readonly maxProfileEntries?: number;
}

interface ProcessRecord extends BrowserProcessIdentity { readonly parentPid: number }

export class ProcfsBrowserResourceSampler implements BrowserResourceSampler {
  private readonly procRoot: string;
  private readonly maxProcesses: number;
  private readonly maxProfileEntries: number;

  constructor(options: ProcfsBrowserResourceSamplerOptions = {}) {
    this.procRoot = options.procRoot ?? "/proc";
    this.maxProcesses = boundedInteger(options.maxProcesses ?? 16_384, 1, 65_536, "process scan limit");
    this.maxProfileEntries = boundedInteger(options.maxProfileEntries ?? 200_000, 1, 1_000_000, "profile scan limit");
  }

  async sample(identity: BrowserProcessIdentity, profileDirectory: string): Promise<BrowserResourceSample> {
    assertProcessIdentity(identity);
    const rootBefore = await this.readProcess(identity.pid);
    if (rootBefore.processStartTicks !== identity.processStartTicks) throw new Error("Browser process identity changed.");
    const processes = await this.readProcessTable();
    const descendants = descendantProcesses(identity.pid, processes, this.maxProcesses);
    if (!descendants.some((item) => item.pid === identity.pid && item.processStartTicks === identity.processStartTicks)) throw new Error("Browser process identity is unavailable.");
    let pssBytes = 0;
    let privateDirtyBytes = 0;
    let rendererCount = 0;
    for (const process of descendants) {
      const before = await this.readProcess(process.pid);
      if (before.processStartTicks !== process.processStartTicks) throw new Error("Browser process tree changed during sampling.");
      const memory = parseSmapsRollup(await readFile(join(this.procRoot, String(process.pid), "smaps_rollup"), "utf8"));
      const commandLine = await readFile(join(this.procRoot, String(process.pid), "cmdline")).catch(() => Buffer.alloc(0));
      const after = await this.readProcess(process.pid);
      if (after.processStartTicks !== process.processStartTicks) throw new Error("Browser process tree changed during sampling.");
      pssBytes = safeAdd(pssBytes, memory.pssBytes);
      privateDirtyBytes = safeAdd(privateDirtyBytes, memory.privateDirtyBytes);
      if (commandLine.toString("utf8").split("\0").includes("--type=renderer")) rendererCount++;
    }
    const profileBytes = await profileTreeBytes(profileDirectory, this.maxProfileEntries);
    const rootAfter = await this.readProcess(identity.pid);
    if (rootAfter.processStartTicks !== identity.processStartTicks) throw new Error("Browser process identity changed.");
    return { pssBytes, privateDirtyBytes, profileBytes, processCount: descendants.length, rendererCount };
  }

  private async readProcessTable(): Promise<ProcessRecord[]> {
    const result: ProcessRecord[] = [];
    for (const entry of await readdir(this.procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
      if (result.length >= this.maxProcesses) throw new Error("Process scan limit reached.");
      const pid = Number(entry.name);
      try { result.push(await this.readProcess(pid)); } catch { /* Process settled during enumeration. */ }
    }
    return result;
  }

  private async readProcess(pid: number): Promise<ProcessRecord> {
    return parseProcessStat(pid, await readFile(join(this.procRoot, String(pid), "stat"), "utf8"));
  }
}

export function parseProcessStat(pid: number, text: string): ProcessRecord {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process identity.");
  const end = text.lastIndexOf(")");
  if (end < 2) throw new Error("Invalid process stat.");
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const parentPid = Number(fields[1]);
  const processStartTicks = fields[19];
  if (!Number.isInteger(parentPid) || parentPid < 0 || processStartTicks === undefined || !/^[0-9]+$/u.test(processStartTicks)) throw new Error("Invalid process stat.");
  return { pid, parentPid, processStartTicks };
}

export function parseSmapsRollup(text: string): { pssBytes: number; privateDirtyBytes: number } {
  const pssKiB = numericKiB(text, "Pss");
  const privateDirtyKiB = numericKiB(text, "Private_Dirty");
  return { pssBytes: kibToBytes(pssKiB), privateDirtyBytes: kibToBytes(privateDirtyKiB) };
}

export async function profileTreeBytes(root: string, maxEntries = 200_000): Promise<number> {
  boundedInteger(maxEntries, 1, 1_000_000, "profile scan limit");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Profile root is unavailable.");
  const stack = [root];
  let entries = 0;
  let total = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory)) {
      entries++;
      if (entries > maxEntries) throw new Error("Profile scan limit reached.");
      const path = join(directory, entry);
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) stack.push(path);
      else if (info.isFile()) total = safeAdd(total, info.size);
    }
  }
  return total;
}

export function validateBrowserResourceLimits(limits: BrowserResourceLimits): void {
  boundedInteger(limits.perSessionSoftPssBytes, 128 * MIB, 8 * 1024 * MIB, "per-session soft PSS limit");
  boundedInteger(limits.perSessionHardPssBytes, 256 * MIB, 16 * 1024 * MIB, "per-session hard PSS limit");
  boundedInteger(limits.globalChromePssBytes, 512 * MIB, 32 * 1024 * MIB, "global Chrome PSS limit");
  boundedInteger(limits.profileSoftBytes, 64 * MIB, 4 * 1024 * MIB, "profile soft limit");
  boundedInteger(limits.profileHardBytes, 128 * MIB, 8 * 1024 * MIB, "profile hard limit");
  boundedInteger(limits.samplingIntervalMs, 1_000, 60_000, "sampling interval");
  boundedInteger(limits.drainTimeoutMs, 1_000, 120_000, "drain timeout");
  boundedInteger(limits.emergencyTimeoutMs, 1_000, 60_000, "emergency timeout");
  if (limits.perSessionSoftPssBytes >= limits.perSessionHardPssBytes) throw new Error("per-session PSS limits must satisfy soft < hard");
  if (limits.profileSoftBytes >= limits.profileHardBytes) throw new Error("profile limits must satisfy soft < hard");
  if (limits.globalChromePssBytes < limits.perSessionHardPssBytes) throw new Error("global Chrome PSS limit must not be below the per-session hard limit");
  if (limits.emergencyTimeoutMs > limits.drainTimeoutMs) throw new Error("emergency timeout must not exceed drain timeout");
}

function descendantProcesses(rootPid: number, processes: readonly ProcessRecord[], maximum: number): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const process of processes) {
    const values = byParent.get(process.parentPid) ?? [];
    values.push(process);
    byParent.set(process.parentPid, values);
  }
  const root = processes.find((process) => process.pid === rootPid);
  if (root === undefined) return [];
  const result = [root];
  const seen = new Set([root.pid]);
  for (let index = 0; index < result.length; index++) {
    for (const child of byParent.get(result[index]?.pid ?? -1) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      if (result.length > maximum) throw new Error("Browser process tree limit reached.");
    }
  }
  return result;
}

function victimRank(record: SessionRecord): number {
  const control = record.hooks.controlState();
  if (control === "human" || control === "human-disconnected" || control === "takeover-pending" || control === "return-pending") return 2;
  return record.hooks.hasRunningWork() ? 1 : 0;
}

function isSampleable(state: BrowserResourceState): boolean { return state === "normal" || state === "warning"; }
function isHardReason(reason: BrowserResourceReason): reason is Exclude<BrowserResourceReason, "none" | "sampling-unavailable"> { return reason === "session-memory" || reason === "profile-storage" || reason === "global-memory"; }

function resourceLimitError(reason: BrowserResourceReason): BrowserProtocolError {
  const boundedReason = reason === "profile-storage" ? "profile-storage" : reason === "global-memory" ? "global-memory" : "session-memory";
  return new BrowserProtocolError("BROWSER_RESOURCE_LIMIT", "Browser session reached a resource limit.", false, { reason: boundedReason });
}

function assertProcessIdentity(identity: BrowserProcessIdentity): void {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !/^[0-9]+$/u.test(identity.processStartTicks)) throw new Error("Invalid browser process identity.");
}

function numericKiB(text: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s+kB$`, "mu").exec(text);
  if (match?.[1] === undefined) throw new Error("Invalid process memory sample.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid process memory sample.");
  return value;
}

function kibToBytes(value: number): number {
  const bytes = value * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error("Process memory sample is too large.");
  return bytes;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Resource accounting overflowed.");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

async function withBudget<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserProtocolError("BROWSER_RESOURCE_LIMIT", "Browser resource cleanup reached its bounded deadline.", false);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([task(controller.signal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
