import type { LocatorMatch, LocatorSpec, Point, Rect } from "agentcursor" with { "resolution-mode": "import" };
import type { AgentElementState, AgentElementTarget, AgentPageObserver } from "./types";
import { parseLocator } from "./locator";

export type TargetPurpose = "pointer" | "editable";
export interface PreparedTarget {
  target: AgentElementTarget;
  state: AgentElementState;
  purpose: TargetPurpose;
  committed: boolean;
  scroll: boolean;
}

export class TargetPreparation {
  constructor(
    private readonly observer: AgentPageObserver,
    readonly documentId: string,
    private readonly guard: () => void,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async resolveLocator(spec: LocatorSpec, timeoutMs: number, scrollIntoView = false): Promise<LocatorMatch> {
    const target = { locator: parseLocator(spec) };
    const deadline = this.now() + boundedTimeout(timeoutMs);
    while (true) {
      const query = await this.query(target.locator);
      const state = query.matches[0];
      if (state) {
        const current = scrollIntoView ? await this.state(state.ref, true) : state;
        if (current) return { handle: current.ref, rect: current.bounds, count: query.count, visible: current.visible, text: current.text };
      }
      if (this.now() >= deadline) return { handle: "", rect: { x: 0, y: 0, width: 0, height: 0 }, count: 0, visible: false, text: "" };
      await this.pause(deadline);
    }
  }

  async prepare(target: AgentElementTarget, purpose: TargetPurpose = "pointer", timeoutMs = 5_000, scroll = true): Promise<PreparedTarget> {
    if ("locator" in target) target = { locator: parseLocator(target.locator) };
    const deadline = this.now() + boundedTimeout(timeoutMs);
    let previous: AgentElementState | null = null;
    let reason = "not attached";
    while (true) {
      const selected = "ref" in target ? target.ref : await this.uniqueRef(target.locator);
      const state = selected ? await this.state(selected, scroll) : null;
      if ("ref" in target && !state) throw new Error("stale or unknown ref");
      reason = state ? readiness(state, purpose) : "not attached";
      if (state && !reason && previous?.ref === state.ref && sameRect(previous.rect, state.rect)) {
        return { target, state, purpose, committed: false, scroll };
      }
      previous = state;
      if (this.now() >= deadline) throw new Error(`target preparation timed out: ${reason || "not stable"}`);
      await this.pause(deadline);
    }
  }

  async check(target: PreparedTarget, point: Point, focused = false): Promise<boolean> {
    if ("locator" in target.target && await this.uniqueRef(target.target.locator) !== target.state.ref) return false;
    const state = await this.state(target.state.ref, false, point);
    if (!state || readiness(state, target.purpose) || !sameRect(state.rect, target.state.rect) || (focused && !state.focused)) return false;
    target.state = state;
    return true;
  }

  async refresh(target: PreparedTarget, point: Point): Promise<Point> {
    if (target.committed) throw new Error("target changed after input; action was not retried");
    const old = target.state.rect;
    const x = old.width > 0 ? Math.max(0.1, Math.min(0.9, (point.x - old.x) / old.width)) : 0.5;
    const y = old.height > 0 ? Math.max(0.1, Math.min(0.9, (point.y - old.y) / old.height)) : 0.5;
    const prepared = await this.prepare(target.target, target.purpose, 1_000, target.scroll);
    target.state = prepared.state;
    return { x: prepared.state.rect.x + prepared.state.rect.width * x, y: prepared.state.rect.y + prepared.state.rect.height * y };
  }

  async assertFocused(target: PreparedTarget): Promise<void> {
    if ("locator" in target.target && await this.uniqueRef(target.target.locator) !== target.state.ref) {
      throw new Error("editable locator changed after input; action was not retried");
    }
    const state = await this.state(target.state.ref, false);
    if (!state || !state.visible || !state.enabled || !state.editable || !state.focused) {
      throw new Error("editable target or focus changed after input; action was not retried");
    }
  }

  private async uniqueRef(spec: LocatorSpec): Promise<string | null> {
    const query = await this.query(spec);
    if (query.count > 1) {
      const candidates = query.matches.map(({ ref, tag, role, name }) => ({ ref, tag, role, name: name.slice(0, 120) }));
      throw new Error(`ambiguous locator (${query.count} matches); narrow the scope or use nth: ${JSON.stringify(candidates)}`);
    }
    return query.matches[0]?.ref ?? null;
  }

  private async query(spec: LocatorSpec) {
    this.guard();
    const query = await this.observer.queryLocator(spec);
    this.guard();
    if (query.documentId !== this.documentId) throw new Error("page changed since observation");
    return query;
  }

  private async state(ref: string, scroll: boolean, point?: Point) {
    this.guard();
    const result = await this.observer.elementState(ref, { documentId: this.documentId, scroll, point });
    this.guard();
    if (result.documentId !== this.documentId) throw new Error("page changed since observation");
    return result.state;
  }

  private async pause(deadline: number) {
    this.guard();
    await this.sleep(Math.min(80, Math.max(0, deadline - this.now())));
    this.guard();
  }
}

export function sameRect(a: Rect, b: Rect): boolean {
  return ["x", "y", "width", "height"].every(key => Math.abs(a[key as keyof Rect] - b[key as keyof Rect]) <= 0.5);
}

export function readiness(state: AgentElementState, purpose: TargetPurpose): string {
  if (!state.visible || state.rect.width <= 0 || state.rect.height <= 0) return "not visible";
  if (!state.enabled) return "disabled";
  if (purpose === "editable" && !state.editable) return "not editable";
  if (!state.hit) return "obstructed";
  return "";
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) throw new Error("locator timeout must be an integer from 0 to 60000");
  return value;
}
