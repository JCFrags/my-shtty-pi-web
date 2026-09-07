import { TargetPreparation } from "./target-preparation";
import type { PreparedTarget } from "./target-preparation";
import type {
  BrowserDriver,
  CursorSample,
  DeliveryMode,
  Persona,
  Point,
} from "agentcursor" with {
  "resolution-mode": "import",
};

import { parseAgentKey } from "./key";
import type { AgentKey } from "./key";
import type { AgentBrowserTarget, AgentPageObserver, AgentPageProbe } from "./types";
import type { ProgrammaticPointerEvent } from "../page/input";

type ClickArgs = Parameters<BrowserDriver["click"]>[0];
type TypeArgs = Parameters<BrowserDriver["type"]>[0];
type ScrollArgs = Parameters<BrowserDriver["scroll"]>[0];
type WaitArgs = Parameters<BrowserDriver["waitFor"]>[0];
type HoverArgs = Parameters<BrowserDriver["hover"]>[0];
type DragArgs = Parameters<BrowserDriver["drag"]>[0];
type ResolveLocatorArgs = Parameters<BrowserDriver["resolveLocator"]>;
type AgentCursorModule = typeof import("agentcursor", {
  with: { "resolution-mode": "import" },
});

let agentCursorModule: Promise<AgentCursorModule> | null = null;

function loadAgentCursor(): Promise<AgentCursorModule> {
  return (agentCursorModule ??= import("agentcursor"));
}

export interface TerminalBrowserDriverOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  beforeInput?: () => void;
  onPointer?: (event: ProgrammaticPointerEvent) => void;
  onTarget?: (point: Point) => void;
}

const SCROLL_STEP_DELAY_MS = 24;
const SCROLL_DELTA_PER_STEP = 60;
const WAIT_POLL_MS = 100;
const MAX_SCROLL_STEPS = 80;
const MIN_SCROLL_STEPS = 6;
const MAX_TEXT = 32_768;
const MAX_NATURAL_TEXT = 4_096;
const MAX_SCROLL_DELTA = 20_000;
const MAX_WAIT_TEXT = 1_024;

export class TerminalBrowserDriver implements BrowserDriver {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly beforeInput: (() => void) | undefined;
  private readonly onPointer: ((event: ProgrammaticPointerEvent) => void) | undefined;
  private readonly onTarget: ((point: Point) => void) | undefined;
  private lastPosition: Point | null = null;
  private persona: Persona | null = null;
  private binding: { preparation: TargetPreparation; primary?: PreparedTarget; destination?: PreparedTarget; hover: boolean } | null = null;

  bindTargets(preparation: TargetPreparation, primary?: PreparedTarget, destination?: PreparedTarget, hover = false): void {
    this.binding = { preparation, primary, destination, hover };
  }

  clearTargets(): void { this.binding = null; }

  constructor(
    private readonly target: AgentBrowserTarget,
    private readonly observer: AgentPageObserver,
    options: TerminalBrowserDriverOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.beforeInput = options.beforeInput;
    this.onPointer = options.onPointer;
    this.onTarget = options.onTarget;
  }

  async snapshot(maxElements: number, includeText: boolean) {
    this.beforeInput?.();
    const { snapshot } = await this.observer.observe(maxElements, includeText);
    this.beforeInput?.();
    for (const prepared of [this.binding?.primary, this.binding?.destination]) {
      if (!prepared) continue;
      const state = prepared.state;
      const element = { ref: state.ref, tag: state.tag, role: state.role, name: state.name, rect: state.rect, editable: state.editable };
      const index = snapshot.elements.findIndex(candidate => candidate.ref === state.ref);
      if (index < 0) snapshot.elements.push(element);
      else snapshot.elements[index] = element;
    }
    return snapshot;
  }

  usePersona(persona: Persona): void {
    if (this.persona && this.persona !== persona) {
      throw new Error("terminal-browser driver persona cannot change");
    }
    this.persona = persona;
  }

  async cursorState(): Promise<Point> {
    if (this.lastPosition) return { ...this.lastPosition };
    const viewport = this.target.viewportSize();
    return { x: viewport.width / 2, y: viewport.height / 2 };
  }

  async move(samples: CursorSample[], mode: DeliveryMode): Promise<void> {
    this.assertContentMode(mode);
    await this.replayMove(samples, true);
    const last = samples.at(-1);
    if (last) {
      const point = { x: last.x, y: last.y };
      if (this.binding?.hover) await this.readyAt(point, this.binding.primary);
      this.lastPosition = point;
    }
  }

  async click(args: ClickArgs): Promise<void> {
    this.assertContentMode(args.mode);
    try {
      await this.replayMove(args.samples, true);
      if (args.preClickDwellMs > 0) await this.sleep(args.preClickDwellMs);
      await this.readyAt(args.target, this.binding?.primary);
      if (this.binding?.primary) this.binding.primary.committed = true;
      await this.clickCycle(args.target, args.button, args.pressMs);
      if (args.dblclick && this.binding?.primary && !await this.binding.preparation.check(this.binding.primary, args.target)) {
        throw new Error("target changed after first click; action was not retried");
      }
      if (args.dblclick) await this.clickCycle(args.target, args.button, args.pressMs);
      this.lastPosition = { ...args.target };
    } catch (error) {
      this.releaseAndRethrow(error);
    }
  }

  async ensureVisible(ref?: string, _point?: Point) {
    this.beforeInput?.();
    const prepared = [this.binding?.primary, this.binding?.destination].find(target => target?.state.ref === ref);
    const result = prepared ? prepared.state.rect : ref ? await this.observer.ensureVisible(ref) : null;
    this.beforeInput?.();
    return result;
  }

  async type(args: TypeArgs): Promise<void> {
    this.assertContentMode(args.mode);
    validateTypeArgs(args);
    try {
      if (args.replace) {
        await this.assertTypingTarget();
        this.beforeInput?.();
        await this.target.agentSelectAll();
        await this.assertTypingTarget();
        this.beforeInput?.();
        await this.target.agentInsertText(args.text);
        return;
      }
      if (args.schedule) {
        for (const operation of normalizeSchedule(args.schedule)) {
          const delay = operation.delayMs;
          if (!Number.isFinite(delay) || delay < 0) throw new Error("invalid typing schedule");
          await this.sleep(delay);
          await this.assertTypingTarget();
          if (operation.t === "back") await this.dispatchKeyCycle(parseAgentKey("Backspace"));
          else await this.dispatchTextKey(operation.ch);
        }
        return;
      }
      for (const character of args.text) {
        const range = boundedDelay(args.perKeyMinMs, args.perKeyMaxMs, this.random);
        await this.sleep(range);
        await this.assertTypingTarget();
        await this.dispatchTextKey(character);
      }
    } catch (error) {
      this.releaseAndRethrow(error);
    }
  }

  async scroll(args: ScrollArgs): Promise<void> {
    this.assertContentMode(args.mode);
    validateScrollArgs(args);
    const totalX = Math.round(args.dx);
    const totalY = Math.round(args.dy);
    const steps = boundedSteps(args.steps, totalX, totalY);
    const position = await this.cursorState();
    this.lastPosition = { ...position };
    let previousX = 0;
    let previousY = 0;
    try {
      for (let step = 1; step <= steps; step++) {
        if (step > 1) {
          await this.sleep(SCROLL_STEP_DELAY_MS);
        }
        this.beforeInput?.();
        const progress = smootherstep(step / steps);
        const nextX = Math.round(totalX * progress);
        const nextY = Math.round(totalY * progress);
        const deltaX = nextX - previousX;
        const deltaY = nextY - previousY;
        previousX = nextX;
        previousY = nextY;
        if (deltaX === 0 && deltaY === 0) continue;
        await this.target.agentWheel(position.x, position.y, deltaX, deltaY);
      }
    } catch (error) {
      this.releaseAndRethrow(error);
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.target.agentNavigate) this.unsupported("navigate");
    this.beforeInput?.();
    await this.target.agentNavigate(url);
  }

  async getUrl(): Promise<string> {
    this.beforeInput?.();
    return this.target.currentUrl();
  }

  async waitFor(args: WaitArgs): Promise<boolean> {
    validateWaitArgs(args);
    const condition = args.condition ?? (args.ref ? "visible" : "text");
    const text = args.text === undefined ? null : normalizeSearchText(args.text);
    const started = this.now();
    try {
      while (true) {
        this.beforeInput?.();
        const probe = await this.observer.probe(args.ref, text ?? undefined);
        this.beforeInput?.();
        if (matchesProbe(probe, condition, args.ref, text)) return true;
        const elapsed = Math.max(0, this.now() - started);
        if (elapsed >= args.timeoutMs) return false;
        await this.sleep(Math.min(WAIT_POLL_MS, args.timeoutMs - elapsed));
        this.beforeInput?.();
      }
    } catch (error) {
      this.releaseAndRethrow(error);
    }
  }

  async screenshot(_format?: "png" | "jpeg"): Promise<string> {
    this.unsupported("screenshot");
  }

  async hover(_opts: HoverArgs): Promise<void> {
    this.beforeInput?.();
  }

  async drag(args: DragArgs): Promise<void> {
    this.assertContentMode(args.mode);
    const first = args.samples[0];
    if (!first) throw new Error("drag needs a movement path");
    let start = { x: first.x, y: first.y };
    let samples = args.samples;
    let held = false;
    let failure: unknown;
    try {
      await this.approachDragSource(start);
      if (this.binding) {
        const binding = this.binding;
        for (let attempt = 0; attempt < 3; attempt++) {
          const sourceReady = !binding.primary || await binding.preparation.check(binding.primary, start);
          const destinationReady = !binding.destination || await binding.preparation.check(binding.destination, args.target);
          if (sourceReady && destinationReady) break;
          if (attempt === 2) throw new Error("drag target changed before input");
          if (!sourceReady && binding.primary) start = await binding.preparation.refresh(binding.primary, start);
          if (!destinationReady && binding.destination) Object.assign(args.target, await binding.preparation.refresh(binding.destination, args.target));
          samples = await this.naturalSamples(start, args.target);
          await this.approachDragSource(start);
          await this.sleep(80);
        }
      }
      if (!this.binding?.primary) await this.target.frames?.assertCoordinates(start);
      if (!this.binding?.destination) await this.target.frames?.assertCoordinates(args.target);
      if (this.binding?.primary) this.binding.primary.committed = true;
      if (this.binding?.destination) this.binding.destination.committed = true;
      this.beforeInput?.();
      await this.target.agentStartDrag?.();
      this.beforeInput?.();
      const down = { kind: "down" as const, x: start.x, y: start.y, button: args.button };
      this.target.agentPointer(down);
      this.onPointer?.(down);
      held = true;
      await this.replayMove(samples, true);
      if (this.binding?.destination && !await this.binding.preparation.check(this.binding.destination, args.target)) {
        throw new Error("drag destination changed after input; action was not retried");
      }
      if (!this.binding?.destination) await this.target.frames?.assertCoordinates(args.target);
      this.lastPosition = { ...args.target };
    } catch (error) {
      failure = error;
    } finally {
      if (failure !== undefined) {
        try { await this.target.agentFinishDrag?.(true); } catch {}
      }
      if (held) {
        const releasePoint = this.lastPosition ?? start;
        const up = { kind: "up" as const, x: releasePoint.x, y: releasePoint.y, button: args.button };
        try {
          this.target.agentPointer(up);
          this.onPointer?.(up);
        } catch {}
      }
    }
    try { await this.target.agentFinishDrag?.(failure !== undefined); }
    catch (error) { failure ??= error; }
    if (failure !== undefined) this.releaseAndRethrow(failure);
  }

  async pressKey(key: string, mode: DeliveryMode): Promise<void> {
    this.assertContentMode(mode);
    try {
      await this.dispatchKeyCycle(parseAgentKey(key));
    } catch (error) {
      this.releaseAndRethrow(error);
    }
  }

  async resolveLocator(
    spec: ResolveLocatorArgs[0],
    opts: ResolveLocatorArgs[1],
  ): Promise<Awaited<ReturnType<BrowserDriver["resolveLocator"]>>> {
    this.beforeInput?.();
    const documentId = await this.observer.currentDocumentId();
    this.beforeInput?.();
    const preparation = new TargetPreparation(this.observer, documentId, () => this.beforeInput?.(), this.sleep, this.now);
    return preparation.resolveLocator(spec, opts.timeoutMs, opts.scrollIntoView);
  }

  private async assertTypingTarget(): Promise<void> {
    this.beforeInput?.();
    if (this.binding?.primary) await this.binding.preparation.assertFocused(this.binding.primary);
    this.beforeInput?.();
  }

  private async readyAt(point: Point, target?: PreparedTarget): Promise<void> {
    if (!target || !this.binding) { await this.target.frames?.assertCoordinates(point); return; }
    const binding = this.binding;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.beforeInput?.();
      if (await binding.preparation.check(target, point)) {
        this.beforeInput?.();
        return;
      }
      if (attempt === 2) break;
      const updated = await binding.preparation.refresh(target, point);
      await this.approachDragSource(updated);
      point.x = updated.x;
      point.y = updated.y;
      await this.sleep(80);
    }
    throw new Error("target changed or is obstructed before input");
  }

  private async naturalSamples(from: Point, to: Point): Promise<CursorSample[]> {
    const persona = this.persona;
    if (!persona) throw new Error("slow-natural persona is not configured");
    const traits = persona.traits();
    const { generateMove } = await loadAgentCursor();
    return generateMove(from, to, {
      rng: persona.rng,
      targetWidth: 24,
      speedFactor: traits.speedFactor,
      curviness: traits.curviness,
      jitterPx: traits.jitterPx,
      overshootProb: traits.overshootProb,
      overshootMag: traits.overshootMag,
      handedness: traits.handedness,
    });
  }

  private async approachDragSource(start: Point): Promise<void> {
    const current = await this.cursorState();
    if (current.x === start.x && current.y === start.y) return;
    await this.replayMove(await this.naturalSamples(current, start), true);
    this.lastPosition = { ...start };
  }

  private async dispatchTextKey(character: string): Promise<void> {
    const key = parseAgentKey(
      character === "\n" || character === "\r"
        ? "Enter"
        : character === "\t"
          ? "Tab"
          : character,
    );
    await this.dispatchKeyCycle(key);
  }

  private async dispatchKeyCycle(key: AgentKey): Promise<void> {
    let held = false;
    try {
      this.beforeInput?.();
      await this.target.agentKeyDown(key);
      held = true;
      if (key.character) {
        await this.assertTypingTarget();
        this.beforeInput?.();
        await this.target.agentKeyChar(key);
      }
      this.beforeInput?.();
      this.target.agentKeyUp(key);
      held = false;
    } finally {
      if (held) {
        try {
          this.target.agentKeyUp(key);
        } catch {}
      }
    }
  }

  private async replayMove(samples: CursorSample[], guard = false): Promise<void> {
    let previousAt = 0;
    for (const sample of samples) {
      const at = Number.isFinite(sample.t) ? Math.max(previousAt, sample.t) : previousAt;
      const delay = at - previousAt;
      if (delay > 0) await this.sleep(delay);
      if (guard) this.beforeInput?.();
      const move = { kind: "move" as const, x: sample.x, y: sample.y };
      this.target.agentPointer(move);
      this.lastPosition = { x: sample.x, y: sample.y };
      this.onPointer?.(move);
      previousAt = at;
    }
  }

  private async clickCycle(point: Point, button: ClickArgs["button"], pressMs: number) {
    this.onTarget?.(point);
    this.beforeInput?.();
    const down = { kind: "down" as const, x: point.x, y: point.y, button };
    this.target.agentPointer(down);
    this.onPointer?.(down);
    try {
      if (pressMs > 0) await this.sleep(pressMs);
    } finally {
      const up = { kind: "up" as const, x: point.x, y: point.y, button };
      this.target.agentPointer(up);
      this.onPointer?.(up);
    }
  }

  private releaseAndRethrow(error: unknown): never {
    try {
      this.target.releaseAgentInput();
    } catch {}
    try {
      this.beforeInput?.();
    } catch (guardError) {
      throw guardError;
    }
    throw error;
  }

  private assertContentMode(mode: DeliveryMode) {
    if (mode !== "content") {
      throw new Error("terminal-browser agent only supports content delivery");
    }
  }

  private unsupported(operation: string): never {
    throw new Error(`terminal-browser agent ${operation} is not supported in this slice`);
  }
}

function validateTypeArgs(args: TypeArgs) {
  const max = args.replace ? MAX_TEXT : MAX_NATURAL_TEXT;
  if (args.text.length > max) throw new Error("text is too long");
  if (args.text.includes("\0")) throw new Error("text contains NUL");
  if (!args.replace && args.text.length === 0) throw new Error("text must not be empty");
}

function validateScrollArgs(args: ScrollArgs) {
  if (!Number.isFinite(args.dx) || !Number.isFinite(args.dy)) {
    throw new Error("scroll deltas must be finite");
  }
  if (Math.abs(args.dx) > MAX_SCROLL_DELTA || Math.abs(args.dy) > MAX_SCROLL_DELTA) {
    throw new Error("scroll delta is too large");
  }
  if (args.dx === 0 && args.dy === 0) throw new Error("scroll needs a nonzero delta");
  if (!Number.isFinite(args.steps)) throw new Error("scroll steps must be finite");
}

function validateWaitArgs(args: WaitArgs) {
  if (!args.ref && args.text === undefined) throw new Error("wait needs a ref or text");
  const condition = args.condition ?? (args.ref ? "visible" : "text");
  if (condition === "exists" && !args.ref) throw new Error("exists wait needs a ref");
  if (condition === "visible" && !args.ref) throw new Error("visible wait needs a ref");
  if (condition === "text" && args.text === undefined) throw new Error("text wait needs text");
  if (args.text !== undefined) {
    if (args.text.length === 0) throw new Error("wait text must not be empty");
    if (args.text.length > MAX_WAIT_TEXT) throw new Error("wait text is too long");
    if (args.text.includes("\0")) throw new Error("wait text contains NUL");
  }
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 60_000) {
    throw new Error("wait timeout must be an integer from 0 to 60000");
  }
}

function boundedDelay(min: number, max: number, random: () => number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new Error("invalid typing delay");
  }
  const value = random();
  const sample = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return Math.round(min + (max - min) * sample);
}

function boundedSteps(steps: number, dx: number, dy: number): number {
  const requested = Math.round(steps);
  const natural = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / SCROLL_DELTA_PER_STEP);
  return Math.min(MAX_SCROLL_STEPS, Math.max(MIN_SCROLL_STEPS, requested, natural));
}

function smootherstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function normalizeSchedule(schedule: NonNullable<TypeArgs["schedule"]>): NonNullable<TypeArgs["schedule"]> {
  const result: NonNullable<TypeArgs["schedule"]> = [];
  for (let index = 0; index < schedule.length; index += 1) {
    const current = schedule[index]!;
    const next = schedule[index + 1];
    if (
      current.t === "key" &&
      next?.t === "key" &&
      current.ch.length === 1 &&
      next.ch.length === 1 &&
      current.ch.charCodeAt(0) >= 0xd800 &&
      current.ch.charCodeAt(0) <= 0xdbff &&
      next.ch.charCodeAt(0) >= 0xdc00 &&
      next.ch.charCodeAt(0) <= 0xdfff
    ) {
      result.push({
        t: "key",
        ch: current.ch + next.ch,
        delayMs: current.delayMs + next.delayMs,
      });
      index += 1;
    } else {
      result.push(current);
    }
  }
  return result;
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchesProbe(
  probe: AgentPageProbe,
  condition: "exists" | "visible" | "text",
  ref: string | undefined,
  text: string | null,
): boolean {
  if (condition === "exists") return probe.exists;
  if (condition === "visible") return probe.visible;
  const haystack = ref ? probe.refText : probe.documentText;
  return text !== null && normalizeSearchText(haystack).includes(text);
}
