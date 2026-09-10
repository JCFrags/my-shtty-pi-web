import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AGENT_SOCKETS_DIR, BROWSER_OWNER_ENV } from "pixel-store";
import type { BrowserOwner } from "pixel-store";

export const STARTUP_ATTEMPT_ENV = "TERMINAL_BROWSER_STARTUP_ATTEMPT";
export const STARTUP_REPORT_LIMIT = 16 * 1024;
const ATTEMPT_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface StartupReport {
  version: 1;
  attempt: string;
  state: "failed";
  code: string;
  message: string;
  pane: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  doctorCommand: "terminal-browser doctor --json";
  cleanup: {
    status: "not-attempted" | "exited" | "retained" | "failed";
    nextStep: string;
    error?: string;
  };
}

export interface StartupAttempt {
  attempt: string;
  file: string;
}

function reportPath(attempt: string): string {
  if (!ATTEMPT_PATTERN.test(attempt)) throw new Error("invalid browser startup attempt");
  return path.join(AGENT_SOCKETS_DIR, `startup-${attempt}.json`);
}

function panePath(file: string): string {
  return `${file}.pane`;
}

function failurePath(file: string): string {
  return `${file}.failure`;
}

function readPrivateFile(file: string, limit: number): string | null {
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() ||
      (before.mode & 0o077) || before.size > limit) return null;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== process.getuid?.() || (opened.mode & 0o077) ||
      opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    return fs.readFileSync(descriptor, "utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function createStartupAttempt(owner?: BrowserOwner): StartupAttempt {
  fs.mkdirSync(AGENT_SOCKETS_DIR, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(AGENT_SOCKETS_DIR);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) {
    throw new Error("browser startup channel directory is not private");
  }
  const attempt = randomUUID();
  const file = reportPath(attempt);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    attempt,
    state: "pending",
    owner: owner ? {
      workspaceId: owner.workspaceId,
      tabId: owner.tabId,
      paneId: owner.paneId,
    } : null,
  }), { flag: "wx", mode: 0o600 });
  return { attempt, file };
}

export function bindStartupPane(startup: StartupAttempt, pane: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(pane)) throw new Error("invalid browser startup pane");
  const current = readPrivateFile(startup.file, STARTUP_REPORT_LIMIT);
  if (!current) throw new Error("invalid browser startup channel");
  const pending = JSON.parse(current) as Record<string, unknown>;
  if (pending.attempt !== startup.attempt || pending.state !== "pending") throw new Error("invalid browser startup channel");
  try {
    fs.writeFileSync(panePath(startup.file), JSON.stringify({ attempt: startup.attempt, pane }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    const existing = readPrivateFile(panePath(startup.file), 1024);
    if (!existing || (JSON.parse(existing) as { attempt?: unknown; pane?: unknown }).attempt !== startup.attempt ||
      (JSON.parse(existing) as { pane?: unknown }).pane !== pane) throw error;
  }
}

export function removeStartupAttempt(startup: StartupAttempt): void {
  for (const file of [startup.file, panePath(startup.file), failurePath(startup.file)]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

export function startupEnvironment(startup: StartupAttempt): NodeJS.ProcessEnv {
  return { [STARTUP_ATTEMPT_ENV]: startup.attempt };
}

export function startupAttempt(environment: NodeJS.ProcessEnv = process.env): string | null {
  const value = environment[STARTUP_ATTEMPT_ENV];
  return value && ATTEMPT_PATTERN.test(value) ? value : null;
}

function boundedMessage(value: string, limit = 8192): string {
  const normalized = value.trim() || "browser startup failed";
  return Buffer.byteLength(normalized) <= limit
    ? normalized
    : Buffer.from(normalized).subarray(0, limit).toString("utf8").replace(/\uFFFD+$/u, "");
}

export function startupErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error);
  if (/profile ownership/iu.test(message)) return "PROFILE_OWNERSHIP_UNCERTAIN";
  if (/existing daemon|daemon socket/iu.test(message)) return "DAEMON_OWNERSHIP_UNCERTAIN";
  if (/runtime mismatch/iu.test(message)) return "DAEMON_RUNTIME_MISMATCH";
  if (/daemon.*timed out|daemon did not start/iu.test(message)) return "DAEMON_START_TIMEOUT";
  if (/daemon/iu.test(message)) return "DAEMON_START_FAILED";
  return "BROWSER_START_FAILED";
}

export function writeStartupFailure(error: unknown, details: {
  pane?: string | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
} = {}, environment: NodeJS.ProcessEnv = process.env): StartupReport | null {
  const attempt = startupAttempt(environment);
  if (!attempt) return null;
  const file = reportPath(attempt);
  const processFailure = error as { exitCode?: unknown; signal?: unknown };
  const inferredExit = Number.isInteger(processFailure?.exitCode) && Number(processFailure.exitCode) >= 0 && Number(processFailure.exitCode) <= 255
    ? Number(processFailure.exitCode)
    : 1;
  const inferredSignal = typeof processFailure?.signal === "string" && processFailure.signal.startsWith("SIG")
    ? processFailure.signal as NodeJS.Signals
    : null;
  const report: StartupReport = {
    version: 1,
    attempt,
    state: "failed",
    code: startupErrorCode(error),
    message: boundedMessage(error instanceof Error ? error.message : String(error)),
    pane: details.pane !== undefined ? details.pane : environment.HERDR_PANE_ID ?? null,
    exitCode: details.exitCode !== undefined ? details.exitCode : inferredSignal ? null : inferredExit,
    signal: details.signal !== undefined ? details.signal : inferredSignal,
    doctorCommand: "terminal-browser doctor --json",
    cleanup: {
      status: "not-attempted",
      nextStep: "Inspect the reported pane and run terminal-browser doctor --json before explicit recovery.",
    },
  };
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded) > STARTUP_REPORT_LIMIT) return null;
  try {
    const current = readPrivateFile(file, STARTUP_REPORT_LIMIT);
    if (!current) return null;
    const pending = JSON.parse(current) as {
      attempt?: unknown;
      state?: unknown;
      owner?: { workspaceId?: unknown; tabId?: unknown; paneId?: unknown } | null;
    };
    if (pending.attempt !== attempt || pending.state !== "pending") return null;
    if (pending.owner && (pending.owner.workspaceId !== environment[BROWSER_OWNER_ENV.workspaceId] ||
      pending.owner.tabId !== environment[BROWSER_OWNER_ENV.tabId] ||
      pending.owner.paneId !== environment[BROWSER_OWNER_ENV.paneId])) return null;
    const binding = readPrivateFile(panePath(file), 1024);
    if (binding) {
      const bound = JSON.parse(binding) as { attempt?: unknown; pane?: unknown };
      if (bound.attempt !== attempt || bound.pane !== (details.pane ?? environment.HERDR_PANE_ID)) return null;
    }
    fs.writeFileSync(failurePath(file), encoded, { flag: "wx", mode: 0o600 });
    return report;
  } catch {
    return null;
  }
}

export function readStartupFailure(startup: StartupAttempt, expectedPane?: string | null): StartupReport | null {
  try {
    const encoded = readPrivateFile(failurePath(startup.file), STARTUP_REPORT_LIMIT);
    if (!encoded) return null;
    const value = JSON.parse(encoded) as StartupReport;
    if (value.version !== 1 || value.attempt !== startup.attempt || value.state !== "failed" ||
      typeof value.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value.code) ||
      typeof value.message !== "string" || Buffer.byteLength(value.message) > 8192 ||
      (value.pane !== null && (typeof value.pane !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.pane))) ||
      (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) ||
      (value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(value.signal))) ||
      value.doctorCommand !== "terminal-browser doctor --json" ||
      !value.cleanup || !["not-attempted", "exited", "retained", "failed"].includes(value.cleanup.status) ||
      typeof value.cleanup.nextStep !== "string" || Buffer.byteLength(value.cleanup.nextStep) > 4096 ||
      (value.cleanup.error !== undefined && (typeof value.cleanup.error !== "string" || Buffer.byteLength(value.cleanup.error) > 4096))) return null;
    if (expectedPane && value.pane !== null && value.pane !== expectedPane) {
      return {
        version: 1,
        attempt: startup.attempt,
        state: "failed",
        code: "STARTUP_CORRELATION_FAILED",
        message: "startup report pane did not match the launched pane",
        pane: expectedPane,
        exitCode: null,
        signal: null,
        doctorCommand: "terminal-browser doctor --json",
        cleanup: {
          status: "retained",
          nextStep: `Inspect pane ${expectedPane} and run terminal-browser doctor --json before explicit recovery.`,
        },
      };
    }
    return value;
  } catch {
    return null;
  }
}

interface StartupWaitOptions<T> {
  startup: StartupAttempt;
  pane: string | null;
  timeoutMs: number;
  timeoutMessage: string;
  findReady(attempt: string): Promise<T | null>;
  paneStatus?(pane: string): Promise<"present" | "absent" | "unknown">;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  cleanupWaitMs?: number;
}

export async function waitForStartup<T>(options: StartupWaitOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  while (now() < deadline) {
    const failure = readStartupFailure(options.startup, options.pane);
    if (failure) {
      failure.pane ??= options.pane;
      let paneState: "present" | "absent" | "unknown" = "unknown";
      let cleanupError: string | null = null;
      if (failure.pane && options.paneStatus) {
        const cleanupDeadline = now() + (options.cleanupWaitMs ?? 750);
        do {
          try {
            paneState = await options.paneStatus(failure.pane);
          } catch (error) {
            cleanupError = boundedMessage(error instanceof Error ? error.message : String(error), 4096);
            break;
          }
          if (paneState !== "present") break;
          await wait(50);
        } while (now() < cleanupDeadline);
      }
      failure.cleanup = cleanupError ? {
        status: "failed",
        nextStep: `Pane state could not be confirmed. Inspect${failure.pane ? ` pane ${failure.pane}` : " the launched pane"} and run terminal-browser doctor --json before explicit recovery.`,
        error: cleanupError,
      } : paneState === "absent" ? {
        status: "exited",
        nextStep: "Run terminal-browser doctor --json before explicit recovery.",
      } : {
        status: "retained",
        nextStep: `Inspect${failure.pane ? ` pane ${failure.pane}` : " the launched pane"} and run terminal-browser doctor --json before explicit recovery.`,
      };
      throw startupFailureError(failure);
    }
    const ready = await options.findReady(options.startup.attempt);
    if (ready) return ready;
    await wait(options.pollIntervalMs ?? 250);
  }
  throw startupFailureError({
    version: 1,
    attempt: options.startup.attempt,
    state: "failed",
    code: "BROWSER_START_TIMEOUT",
    message: options.timeoutMessage,
    pane: options.pane,
    exitCode: null,
    signal: null,
    doctorCommand: "terminal-browser doctor --json",
    cleanup: {
      status: "retained",
      nextStep: `The launch may complete late. Inspect${options.pane ? ` pane ${options.pane}` : " the launched pane"} and run terminal-browser doctor --json before explicit recovery.`,
    },
  });
}

interface SpawnedDaemonWaitOptions<T> {
  connect(): Promise<T>;
  failure(): Error | null;
  timeoutMs: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function waitForSpawnedDaemon<T>(options: SpawnedDaemonWaitOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  while (now() < deadline) {
    try {
      return await options.connect();
    } catch {
      const failure = options.failure();
      if (failure) throw failure;
      await wait(200);
    }
  }
  const failure = options.failure();
  if (failure) throw failure;
  throw new Error(`daemon did not start before the ${Math.round(options.timeoutMs / 1000)} second deadline`);
}

export class StartupFailure extends Error {
  constructor(readonly report: StartupReport) {
    super(JSON.stringify(report));
    this.name = "StartupFailure";
  }
}

export function startupFailureError(report: StartupReport): StartupFailure {
  return new StartupFailure(report);
}
