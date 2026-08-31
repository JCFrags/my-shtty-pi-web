import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkspaceAtspi, type WorkspaceAtspiResult } from "./workspace-atspi.js";

export interface WorkspaceDiagnostic extends Record<string, unknown> {
  readonly kind: string;
  readonly recordedAt: string;
}

export class WorkspaceRoute {
  readonly binary: string;
  readonly root: string;
  readonly diagnosticsPath: string;
  readonly screenshots: Record<"agent-a" | "agent-b" | "empty" | "reconnecting" | "human-a" | "human-b" | "returned", string>;
  readonly atspi = new WorkspaceAtspi();
  process?: ChildProcess;
  startupStarted = 0;
  startupReadyMs = 0;
  private readonly stderr: string[] = [];

  constructor(binary: string, root: string) {
    this.binary = resolve(binary);
    this.root = root;
    this.diagnosticsPath = join(root, "phase3a-workspace-diagnostics.jsonl");
    this.screenshots = {
      "agent-a": join(root, "phase3a-workspace-agent-a.png"),
      "agent-b": join(root, "phase3a-workspace-agent-b.png"),
      empty: join(root, "phase3a-workspace-empty.png"),
      reconnecting: join(root, "phase3a-workspace-reconnecting.png"),
      "human-a": join(root, "phase3b-workspace-human-a.png"),
      "human-b": join(root, "phase3b-workspace-human-b.png"),
      returned: join(root, "phase3b-workspace-returned.png"),
    };
  }

  async start(browserSessionId?: string, tabId?: string): Promise<void> {
    if (this.process !== undefined) throw new Error("Tauri workspace is already running");
    const binary = await stat(this.binary);
    if (!binary.isFile() || (binary.mode & 0o100) === 0) throw new Error("Tauri workspace binary is not executable");
    this.startupStarted = performance.now();
    const args = [`--acceptance-output=${this.diagnosticsPath}`];
    if (browserSessionId !== undefined) args.push(`--select-session=${browserSessionId}`);
    if (tabId !== undefined) args.push(`--select-tab=${tabId}`);
    const child = spawn(this.binary, args, {
      env: workspaceEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.process = child;
    child.stderr?.on("data", (chunk) => {
      this.stderr.push(String(chunk).slice(0, 4_096));
      if (this.stderr.length > 100) this.stderr.shift();
    });
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = undefined;
      if (code !== 0 && signal !== "SIGTERM") this.stderr.push(`workspace exited unexpectedly: ${code ?? signal}`);
    });
    await this.waitForRecord((record) => record.kind === "frontendReady", 0, 20_000);
    this.startupReadyMs = performance.now() - this.startupStarted;
  }

  async launch(args: readonly string[]): Promise<number> {
    if (args.length > 4 || args.some((arg) => arg.length > 256)) throw new Error("secondary Tauri arguments exceed their test bound");
    return await new Promise<number>((resolveLaunch, rejectLaunch) => {
      const child = spawn(this.binary, [...args], { env: workspaceEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr?.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-4_096); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); rejectLaunch(new Error(`secondary workspace launch timed out: ${error}`)); }, 10_000);
      child.once("error", (cause) => { clearTimeout(timer); rejectLaunch(cause); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) rejectLaunch(new Error(`secondary workspace launch failed (${code ?? signal}): ${error}`));
        else resolveLaunch(code);
      });
    });
  }

  async waitForSessions(sessionIds: readonly string[], from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => {
      if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return false;
      const visible = new Set(record.sessions.filter(isRecord).map((session) => session.browserSessionId).filter((value): value is string => typeof value === "string"));
      return sessionIds.every((id) => visible.has(id));
    }, from, timeoutMs);
  }

  async waitForTab(browserSessionId: string, tabId: string, present: boolean, from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => {
      if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return false;
      const session = record.sessions.filter(isRecord).find((item) => item.browserSessionId === browserSessionId);
      if (session === undefined || !Array.isArray(session.tabs)) return !present;
      const found = session.tabs.filter(isRecord).some((tab) => tab.tabId === tabId && tab.state !== "closed");
      return found === present;
    }, from, timeoutMs);
  }

  async waitForSessionAbsent(sessionId: string, from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => record.kind === "snapshot" && Array.isArray(record.sessions) && !record.sessions.filter(isRecord).some((session) => session.browserSessionId === sessionId), from, timeoutMs);
  }

  async waitForCaptureReadiness(browserSessionId: string, tabId: string, state: "starting" | "warming" | "ready" | "degraded" | "unavailable", from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => {
      if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return false;
      const session = record.sessions.filter(isRecord).find((item) => item.browserSessionId === browserSessionId);
      if (session === undefined || !Array.isArray(session.tabs)) return false;
      const tab = session.tabs.filter(isRecord).find((item) => item.tabId === tabId);
      return session.captureReadiness === state && tab?.captureReadiness === state;
    }, from, timeoutMs);
  }

  async waitForCaptureReadinessTransition(browserSessionId: string, tabId: string, from = 0, timeoutMs = 20_000): Promise<{ warming: WorkspaceDiagnostic; ready: WorkspaceDiagnostic; elapsedMs: number }> {
    await this.waitForRecord((record) => tabCaptureReadiness(record, browserSessionId, tabId) === "ready", from, timeoutMs);
    const records = (await this.records()).slice(from);
    const warmingIndex = records.findIndex((record) => tabCaptureReadiness(record, browserSessionId, tabId) === "warming");
    const readyIndex = records.findIndex((record, index) => index > warmingIndex && tabCaptureReadiness(record, browserSessionId, tabId) === "ready");
    const warming = records[warmingIndex];
    const ready = records[readyIndex];
    if (warmingIndex < 0 || readyIndex <= warmingIndex || warming === undefined || ready === undefined) throw new Error("capture readiness did not transition from warming to ready in order");
    return { warming, ready, elapsedMs: Math.max(0, Date.parse(ready.recordedAt) - Date.parse(warming.recordedAt)) };
  }

  async waitForSelection(browserSessionId: string, tabId: string, from = 0, timeoutMs = 15_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => record.kind === "selection" && record.browserSessionId === browserSessionId && record.tabId === tabId, from, timeoutMs);
  }

  async waitForPaint(browserSessionId: string, tabId: string, selectionId: unknown, from = 0, timeoutMs = 15_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => record.kind === "frameSettled" && record.outcome === "painted" && record.browserSessionId === browserSessionId && record.tabId === tabId && record.selectionId === selectionId, from, timeoutMs);
  }

  async waitForControlState(browserSessionId: string, state: "agent" | "takeover-pending" | "human" | "human-disconnected" | "return-pending", from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => {
      if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return false;
      const session = record.sessions.filter(isRecord).find((item) => item.browserSessionId === browserSessionId);
      return session?.controlState === state;
    }, from, timeoutMs);
  }

  async waitForTakeoverOutcome(browserSessionId: string, from = 0, timeoutMs = 8_000): Promise<{ kind: "human"; record: WorkspaceDiagnostic } | { kind: "error"; record: WorkspaceDiagnostic; code: string }> {
    const record = await this.waitForRecord((candidate) => {
      if (candidate.kind === "launcherError" && typeof candidate.code === "string") return true;
      if (candidate.kind !== "snapshot" || !Array.isArray(candidate.sessions)) return false;
      return candidate.sessions.filter(isRecord).some((session) => session.browserSessionId === browserSessionId && session.controlState === "human");
    }, from, timeoutMs);
    if (record.kind === "launcherError") return { kind: "error", record, code: String(record.code) };
    return { kind: "human", record };
  }

  async assertNoControlState(browserSessionId: string, state: "human", from: number, dwellMs = 1_000): Promise<void> {
    await sleep(dwellMs);
    const records = (await this.records()).slice(from);
    assert.ok(!records.some((record) => record.kind === "snapshot" && Array.isArray(record.sessions) && record.sessions.filter(isRecord).some((session) => session.browserSessionId === browserSessionId && session.controlState === state)), "failed takeover acquired control later");
  }

  async takeControlViaUi(browserSessionId: string, tabId: string): Promise<{ record: WorkspaceDiagnostic; atspi: WorkspaceAtspiResult; attempts: number }> {
    const firstFrom = await this.index();
    const firstAtspi = await this.atspi.takeControl();
    try { return { record: await this.waitForControlState(browserSessionId, "human", firstFrom, 5_000), atspi: firstAtspi, attempts: 1 }; }
    catch {
      await this.assertNoControlState(browserSessionId, "human", firstFrom, 1_000);
      await this.waitForControlState(browserSessionId, "agent", firstFrom, 5_000);
      await this.select(browserSessionId, tabId);
      const retryFrom = await this.index();
      const retryAtspi = await this.atspi.takeControl();
      return { record: await this.waitForControlState(browserSessionId, "human", retryFrom), atspi: retryAtspi, attempts: 2 };
    }
  }

  async returnControlViaUi(browserSessionId: string): Promise<{ record: WorkspaceDiagnostic; atspi: WorkspaceAtspiResult }> {
    const from = await this.index();
    const atspi = await this.atspi.returnControl();
    return { record: await this.waitForControlState(browserSessionId, "agent", from), atspi };
  }

  async exerciseHumanInput(full = true): Promise<WorkspaceAtspiResult> {
    return full ? await this.atspi.exerciseInput() : await this.atspi.exercisePointer();
  }

  async holdHumanInput(): Promise<WorkspaceAtspiResult> { return await this.atspi.holdInput(); }

  async select(browserSessionId: string, tabId: string, paintTimeoutMs = 45_000): Promise<{ selection: WorkspaceDiagnostic; paint: WorkspaceDiagnostic; latencyMs: number; brokerLatencyMs: number; frameLatencyMs: number; launcherLatencyMs: number }> {
    const records = await this.records();
    const from = records.length;
    const started = performance.now();
    await this.launch(["--raise", `--select-session=${browserSessionId}`, `--select-tab=${tabId}`]);
    const requested = await this.waitForRecord((record) => record.kind === "selectionRequested" && record.browserSessionId === browserSessionId && record.tabId === tabId, from, 15_000);
    const selection = await this.waitForRecord((record) => record.kind === "selection" && record.browserSessionId === browserSessionId && record.tabId === tabId, from, 15_000);
    const paint = await this.waitForRecord((record) => record.kind === "frameSettled" && record.outcome === "painted" && record.browserSessionId === browserSessionId && record.tabId === tabId && record.selectionId === selection.selectionId, from, paintTimeoutMs);
    const requestedAt = Date.parse(requested.recordedAt);
    const selectedAt = Date.parse(selection.recordedAt);
    const paintedAt = Date.parse(paint.recordedAt);
    const latencyMs = paintedAt - requestedAt;
    const brokerLatencyMs = selectedAt - requestedAt;
    const frameLatencyMs = paintedAt - selectedAt;
    if (![latencyMs, brokerLatencyMs, frameLatencyMs].every((value) => Number.isFinite(value) && value >= 0 && value <= paintTimeoutMs)) throw new Error("Tauri selection diagnostic timing is invalid");
    return { selection, paint, latencyMs, brokerLatencyMs, frameLatencyMs, launcherLatencyMs: performance.now() - started };
  }

  async capture(name: keyof WorkspaceRoute["screenshots"]): Promise<string> {
    const path = this.screenshots[name];
    await this.launch([`--capture-evidence=${name}`]);
    await waitFor(async () => (await stat(path).catch(() => undefined))?.size !== undefined && ((await stat(path)).size > 1_000), 15_000, `Tauri ${name} evidence capture`);
    return path;
  }

  async records(): Promise<WorkspaceDiagnostic[]> {
    const text = await readFile(this.diagnosticsPath, "utf8").catch(() => "");
    const lines = text.endsWith("\n") ? text.trimEnd().split("\n") : text.split("\n").slice(0, -1);
    return lines.filter(Boolean).map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.kind !== "string" || typeof value.recordedAt !== "string") throw new Error("invalid Tauri acceptance diagnostic record");
      return value as WorkspaceDiagnostic;
    });
  }

  async index(): Promise<number> { return (await this.records()).length; }

  async waitForConnection(connection: string, from = 0, timeoutMs = 20_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => record.kind === "connection" && record.connection === connection, from, timeoutMs);
  }

  async waitForWindowAction(action: "raise" | "hide", from = 0, timeoutMs = 10_000): Promise<WorkspaceDiagnostic> {
    return await this.waitForRecord((record) => record.kind === "windowAction" && record.action === action, from, timeoutMs);
  }

  async closeViaAcceptance(): Promise<void> {
    const child = this.process;
    if (child === undefined) throw new Error("Tauri workspace is not running");
    await this.launch(["--acceptance-close"]);
    await new Promise<void>((resolveClose, rejectClose) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveClose(); return; }
      const timer = setTimeout(() => { child.off("exit", exited); rejectClose(new Error("Tauri CloseRequested lifecycle timed out")); }, 15_000);
      const exited = () => { clearTimeout(timer); resolveClose(); };
      child.once("exit", exited);
    });
    this.process = undefined;
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (child === undefined) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveStop(); return; }
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    });
    this.process = undefined;
  }

  assertAlive(): number {
    const child = this.process;
    assert.ok(child?.pid !== undefined && child.exitCode === null && child.signalCode === null, `Tauri workspace is not alive: ${this.stderr.join("")}`);
    return child.pid;
  }

  private async waitForRecord(predicate: (record: WorkspaceDiagnostic) => boolean, from: number, timeoutMs: number): Promise<WorkspaceDiagnostic> {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      this.assertAlive();
      const records = await this.records();
      const match = records.slice(from).find(predicate);
      if (match !== undefined) return match;
      await sleep(25);
    }
    const records = await this.records();
    const transport = records.filter((record) => record.kind === "frontendProbe" || record.kind === "selection" || record.kind === "frameReceived" || record.kind === "frameSettled").slice(-20);
    throw new Error(`Tauri diagnostic record timed out; transport=${JSON.stringify(transport)}; recent=${JSON.stringify(records.slice(-5))}; stderr=${this.stderr.join("")}`);
  }
}

function workspaceEnvironment(): NodeJS.ProcessEnv { return { ...process.env, GDK_BACKEND: "x11", WEBKIT_DISABLE_DMABUF_RENDERER: "1" }; }
function tabCaptureReadiness(record: WorkspaceDiagnostic, browserSessionId: string, tabId: string): unknown {
  if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return undefined;
  const session = record.sessions.filter(isRecord).find((item) => item.browserSessionId === browserSessionId);
  if (session === undefined || !Array.isArray(session.tabs)) return undefined;
  return session.tabs.filter(isRecord).find((item) => item.tabId === tabId)?.captureReadiness;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sleep(ms: number): Promise<void> { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) { if (await predicate()) return; await sleep(25); }
  throw new Error(`${label} timed out`);
}
