import type {
  BrowserDriver,
  CursorSample,
  DeliveryMode,
  Point,
} from "agentcursor" with {
  "resolution-mode": "import",
};

import type { AgentBrowserTarget, AgentPageObserver } from "./types";

type ClickArgs = Parameters<BrowserDriver["click"]>[0];
type TypeArgs = Parameters<BrowserDriver["type"]>[0];
type ScrollArgs = Parameters<BrowserDriver["scroll"]>[0];
type WaitForArgs = Parameters<BrowserDriver["waitFor"]>[0];
type HoverArgs = Parameters<BrowserDriver["hover"]>[0];
type DragArgs = Parameters<BrowserDriver["drag"]>[0];
type ResolveLocatorArgs = Parameters<BrowserDriver["resolveLocator"]>;

export interface TerminalBrowserDriverOptions {
  sleep?: (ms: number) => Promise<void>;
}

export class TerminalBrowserDriver implements BrowserDriver {
  private readonly sleep: (ms: number) => Promise<void>;
  private lastPosition: Point | null = null;

  constructor(
    private readonly target: AgentBrowserTarget,
    private readonly observer: AgentPageObserver,
    options: TerminalBrowserDriverOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  snapshot(maxElements: number, includeText: boolean) {
    return this.observer.observe(maxElements, includeText).then(({ snapshot }) => snapshot);
  }

  async cursorState(): Promise<Point> {
    if (this.lastPosition) return { ...this.lastPosition };
    const viewport = this.target.viewportSize();
    return { x: viewport.width / 2, y: viewport.height / 2 };
  }

  async move(samples: CursorSample[], mode: DeliveryMode): Promise<void> {
    this.assertContentMode(mode);
    await this.replayMove(samples);
    const last = samples.at(-1);
    if (last) this.lastPosition = { x: last.x, y: last.y };
  }

  async click(args: ClickArgs): Promise<void> {
    this.assertContentMode(args.mode);
    try {
      await this.replayMove(args.samples);
      if (args.preClickDwellMs > 0) await this.sleep(args.preClickDwellMs);
      await this.clickCycle(args.target, args.button, args.pressMs);
      if (args.dblclick) await this.clickCycle(args.target, args.button, args.pressMs);
      this.lastPosition = { ...args.target };
    } catch (error) {
      try {
        this.target.releaseAgentPointer();
      } catch {}
      throw error;
    }
  }

  ensureVisible(ref?: string, _point?: Point) {
    return ref ? this.observer.ensureVisible(ref) : Promise.resolve(null);
  }

  async type(_args: TypeArgs): Promise<void> {
    this.unsupported("type");
  }

  async scroll(_args: ScrollArgs): Promise<void> {
    this.unsupported("scroll");
  }

  async navigate(_url: string): Promise<void> {
    this.unsupported("navigate");
  }

  async getUrl(): Promise<string> {
    this.unsupported("getUrl");
  }

  async waitFor(_args: WaitForArgs): Promise<boolean> {
    this.unsupported("waitFor");
  }

  async screenshot(_format?: "png" | "jpeg"): Promise<string> {
    this.unsupported("screenshot");
  }

  async hover(_opts: HoverArgs): Promise<void> {
    this.unsupported("hover");
  }

  async drag(_args: DragArgs): Promise<void> {
    this.unsupported("drag");
  }

  async pressKey(_key: string, _mode: DeliveryMode): Promise<void> {
    this.unsupported("pressKey");
  }

  async resolveLocator(
    _spec: ResolveLocatorArgs[0],
    _opts: ResolveLocatorArgs[1],
  ): Promise<Awaited<ReturnType<BrowserDriver["resolveLocator"]>>> {
    this.unsupported("resolveLocator");
  }

  private async replayMove(samples: CursorSample[]): Promise<void> {
    let previousAt = 0;
    for (const sample of samples) {
      const at = Number.isFinite(sample.t) ? Math.max(previousAt, sample.t) : previousAt;
      const delay = at - previousAt;
      if (delay > 0) await this.sleep(delay);
      this.target.agentPointer({ kind: "move", x: sample.x, y: sample.y });
      previousAt = at;
    }
  }

  private async clickCycle(point: Point, button: ClickArgs["button"], pressMs: number) {
    this.target.agentPointer({ kind: "down", x: point.x, y: point.y, button });
    try {
      if (pressMs > 0) await this.sleep(pressMs);
    } finally {
      this.target.agentPointer({ kind: "up", x: point.x, y: point.y, button });
    }
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
