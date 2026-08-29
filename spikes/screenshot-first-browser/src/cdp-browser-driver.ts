import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { generateMove, sampleDwellMs, samplePressMs } from "./agentcursor/path-engine/index.js";
import type { CursorSample, Point } from "./agentcursor/protocol.js";
import { createPersona, type Persona } from "./agentcursor/persona/index.js";
import type { CdpEvent } from "./cdp.js";
import type { ChromeHost } from "./chrome-host.js";
import { CURSOR_OVERLAY_INSTALL } from "./cursor-overlay.js";
import {
  type ActionTimings,
  type AgentSessionId,
  type DomFallbackNode,
  type DomFallbackObservation,
  type Observation,
  type SessionStatus,
  type TargetIdentity,
  OwnershipError,
  StaleObservationError,
} from "./types.js";

interface RuntimeResult<T> {
  result: { type: string; value?: T; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface PageLayout {
  url: string;
  title: string;
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

interface AxValue { value?: string | number | boolean }
interface AxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value: AxValue }>;
}

export interface CoordinateAction {
  agentSessionId: AgentSessionId;
  targetId: string;
  observationId: string;
  x: number;
  y: number;
}

export interface DriverOptions {
  freshnessMs?: number;
  personaSeed: number;
}

export class CdpBrowserDriver {
  readonly identity: TargetIdentity;
  readonly persona: Persona;
  private readonly observations = new Map<string, Observation>();
  private readonly freshnessMs: number;
  private cursor: Point = { x: 80, y: 80 };
  private pathSequence = 0;
  private sampleCount = 0;
  private frameSequence = 0;
  private documentGeneration = 1;
  private viewportGeneration = 1;
  private priorViewport: Pick<PageLayout, "width" | "height" | "dpr"> | null = null;
  private latestObservation: Observation | null = null;
  private closed = false;

  private constructor(
    private readonly host: ChromeHost,
    identity: TargetIdentity,
    options: DriverOptions,
  ) {
    this.identity = identity;
    this.persona = createPersona(options.personaSeed);
    this.freshnessMs = options.freshnessMs ?? 2_500;
    host.cdp.on("event", this.onCdpEvent);
  }

  static async create(
    host: ChromeHost,
    agentSessionId: AgentSessionId,
    options: DriverOptions,
  ): Promise<CdpBrowserDriver> {
    const created = await host.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const discovered = await host.cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
    if (!discovered.targetInfos.some((target) => target.targetId === created.targetId && target.type === "page")) {
      throw new Error(`Created target was not discoverable through CDP: ${created.targetId}`);
    }
    const attached = await host.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    const identity: TargetIdentity = {
      agentSessionId,
      browserHostId: host.hostId,
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
    };
    const driver = new CdpBrowserDriver(host, identity, options);
    await Promise.all([
      driver.command("Page.enable"),
      driver.command("Runtime.enable"),
      driver.command("DOM.enable"),
      driver.command("Accessibility.enable"),
    ]);
    await driver.command("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR_OVERLAY_INSTALL });
    await driver.installOverlay();
    return driver;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.host.cdp.off("event", this.onCdpEvent);
    try {
      await this.host.cdp.send("Target.closeTarget", { targetId: this.identity.targetId });
    } catch {
      // Host shutdown can close the target first.
    }
  }

  async navigate(owner: AgentSessionId, targetId: string, url: string): Promise<void> {
    this.assertOwner(owner, targetId);
    const loaded = this.host.cdp.waitForEvent(
      "Page.loadEventFired",
      (event) => event.sessionId === this.identity.cdpSessionId,
      10_000,
    );
    const result = await this.command<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await loaded;
    await this.installOverlay();
  }

  async screenshot(owner: AgentSessionId, targetId: string): Promise<Observation> {
    this.assertOwner(owner, targetId);
    await this.installOverlay();
    const layout = await this.layout();
    if (
      this.priorViewport &&
      (layout.width !== this.priorViewport.width ||
        layout.height !== this.priorViewport.height ||
        layout.dpr !== this.priorViewport.dpr)
    ) {
      this.viewportGeneration++;
    }
    this.priorViewport = { width: layout.width, height: layout.height, dpr: layout.dpr };
    const result = await this.command<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshot = Buffer.from(result.data, "base64");
    const capturedAtMonotonicMs = performance.now();
    const observation: Observation = {
      ...this.identity,
      observationId: `${this.identity.agentSessionId}:${this.identity.targetId}:${randomUUID()}`,
      url: layout.url,
      title: layout.title,
      capturedAt: new Date().toISOString(),
      capturedAtMonotonicMs,
      viewport: { width: layout.width, height: layout.height },
      devicePixelRatio: layout.dpr,
      scroll: { x: layout.scrollX, y: layout.scrollY },
      mediaType: "image/png",
      screenshot,
      screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
      frameSequence: ++this.frameSequence,
      documentGeneration: this.documentGeneration,
      viewportGeneration: this.viewportGeneration,
    };
    this.observations.set(observation.observationId, observation);
    this.latestObservation = observation;
    while (this.observations.size > 24) {
      const first = this.observations.keys().next().value as string | undefined;
      if (first) this.observations.delete(first);
      else break;
    }
    return observation;
  }

  async move(action: CoordinateAction): Promise<ActionTimings> {
    const observation = await this.validateCoordinate(action);
    return await this.moveValidated(observation, { x: action.x, y: action.y }, 24);
  }

  async hover(action: CoordinateAction): Promise<ActionTimings> {
    return await this.move(action);
  }

  async click(action: CoordinateAction, options: { double?: boolean; button?: "left" | "middle" | "right" } = {}): Promise<ActionTimings> {
    const started = performance.now();
    const observation = await this.validateCoordinate(action);
    const move = await this.moveValidated(observation, { x: action.x, y: action.y }, 24);
    const afterPath = performance.now();
    const traits = this.persona.traits();
    await sleep(sampleDwellMs(this.persona.rng, traits.dwellScale));
    const button = options.button ?? "left";
    const buttonCode = button === "left" ? 1 : button === "right" ? 2 : 4;
    const clicks = options.double ? 2 : 1;
    for (let clickCount = 1; clickCount <= clicks; clickCount++) {
      await this.command("Input.dispatchMouseEvent", {
        type: "mousePressed", x: action.x, y: action.y, button, buttons: buttonCode, clickCount,
      });
      await sleep(samplePressMs(this.persona.rng, traits.pressScale));
      await this.command("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: action.x, y: action.y, button, buttons: 0, clickCount,
      });
      if (clickCount < clicks) await sleep(70);
    }
    return {
      pathDurationMs: move.pathDurationMs,
      pathWallMs: move.pathWallMs,
      completionAfterPathMs: performance.now() - afterPath,
      totalMs: performance.now() - started,
    };
  }

  async doubleClick(action: CoordinateAction): Promise<ActionTimings> {
    return await this.click(action, { double: true });
  }

  async drag(
    owner: AgentSessionId,
    targetId: string,
    observationId: string,
    from: Point,
    to: Point,
  ): Promise<ActionTimings> {
    const observation = await this.validateCoordinate({ agentSessionId: owner, targetId, observationId, ...from });
    await this.moveValidated(observation, from, 24);
    const started = performance.now();
    const samples = this.path(from, to, 24);
    const nominal = samples.at(-1)?.t ?? 0;
    await this.command("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
    await this.replay(samples, 1);
    await this.command("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
    this.cursor = to;
    return { pathDurationMs: nominal, pathWallMs: performance.now() - started, completionAfterPathMs: 0, totalMs: performance.now() - started };
  }

  async wheel(action: CoordinateAction, deltaX: number, deltaY: number): Promise<void> {
    await this.validateCoordinate(action);
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: action.x,
      y: action.y,
      deltaX,
      deltaY,
    });
  }

  async typeText(owner: AgentSessionId, targetId: string, text: string, replace = false): Promise<void> {
    this.assertOwner(owner, targetId);
    if (replace) {
      await this.command("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
      await this.command("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    }
    this.persona.tick();
    for (const operation of this.persona.keySchedule(text)) {
      await sleep(operation.delayMs);
      if (operation.t === "back") {
        await this.pressKey(owner, targetId, "Backspace");
      } else {
        await this.command("Input.insertText", { text: operation.ch });
      }
    }
  }

  async pressKey(owner: AgentSessionId, targetId: string, key: string): Promise<void> {
    this.assertOwner(owner, targetId);
    const code = keyCode(key);
    await this.command("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode(key) });
    await this.command("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode(key) });
  }

  async domFallback(owner: AgentSessionId, targetId: string, limit = 80): Promise<DomFallbackObservation> {
    this.assertOwner(owner, targetId);
    const tree = await this.command<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", { depth: 12 });
    const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
    const candidates = tree.nodes.filter((node) => !node.ignored && interactiveRoles.has(String(node.role?.value ?? "")));
    const nodes: DomFallbackNode[] = [];
    for (const node of candidates.slice(0, limit)) {
      const role = String(node.role?.value ?? "unknown");
      const name = String(node.name?.value ?? "");
      const state: Record<string, string | number | boolean> = {};
      for (const property of node.properties ?? []) {
        if (property.value.value !== undefined && ["checked", "disabled", "expanded", "focused", "required", "selected"].includes(property.name)) {
          state[property.name] = property.value.value;
        }
      }
      const bounds = node.backendDOMNodeId ? await this.boundsFor(node.backendDOMNodeId) : undefined;
      nodes.push({
        handle: `${this.documentGeneration}:${node.backendDOMNodeId ?? node.nodeId}`,
        role,
        name,
        ...(node.value?.value !== undefined ? { value: String(node.value.value) } : {}),
        state,
        ...(bounds ? { bounds } : {}),
        locatorDescription: `AX role=${JSON.stringify(role)} name=${JSON.stringify(name)} backendNodeId=${node.backendDOMNodeId ?? "none"}`,
      });
    }
    return {
      ...this.identity,
      observedAt: new Date().toISOString(),
      documentGeneration: this.documentGeneration,
      nodes,
      truncated: candidates.length > limit,
    };
  }

  async evaluate<T>(owner: AgentSessionId, targetId: string, expression: string): Promise<T> {
    this.assertOwner(owner, targetId);
    return await this.evaluateUnchecked<T>(expression);
  }

  async cdpRoundTrip(owner: AgentSessionId, targetId: string): Promise<number> {
    this.assertOwner(owner, targetId);
    const started = performance.now();
    await this.command("Runtime.evaluate", { expression: "1", returnByValue: true });
    return performance.now() - started;
  }

  status(): SessionStatus {
    return {
      agentSessionId: this.identity.agentSessionId,
      browserHostId: this.identity.browserHostId,
      connected: this.host.connected,
      processRunning: this.host.running,
      targetId: this.identity.targetId,
      url: this.latestObservation?.url ?? "about:blank",
      latestFrameSequence: this.latestObservation?.frameSequence ?? 0,
      lastFrameAt: this.latestObservation?.capturedAt ?? null,
      cursor: { ...this.cursor, personaSeed: this.persona.seed, pathSequence: this.pathSequence },
    };
  }

  latestFrame(): Observation | null {
    return this.latestObservation;
  }

  private readonly onCdpEvent = (event: CdpEvent): void => {
    if (event.sessionId !== this.identity.cdpSessionId) return;
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame as { parentId?: string } | undefined;
      if (frame && !frame.parentId) {
        this.documentGeneration++;
        this.observations.clear();
      }
    }
  };

  private assertOwner(owner: AgentSessionId, targetId: string): void {
    if (owner !== this.identity.agentSessionId || targetId !== this.identity.targetId) {
      throw new OwnershipError(
        `Operation owner/target ${owner}/${targetId} does not match ${this.identity.agentSessionId}/${this.identity.targetId}`,
      );
    }
    if (this.closed || !this.host.connected) throw new Error("Browser driver is disconnected");
  }

  private async validateCoordinate(action: CoordinateAction): Promise<Observation> {
    this.assertOwner(action.agentSessionId, action.targetId);
    const observation = this.observations.get(action.observationId);
    if (!observation) throw new StaleObservationError("Unknown or evicted observation");
    if (
      observation.agentSessionId !== action.agentSessionId ||
      observation.targetId !== action.targetId ||
      observation.documentGeneration !== this.documentGeneration
    ) {
      throw new StaleObservationError("Observation identity or document generation changed");
    }
    if (performance.now() - observation.capturedAtMonotonicMs > this.freshnessMs) {
      throw new StaleObservationError(`Observation is older than ${this.freshnessMs} ms`);
    }
    const layout = await this.layout();
    if (
      layout.width !== observation.viewport.width ||
      layout.height !== observation.viewport.height ||
      layout.dpr !== observation.devicePixelRatio ||
      Math.abs(layout.scrollX - observation.scroll.x) > 2 ||
      Math.abs(layout.scrollY - observation.scroll.y) > 2
    ) {
      throw new StaleObservationError("Viewport, scale, or scroll position changed");
    }
    if (action.x < 0 || action.y < 0 || action.x >= layout.width || action.y >= layout.height) {
      throw new StaleObservationError("Coordinate is outside the observed viewport");
    }
    return observation;
  }

  private async moveValidated(observation: Observation, to: Point, targetWidth: number): Promise<ActionTimings> {
    if (observation.documentGeneration !== this.documentGeneration) throw new StaleObservationError("Document changed before movement");
    this.persona.tick();
    const samples = this.path(this.cursor, to, targetWidth);
    const nominal = samples.at(-1)?.t ?? 0;
    const started = performance.now();
    await this.replay(samples, 0);
    this.cursor = to;
    return {
      pathDurationMs: nominal,
      pathWallMs: performance.now() - started,
      completionAfterPathMs: 0,
      totalMs: performance.now() - started,
    };
  }

  private path(from: Point, to: Point, targetWidth: number): CursorSample[] {
    const traits = this.persona.traits();
    return generateMove(from, to, {
      rng: this.persona.rng,
      targetWidth,
      speedFactor: traits.speedFactor,
      curviness: traits.curviness,
      jitterPx: traits.jitterPx,
      overshootProb: traits.overshootProb,
      overshootMag: traits.overshootMag,
      handedness: traits.handedness,
    });
  }

  private async replay(samples: CursorSample[], buttons: number): Promise<void> {
    this.pathSequence++;
    const sequence = this.pathSequence;
    const started = performance.now();
    for (const sample of samples) {
      const wait = sample.t - (performance.now() - started);
      if (wait > 0) await sleep(wait);
      this.sampleCount++;
      await Promise.all([
        this.command("Input.dispatchMouseEvent", {
          type: "mouseMoved", x: sample.x, y: sample.y, button: "none", buttons,
        }),
        this.evaluateUnchecked(`globalThis.__piSetCursor?.(${sample.x},${sample.y},${sequence},${this.sampleCount})`),
      ]);
    }
  }

  private async boundsFor(backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    try {
      const box = await this.command<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId });
      const quad = box.model.border;
      const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value): value is number => typeof value === "number");
      const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value): value is number => typeof value === "number");
      if (xs.length !== 4 || ys.length !== 4) return undefined;
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    } catch {
      return undefined;
    }
  }

  private async installOverlay(): Promise<void> {
    await this.evaluateUnchecked(CURSOR_OVERLAY_INSTALL);
    await this.evaluateUnchecked(`globalThis.__piSetCursor?.(${this.cursor.x},${this.cursor.y},${this.pathSequence},${this.sampleCount})`);
  }

  private async layout(): Promise<PageLayout> {
    return await this.evaluateUnchecked<PageLayout>(`({
      url: location.href,
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scrollX,
      scrollY
    })`);
  }

  private async evaluateUnchecked<T>(expression: string): Promise<T> {
    const result = await this.command<RuntimeResult<T>>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime evaluation failed");
    }
    return result.result.value as T;
  }

  private async command<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return await this.host.cdp.send<T>(method, params, this.identity.cdpSessionId);
  }
}

function keyCode(key: string): string {
  const fixed: Record<string, string> = {
    Backspace: "Backspace", Enter: "Enter", Escape: "Escape", Tab: "Tab",
    ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp",
    Home: "Home", End: "End", PageDown: "PageDown", PageUp: "PageUp", " ": "Space",
  };
  return fixed[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key);
}

function virtualKeyCode(key: string): number {
  const fixed: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  return fixed[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
