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

export interface ActionTimings {
  /** Backward-compatible aliases for the generated and replay durations. */
  pathDurationMs: number;
  pathWallMs: number;
  generatedNominalPathDurationMs: number;
  sampleReplayWallMs: number;
  cdpInputLatencyMs: number;
  cdpInputMaxLatencyMs: number;
  overlayUpdateLatencyMs: number;
  postPathGuardMs: number;
  sampleCount: number;
  completionAfterPathMs: number;
  totalMs: number;
}
interface ReplayTimings { sampleReplayWallMs: number; cdpInputLatencyMs: number; cdpInputMaxLatencyMs: number; overlayUpdateLatencyMs: number; sampleCount: number }
export type PostPathGuard = () => Promise<void>;

export type DirectHumanInputEvent =
  | { readonly kind: "pointerMove"; readonly point: Point }
  | { readonly kind: "pointerDown"; readonly point: Point; readonly button: MouseButton; readonly clickCount: number }
  | { readonly kind: "pointerUp"; readonly point: Point; readonly button: MouseButton; readonly clickCount: number }
  | { readonly kind: "wheel"; readonly point: Point; readonly deltaX: number; readonly deltaY: number }
  | { readonly kind: "keyDown"; readonly key: string; readonly code?: string; readonly repeat: boolean }
  | { readonly kind: "keyUp"; readonly key: string; readonly code?: string }
  | { readonly kind: "text"; readonly text: string };

export interface DirectHumanInputResult {
  readonly dispatchedEventCount: number;
  readonly pointerMoveCount: number;
}

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
  private inputTail: Promise<void> = Promise.resolve();

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
  isButtonHeld(button: MouseButton): boolean { return this.pressedButtons.has(button); }
  isHumanKeyHeld(key: string, code?: string): boolean { return this.pressedKeys.has(normalizeHumanKeyCode(key, code)); }

  async initializeTab(tab: TabRecord): Promise<void> {
    await this.command(tab, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.command(tab, "Page.addScriptToEvaluateOnNewDocument", { source: overlayInstallSource(this.overlay) });
    await this.installOverlay(tab);
  }

  async ensureOverlay(tab: TabRecord, signal?: AbortSignal): Promise<void> {
    if (!(await this.evaluate<boolean>(tab, overlayVerifySource(this.overlay), signal))) await this.installOverlay(tab, signal);
  }

  async coordinate(tab: TabRecord, action: CoordinateAction, context: OperationContext, postPathGuard: PostPathGuard): Promise<ActionTimings> {
    return await this.runInputExclusive(async () => await this.coordinateUnlocked(tab, action, context, postPathGuard));
  }

  private async coordinateUnlocked(tab: TabRecord, action: CoordinateAction, context: OperationContext, postPathGuard: PostPathGuard): Promise<ActionTimings> {
    const started = performance.now();
    await this.activate(tab);
    context.checkpoint();
    this.persona.tick();
    this.emit("actionStart", { tabId: tab.tabId });
    let result: ActionTimings | undefined;
    try {
      if (action.kind === "move" || action.kind === "hover") { result = await this.moveTo(tab, action.to, context, started); return result; }
      if (action.kind === "click" || action.kind === "doubleClick") {
        const move = await this.moveTo(tab, action.at, context, started);
        const afterPath = performance.now();
        await sleep(sampleDwellMs(this.persona.rng, this.persona.traits().dwellScale), context.signal);
        context.checkpoint();
        const guardStarted = performance.now();
        await postPathGuard();
        const postPathGuardMs = performance.now() - guardStarted;
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
        result = { ...move, postPathGuardMs, completionAfterPathMs: performance.now() - afterPath, totalMs: performance.now() - started };
        return result;
      }
      if (action.kind === "wheel") {
        const move = await this.moveTo(tab, action.at, context, started);
        context.checkpoint();
        const guardStarted = performance.now();
        await postPathGuard();
        const postPathGuardMs = performance.now() - guardStarted;
        context.checkpoint();
        context.markDispatched();
        const cdpStarted = performance.now();
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", ...action.at, button: "none", buttons: 0, deltaX: action.deltaX, deltaY: action.deltaY }, context.signal, 30_000);
        result = { ...move, cdpInputLatencyMs: move.cdpInputLatencyMs + performance.now() - cdpStarted, postPathGuardMs, completionAfterPathMs: performance.now() - guardStarted, totalMs: performance.now() - started };
        return result;
      }
      if (action.kind !== "drag") throw new Error("Unsupported coordinate action.");
      const approach = await this.moveTo(tab, action.from, context, started);
      context.checkpoint();
      const guardStarted = performance.now();
      await postPathGuard();
      const postPathGuardMs = performance.now() - guardStarted;
      context.checkpoint();
      await this.press(tab, "left", action.from, 1, context);
      try {
        const moveStarted = performance.now();
        const samples = this.path(action.from, action.to);
        const nominal = samples.at(-1)?.t ?? 0;
        const replay = await this.replay(tab, samples, 1, context);
        this.cursor = action.to;
        context.markDispatched();
        result = {
          pathDurationMs: approach.pathDurationMs + nominal,
          pathWallMs: approach.pathWallMs + replay.sampleReplayWallMs,
          generatedNominalPathDurationMs: approach.generatedNominalPathDurationMs + nominal,
          sampleReplayWallMs: approach.sampleReplayWallMs + replay.sampleReplayWallMs,
          cdpInputLatencyMs: approach.cdpInputLatencyMs + replay.cdpInputLatencyMs,
          cdpInputMaxLatencyMs: Math.max(approach.cdpInputMaxLatencyMs, replay.cdpInputMaxLatencyMs),
          overlayUpdateLatencyMs: approach.overlayUpdateLatencyMs + replay.overlayUpdateLatencyMs,
          postPathGuardMs,
          sampleCount: approach.sampleCount + replay.sampleCount,
          completionAfterPathMs: performance.now() - moveStarted - replay.sampleReplayWallMs,
          totalMs: performance.now() - started,
        };
        return result;
      } finally {
        await this.releaseAfterDrag(tab, "left", this.cursor, 1);
      }
    } finally { this.emit("actionEnd", { tabId: tab.tabId, ...(result === undefined ? {} : { timings: result }) }); }
  }

  async typeText(tab: TabRecord, text: string, replace: boolean, context: OperationContext): Promise<void> {
    await this.runInputExclusive(async () => await this.typeTextUnlocked(tab, text, replace, context));
  }

  private async typeTextUnlocked(tab: TabRecord, text: string, replace: boolean, context: OperationContext): Promise<void> {
    await this.activate(tab);
    if (replace) {
      await this.key(tab, "a", "KeyA", 2, context);
    }
    this.persona.tick();
    for (const item of this.persona.keySchedule(text)) {
      await sleep(item.delayMs, context.signal);
      context.checkpoint();
      if (item.t === "back") await this.pressKeyUnlocked(tab, "Backspace", context);
      else { context.checkpoint(); context.markDispatched(); await this.command(tab, "Input.insertText", { text: item.ch }, context.signal); }
    }
  }

  async pressKey(tab: TabRecord, key: string, context: OperationContext): Promise<void> {
    await this.runInputExclusive(async () => await this.pressKeyUnlocked(tab, key, context));
  }

  private async pressKeyUnlocked(tab: TabRecord, key: string, context: OperationContext): Promise<void> {
    await this.activate(tab);
    await this.key(tab, key, keyCode(key), 0, context);
  }

  assertHumanInputTransitions(events: readonly DirectHumanInputEvent[]): void {
    const buttons = new Set(this.pressedButtons);
    const keys = new Set(this.pressedKeys);
    for (const event of events) {
      if (event.kind === "pointerDown") {
        if (buttons.has(event.button)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human pointer transition is not supported.", false);
        buttons.add(event.button);
      } else if (event.kind === "pointerUp") {
        if (!buttons.delete(event.button)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human pointer transition is not supported.", false);
      } else if (event.kind === "keyDown") {
        const code = normalizeHumanKeyCode(event.key, event.code);
        if (keys.has(code) && !event.repeat) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human key transition is not supported.", false);
        keys.add(code);
      } else if (event.kind === "keyUp" && !keys.delete(normalizeHumanKeyCode(event.key, event.code))) {
        throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human key transition is not supported.", false);
      }
    }
  }

  async dispatchHumanInput(tab: TabRecord, events: readonly DirectHumanInputEvent[], signal: AbortSignal): Promise<DirectHumanInputResult> {
    return await this.runInputExclusive(async () => await this.dispatchHumanInputUnlocked(tab, events, signal));
  }

  private async dispatchHumanInputUnlocked(tab: TabRecord, events: readonly DirectHumanInputEvent[], signal: AbortSignal): Promise<DirectHumanInputResult> {
    signal.throwIfAborted();
    if (events.length === 0) return { dispatchedEventCount: 0, pointerMoveCount: 0 };
    this.assertHumanInputTransitions(events);
    if (this.activeTab !== undefined && this.activeTab.tabId !== tab.tabId && (this.pressedButtons.size > 0 || this.pressedKeys.size > 0)) {
      throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human input cannot change targets while input is held.", false);
    }
    await this.activate(tab);
    signal.throwIfAborted();
    let dispatchedEventCount = 0;
    let pointerMoveCount = 0;
    for (const event of events) {
      signal.throwIfAborted();
      if (event.kind === "pointerMove") {
        await this.updateHumanPointer(tab, event.point, signal);
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", ...event.point, button: "none", buttons: this.buttonMask() }, signal);
        pointerMoveCount++;
      } else if (event.kind === "pointerDown") {
        if (this.pressedButtons.has(event.button)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human pointer transition is not supported.", false);
        await this.updateHumanPointer(tab, event.point, signal);
        this.pressedButtons.add(event.button);
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...event.point, button: event.button, buttons: this.buttonMask(), clickCount: event.clickCount }, signal);
      } else if (event.kind === "pointerUp") {
        if (!this.pressedButtons.has(event.button)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human pointer transition is not supported.", false);
        await this.updateHumanPointer(tab, event.point, signal);
        const buttons = this.buttonMask(event.button);
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...event.point, button: event.button, buttons, clickCount: event.clickCount }, signal);
        this.pressedButtons.delete(event.button);
      } else if (event.kind === "wheel") {
        await this.updateHumanPointer(tab, event.point, signal);
        await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", ...event.point, button: "none", buttons: this.buttonMask(), deltaX: event.deltaX, deltaY: event.deltaY }, signal);
      } else if (event.kind === "keyDown") {
        const code = normalizeHumanKeyCode(event.key, event.code);
        const held = this.pressedKeys.has(code);
        if (held && !event.repeat) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human key transition is not supported.", false);
        if (!held) this.pressedKeys.add(code);
        await this.command(tab, "Input.dispatchKeyEvent", { type: "keyDown", key: event.key, code, autoRepeat: event.repeat }, signal);
      } else if (event.kind === "keyUp") {
        const code = normalizeHumanKeyCode(event.key, event.code);
        if (!this.pressedKeys.has(code)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human key transition is not supported.", false);
        await this.command(tab, "Input.dispatchKeyEvent", { type: "keyUp", key: event.key, code }, signal);
        this.pressedKeys.delete(code);
      } else {
        await this.command(tab, "Input.insertText", { text: event.text }, signal);
      }
      dispatchedEventCount++;
    }
    return { dispatchedEventCount, pointerMoveCount };
  }

  async releaseAll(tab = this.activeTab): Promise<void> {
    await this.runInputExclusive(async () => await this.releaseAllUnlocked(tab));
  }

  private async releaseAllUnlocked(tab = this.activeTab): Promise<void> {
    if (tab === undefined || tab.state !== "open" || motorConnection(tab).connected === false) {
      if (this.pressedButtons.size > 0 || this.pressedKeys.size > 0) this.emit("cleanupUnavailable", { reason: tab?.state !== "open" ? "Target is terminal" : "CDP disconnected" });
      this.pressedButtons.clear();
      this.pressedKeys.clear();
      return;
    }
    for (const button of [...this.pressedButtons]) await this.releaseWithCleanup(tab, button, this.cursor, 1).catch(() => undefined);
    for (const code of [...this.pressedKeys]) {
      const cleanup = cleanupBudget();
      try {
        await this.cleanupCommand(tab, "Input.dispatchKeyEvent", { type: "keyUp", key: keyFromCode(code), code }, cleanup.signal);
        this.pressedKeys.delete(code);
      } catch { /* Keep ambiguous held state while CDP remains available. */ }
      finally { cleanup.dispose(); }
    }
  }

  private async runInputExclusive<T>(task: () => Promise<T>): Promise<T> {
    const prior = this.inputTail;
    let release!: () => void;
    this.inputTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await task(); }
    finally { release(); }
  }

  private async updateHumanPointer(tab: TabRecord, point: Point, signal: AbortSignal): Promise<void> {
    this.sampleSequence++;
    await this.evaluate(tab, overlayUpdateSource(this.overlay, point.x, point.y, this.pathSequence, this.sampleSequence), signal);
    this.cursor = point;
    this.emit("sample", { tabId: tab.tabId, cursor: this.state });
  }

  private buttonMask(excluding?: MouseButton): number {
    let value = 0;
    if (excluding !== "left" && this.pressedButtons.has("left")) value |= 1;
    if (excluding !== "right" && this.pressedButtons.has("right")) value |= 2;
    if (excluding !== "middle" && this.pressedButtons.has("middle")) value |= 4;
    return value;
  }

  private async moveTo(tab: TabRecord, to: Point, context: OperationContext, totalStarted: number): Promise<ActionTimings> {
    const from = this.cursor;
    const samples = this.path(from, to);
    const nominal = samples.at(-1)?.t ?? 0;
    const replay = await this.replay(tab, samples, 0, context);
    this.cursor = to;
    return {
      pathDurationMs: nominal,
      pathWallMs: replay.sampleReplayWallMs,
      generatedNominalPathDurationMs: nominal,
      sampleReplayWallMs: replay.sampleReplayWallMs,
      cdpInputLatencyMs: replay.cdpInputLatencyMs,
      cdpInputMaxLatencyMs: replay.cdpInputMaxLatencyMs,
      overlayUpdateLatencyMs: replay.overlayUpdateLatencyMs,
      postPathGuardMs: 0,
      sampleCount: replay.sampleCount,
      completionAfterPathMs: 0,
      totalMs: performance.now() - totalStarted,
    };
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

  private async replay(tab: TabRecord, samples: CursorSample[], buttons: number, context: OperationContext): Promise<ReplayTimings> {
    this.pathSequence++;
    const started = performance.now();
    let overlayUpdateLatencyMs = 0;
    let sampleCount = 0;
    const inputResponses: Array<Promise<number>> = [];
    let replayError: unknown;
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
        const cdpStarted = performance.now();
        const input = this.command(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sample.x, y: sample.y, button: "none", buttons }, context.signal).then(() => performance.now() - cdpStarted);
        void input.catch(() => undefined);
        inputResponses.push(input);
        const overlayStarted = performance.now();
        await this.evaluate(tab, overlayUpdateSource(this.overlay, sample.x, sample.y, this.pathSequence, this.sampleSequence));
        overlayUpdateLatencyMs += performance.now() - overlayStarted;
        sampleCount++;
        this.cursor = { x: sample.x, y: sample.y };
        this.emit("sample", { tabId: tab.tabId, cursor: this.state });
      }
    } catch (error) { replayError = error; }
    const settled = await Promise.allSettled(inputResponses);
    if (replayError !== undefined) throw replayError;
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    const latencies = settled.map((item) => (item as PromiseFulfilledResult<number>).value);
    return { sampleReplayWallMs: performance.now() - started, cdpInputLatencyMs: latencies.reduce((sum, value) => sum + value, 0), cdpInputMaxLatencyMs: Math.max(0, ...latencies), overlayUpdateLatencyMs, sampleCount };
  }

  private async activate(tab: TabRecord): Promise<void> {
    if (this.activeTab?.tabId !== tab.tabId) { this.activeTab = tab; await this.installOverlay(tab); }
    else if (!(await this.evaluate<boolean>(tab, overlayVerifySource(this.overlay)))) await this.installOverlay(tab);
  }

  private async installOverlay(tab: TabRecord, signal?: AbortSignal): Promise<void> {
    await this.evaluate(tab, overlayInstallSource(this.overlay), signal);
    await this.evaluate(tab, overlayUpdateSource(this.overlay, this.cursor.x, this.cursor.y, this.pathSequence, this.sampleSequence), signal);
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
      await this.cleanupCommand(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button, buttons: this.buttonMask(button), clickCount }, cleanup.signal);
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
    this.pressedKeys.add(code);
    context.markDispatched();
    try {
      await this.command(tab, "Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers }, context.signal);
    } finally {
      const cleanup = cleanupBudget();
      try {
        await this.cleanupCommand(tab, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers }, cleanup.signal);
        this.pressedKeys.delete(code);
      } finally { cleanup.dispose(); }
    }
  }

  private async evaluate<T>(tab: TabRecord, expression: string, signal?: AbortSignal): Promise<T> {
    const response = await this.command<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, signal);
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
const HUMAN_PHYSICAL_CODES = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|(?:Enter|Escape|Tab|Backspace|Space|Home|End|PageUp|PageDown|Insert|Delete|CapsLock|NumLock|ScrollLock|Pause|ContextMenu|PrintScreen|Semicolon|Equal|Comma|Minus|Period|Slash|Backquote|BracketLeft|Backslash|BracketRight|Quote|IntlBackslash|IntlRo|IntlYen))$/;
function normalizeHumanKeyCode(key: string, supplied?: string): string {
  const derived: Record<string, string> = { Backspace: "Backspace", Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", Home: "Home", End: "End", PageDown: "PageDown", PageUp: "PageUp", Insert: "Insert", Delete: "Delete", Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft", " ": "Space" };
  const code = supplied ?? derived[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : undefined);
  if (code === undefined || !HUMAN_PHYSICAL_CODES.test(code)) throw new BrowserProtocolError("INPUT_UNSUPPORTED", "Human key transition is not supported.", false);
  return code;
}
function keyFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === "Space") return " ";
  if (code.startsWith("Shift")) return "Shift";
  if (code.startsWith("Control")) return "Control";
  if (code.startsWith("Alt")) return "Alt";
  if (code.startsWith("Meta")) return "Meta";
  return code;
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); if (ms <= 0) return; await new Promise<void>((resolve, reject) => { const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Cancelled")); }; const timer = setTimeout(() => { cleanup(); resolve(); }, ms); const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); }
