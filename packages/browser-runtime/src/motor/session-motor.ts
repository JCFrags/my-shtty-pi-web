import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { BrowserProtocolError } from "@webx/browser-protocol";
import type { OperationContext } from "../operations/registry.js";
import type { TabRecord } from "../targets/registry.js";
import { generateMove, sampleDwellMs, samplePressMs, createPersona, type CursorSample, type Point } from "../vendor/agentcursor/index.js";
import { overlayInstallSource, overlayUpdateSource, overlayVerifySource, type OverlayIdentity } from "./overlay.js";

export type MouseButton = "left" | "middle" | "right";
export type CoordinateAction =
  | { kind: "move" | "hover"; to: Point }
  | { kind: "click" | "doubleClick"; at: Point; button: MouseButton }
  | { kind: "drag"; from: Point; to: Point }
  | { kind: "wheel"; at: Point; deltaX: number; deltaY: number };

export interface CursorState extends Point {
  pathSequence: number;
  sampleSequence: number;
  personaId: string;
  visible: boolean;
}

export interface ActionTimings { pathDurationMs: number; pathWallMs: number; completionAfterPathMs: number; totalMs: number }
export type PostPathGuard = () => Promise<void>;

export class SessionMotor extends EventEmitter {
  readonly personaId = randomBytes(18).toString("base64url");
  readonly persona;
  private readonly overlay: OverlayIdentity;
  private cursor: Point = { x: 80, y: 80 };
  private pathSequence = 0;
  private sampleSequence = 0;
  private pressedButtons = new Set<MouseButton>();
  private pressedKeys = new Set<string>();
  private activeTab?: TabRecord;

  constructor(readonly browserSessionId: string, personaSeed: number, private readonly minimumPathDurationMs = 0) {
    super();
    this.persona = createPersona(personaSeed);
    const token = randomBytes(18).toString("base64url");
    this.overlay = { hostId: `pi-cursor-${token}`, setterName: `__piCursorSet_${token}`, installerName: `__piCursorInstall_${token}` };
  }

  get state(): CursorState {
    return { ...this.cursor, pathSequence: this.pathSequence, sampleSequence: this.sampleSequence, personaId: this.personaId, visible: true };
  }

  get heldInputState(): { buttons: readonly MouseButton[]; keys: readonly string[] } {
    return { buttons: [...this.pressedButtons], keys: [...this.pressedKeys] };
  }

  isActiveTab(tabId: string): boolean { return this.activeTab?.tabId === tabId; }

  async initializeTab(tab: TabRecord): Promise<void> {
    await this.command(tab, "Page.addScriptToEvaluateOnNewDocument", { source: overlayInstallSource(this.overlay) });
    await this.installOverlay(tab);
  }

  async ensureOverlay(tab: TabRecord): Promise<void> {
    if (!(await this.evaluate<boolean>(tab, overlayVerifySource(this.overlay)))) await this.installOverlay(tab);
  }

  async coordinate(tab: TabRecord, action: CoordinateAction, context: OperationContext, postPathGuard: PostPathGuard): Promise<ActionTimings> {
    const started = performance.now();
    await this.activate(tab);
    context.checkpoint();
    this.persona.tick();
    this.emit("actionStart", { tabId: tab.tabId });
    try {
      if (action.kind === "move" || action.kind === "hover") return await this.moveTo(tab, action.to, context, started);
      if (action.kind === "click" || action.kind === "doubleClick") {
        const move = await this.moveTo(tab, action.at, context, started);
        const afterPath = performance.now();
        await sleep(sampleDwellMs(this.persona.rng, this.persona.traits().dwellScale), context.signal);
        context.checkpoint();
        await postPathGuard();
        context.checkpoint();
        const count = action.kind === "doubleClick" ? 2 : 1;
        for (let index = 1; index <= count; index++) {
          context.checkpoint();
          let possiblyPressed = false;
          try {
            possiblyPressed = true;
            await this.press(tab, action.button, action.at, index, context);
            await sleep(samplePressMs(this.persona.rng, this.persona.traits().pressScale), context.signal);
          } finally {
            if (possiblyPressed) await this.releaseWithCleanup(tab, action.button, action.at, index);
          }
          if (index < count) await sleep(70, context.signal);
        }
        return { ...move, completionAfterPathMs: performance.now() - afterPath, totalMs: performance.now() - started };
      }
      if (action.kind === "wheel") {
        await this.moveTo(tab, action.at, context, started);
        context.checkpoint();
        await postPathGuard();
        context.checkpoint();
        context.markDispatched();
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", ...action.at, button: "none", buttons: 0, deltaX: action.deltaX, deltaY: action.deltaY }, context.signal, 30_000);
        return { pathDurationMs: 0, pathWallMs: 0, completionAfterPathMs: 0, totalMs: performance.now() - started };
      }
      if (action.kind !== "drag") throw new Error("Unsupported coordinate action.");
      await this.moveTo(tab, action.from, context, started);
      context.checkpoint();
      await postPathGuard();
      context.checkpoint();
      await this.press(tab, "left", action.from, 1, context);
      try {
        const moveStarted = performance.now();
        const samples = this.path(action.from, action.to);
        const nominal = samples.at(-1)?.t ?? 0;
        await this.replay(tab, samples, 1, context);
        this.cursor = action.to;
        context.markDispatched();
        return { pathDurationMs: nominal, pathWallMs: performance.now() - moveStarted, completionAfterPathMs: 0, totalMs: performance.now() - started };
      } finally {
        await this.releaseAfterDrag(tab, "left", this.cursor, 1);
      }
    } finally { this.emit("actionEnd", { tabId: tab.tabId }); }
  }

  async typeText(tab: TabRecord, text: string, replace: boolean, context: OperationContext): Promise<void> {
    await this.activate(tab);
    if (replace) {
      await this.key(tab, "a", "KeyA", 2, context);
    }
    this.persona.tick();
    for (const item of this.persona.keySchedule(text)) {
      await sleep(item.delayMs, context.signal);
      context.checkpoint();
      if (item.t === "back") await this.pressKey(tab, "Backspace", context);
      else { context.checkpoint(); context.markDispatched(); await this.command(tab, "Input.insertText", { text: item.ch }, context.signal); }
    }
  }

  async pressKey(tab: TabRecord, key: string, context: OperationContext): Promise<void> {
    await this.activate(tab);
    await this.key(tab, key, keyCode(key), 0, context);
  }

  async releaseAll(tab = this.activeTab): Promise<void> {
    if (tab === undefined || tab.state !== "open" || motorConnection(tab).connected === false) {
      if (this.pressedButtons.size > 0 || this.pressedKeys.size > 0) this.emit("cleanupUnavailable", { reason: tab?.state !== "open" ? "Target is terminal" : "CDP disconnected" });
      this.pressedButtons.clear();
      this.pressedKeys.clear();
      return;
    }
    for (const button of [...this.pressedButtons]) await this.releaseWithCleanup(tab, button, this.cursor, 1).catch(() => undefined);
    for (const key of [...this.pressedKeys]) {
      const cleanup = cleanupBudget();
      try {
        await this.cleanupCommand(tab, "Input.dispatchKeyEvent", { type: "keyUp", key, code: keyCode(key) }, cleanup.signal);
        this.pressedKeys.delete(key);
      } catch { /* Keep ambiguous held state while CDP remains available. */ }
      finally { cleanup.dispose(); }
    }
  }

  private async moveTo(tab: TabRecord, to: Point, context: OperationContext, totalStarted: number): Promise<ActionTimings> {
    const from = this.cursor;
    const samples = this.path(from, to);
    const nominal = samples.at(-1)?.t ?? 0;
    const started = performance.now();
    await this.replay(tab, samples, 0, context);
    this.cursor = to;
    return { pathDurationMs: nominal, pathWallMs: performance.now() - started, completionAfterPathMs: 0, totalMs: performance.now() - totalStarted };
  }

  private path(from: Point, to: Point): CursorSample[] {
    const traits = this.persona.traits();
    const samples = generateMove(from, to, { rng: this.persona.rng, targetWidth: 24, speedFactor: traits.speedFactor, curviness: traits.curviness, jitterPx: traits.jitterPx, overshootProb: traits.overshootProb, overshootMag: traits.overshootMag, handedness: traits.handedness });
    const duration = samples.at(-1)?.t ?? 0;
    const scaled = duration > 0 && duration < this.minimumPathDurationMs
      ? samples.map((sample) => ({ ...sample, t: sample.t * (this.minimumPathDurationMs / duration) }))
      : samples;
    if (scaled.length <= 16) return scaled;
    const reduced: CursorSample[] = [];
    for (let index = 0; index < 16; index++) {
      const sample = scaled[Math.round(index * (scaled.length - 1) / 15)];
      if (sample === undefined) throw new Error("Path sample selection failed.");
      reduced.push(sample);
    }
    return reduced;
  }

  private async replay(tab: TabRecord, samples: CursorSample[], buttons: number, context: OperationContext): Promise<void> {
    this.pathSequence++;
    const started = performance.now();
    const pending: Array<Promise<unknown>> = [];
    let loopError: unknown;
    try {
      for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        if (sample === undefined) throw new Error("Path sample is missing.");
        const elapsed = performance.now() - started;
        if (index < samples.length - 1 && sample.t < elapsed - 50) continue;
        await sleep(Math.max(0, sample.t - elapsed), context.signal);
        context.checkpoint();
        context.markPartiallyDispatched();
        this.sampleSequence++;
        pending.push(Promise.all([
          this.command(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sample.x, y: sample.y, button: "none", buttons }),
          this.evaluate(tab, overlayUpdateSource(this.overlay, sample.x, sample.y, this.pathSequence, this.sampleSequence)),
        ]));
        this.cursor = { x: sample.x, y: sample.y };
        this.emit("sample", { tabId: tab.tabId, cursor: this.state });
      }
    } catch (error) { loopError = error; }
    const settled = await Promise.allSettled(pending);
    if (loopError !== undefined) throw loopError;
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async activate(tab: TabRecord): Promise<void> {
    if (this.activeTab?.tabId !== tab.tabId) { this.activeTab = tab; await this.installOverlay(tab); }
    else if (!(await this.evaluate<boolean>(tab, overlayVerifySource(this.overlay)))) await this.installOverlay(tab);
  }

  private async installOverlay(tab: TabRecord): Promise<void> {
    await this.evaluate(tab, overlayInstallSource(this.overlay));
    await this.evaluate(tab, overlayUpdateSource(this.overlay, this.cursor.x, this.cursor.y, this.pathSequence, this.sampleSequence));
  }

  private async press(tab: TabRecord, button: MouseButton, at: Point, clickCount: number, context: OperationContext): Promise<void> {
    context.checkpoint();
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    this.pressedButtons.add(button);
    context.markDispatched();
    await this.command(tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...at, button, buttons, clickCount }, context.signal);
  }

  private async releaseWithCleanup(tab: TabRecord, button: MouseButton, at: Point, clickCount: number): Promise<void> {
    const cleanup = cleanupBudget();
    try {
      await this.cleanupCommand(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button, buttons: 0, clickCount }, cleanup.signal);
      this.pressedButtons.delete(button);
    } finally { cleanup.dispose(); }
  }

  private async releaseAfterDrag(tab: TabRecord, button: MouseButton, at: Point, clickCount: number): Promise<void> {
    try { await this.releaseWithCleanup(tab, button, at, clickCount); }
    catch (error) {
      await this.releaseWithCleanup(tab, button, at, clickCount).catch(() => undefined);
      if (error instanceof Error && "code" in error) throw error;
      throw new BrowserProtocolError("CDP_ERROR", "Mouse release failed while the browser connection remained available.", true);
    }
  }

  private async key(tab: TabRecord, key: string, code: string, modifiers: number, context: OperationContext): Promise<void> {
    context.checkpoint();
    this.pressedKeys.add(key);
    context.markDispatched();
    try {
      await this.command(tab, "Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers }, context.signal);
    } finally {
      const cleanup = cleanupBudget();
      try {
        await this.cleanupCommand(tab, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers }, cleanup.signal);
        this.pressedKeys.delete(key);
      } finally { cleanup.dispose(); }
    }
  }

  private async evaluate<T>(tab: TabRecord, expression: string): Promise<T> {
    const response = await this.command<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails !== undefined) throw new Error("Internal page helper failed.");
    return response.result?.value as T;
  }

  private async command<T = Record<string, unknown>>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    if (tab.state !== "open") throw new Error("Browser target is not open.");
    const options = { ...(signal !== undefined ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    return await motorConnection(tab).send<T>(method, params, tab.cdpSessionId, options);
  }

  private async cleanupCommand<T = Record<string, unknown>>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<T> {
    return await motorConnection(tab).send<T>(method, params, tab.cdpSessionId, { signal, timeoutMs: 750 });
  }
}

interface MotorConnection { connected?: boolean; send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> }
const connections = new WeakMap<TabRecord, MotorConnection>();
export function bindMotorTab(tab: TabRecord, connection: MotorConnection): void { connections.set(tab, connection); }
function motorConnection(tab: TabRecord): MotorConnection { const connection = connections.get(tab); if (connection === undefined) throw new Error("Tab has no CDP connection."); return connection; }
function cleanupBudget(timeoutMs = 750): { signal: AbortSignal; dispose(): void } { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("Input cleanup timed out.")), timeoutMs); return { signal: controller.signal, dispose: () => clearTimeout(timer) }; }
function keyCode(key: string): string { const fixed: Record<string, string> = { Backspace: "Backspace", Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", Home: "Home", End: "End", PageDown: "PageDown", PageUp: "PageUp", " ": "Space" }; return fixed[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key); }
async function sleep(ms: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); if (ms <= 0) return; await new Promise<void>((resolve, reject) => { const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Cancelled")); }; const timer = setTimeout(() => { cleanup(); resolve(); }, ms); const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); }
