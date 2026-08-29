import { randomBytes } from "node:crypto";
import type { ActorIdentity, DomObservation, FrameEvent, ScreenshotObservation, SessionDescriptor, TabAddress, TabDescriptor } from "@webx/browser-protocol";
import type { NavigationAuthorization } from "../actor/identity.js";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import { ChromeHost, type ChromeHostOptions } from "../chrome/host.js";
import { bindFrameTab, FrameScheduler } from "../frames/scheduler.js";
import { SessionMotor, bindMotorTab, type CoordinateAction, type MouseButton } from "../motor/session-motor.js";
import { DomObservationStore, bindDomTab } from "../observations/dom-store.js";
import { bindObservationTab, ObservationStore } from "../observations/store.js";
import type { OperationContext, OperationRegistry } from "../operations/registry.js";
import { TargetRegistry, type TabRecord } from "../targets/registry.js";

export type DomFallbackAction =
  | { kind: "click" | "doubleClick"; button?: MouseButton }
  | { kind: "hover" }
  | { kind: "type"; text: string; replace?: boolean }
  | { kind: "press"; key: string };

export class BrowserSession {
  private closed = false;
  readonly motor: SessionMotor;
  readonly observations: ObservationStore;
  readonly dom: DomObservationStore;
  readonly frames: FrameScheduler;

  private constructor(
    readonly actor: ActorIdentity,
    readonly browserSessionId: string,
    readonly host: ChromeHost,
    readonly targets: TargetRegistry,
    private readonly operations: OperationRegistry,
    artifacts: BrowserArtifactStore,
    private readonly navigationAuthorization: NavigationAuthorization,
    personaSeed: number,
    motorMinimumPathMs: number,
    observationFreshnessMs: number,
  ) {
    this.motor = new SessionMotor(browserSessionId, personaSeed, motorMinimumPathMs);
    this.observations = new ObservationStore(actor, targets, artifacts, this.motor, { freshnessMs: observationFreshnessMs });
    this.dom = new DomObservationStore(targets);
    this.frames = new FrameScheduler(actor, targets, artifacts, this.motor);
    host.on("exit", this.onHostFailure);
    host.on("disconnect", this.onHostFailure);
    targets.on("tabTerminal", this.onTabTerminal);
    targets.on("tabRegistered", this.onTabRegistered);
  }

  static async create(actor: ActorIdentity, operations: OperationRegistry, artifacts: BrowserArtifactStore, navigationAuthorization: NavigationAuthorization, options: Omit<ChromeHostOptions, "hostId"> & { initialUrl?: string; personaSeed?: number; motorMinimumPathMs?: number; observationFreshnessMs?: number } = {}): Promise<BrowserSession> {
    const browserSessionId = opaqueId("session");
    const { initialUrl, personaSeed, motorMinimumPathMs, observationFreshnessMs, ...hostOptions } = options;
    const host = await ChromeHost.launch({ hostId: browserSessionId, ...hostOptions });
    try {
      const targets = await TargetRegistry.create(browserSessionId, host);
      const session = new BrowserSession(actor, browserSessionId, host, targets, operations, artifacts, navigationAuthorization, personaSeed ?? randomBytes(4).readUInt32BE(), motorMinimumPathMs ?? 0, observationFreshnessMs ?? 3_000);
      const tab = await session.createTab();
      if (initialUrl !== undefined) await session.navigate(session.address(tab), initialUrl, new AbortController().signal);
      return session;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  get controlEpoch(): number { return this.operations.currentEpoch(this.actor, this.browserSessionId); }
  get personaId(): string { return this.motor.personaId; }

  descriptor(): SessionDescriptor {
    return { kind: "session", browserSessionId: this.browserSessionId, controlEpoch: this.controlEpoch, state: this.closed ? "closed" : this.host.connected ? "ready" : "degraded", personaId: this.personaId, cursor: this.motor.state, tabs: this.targets.list(this.controlEpoch) };
  }

  async createTab(url?: string, signal = new AbortController().signal): Promise<TabRecord> {
    this.assertOpen();
    const tab = await this.targets.createTab();
    this.bindTab(tab);
    await this.motor.initializeTab(tab);
    if (url !== undefined) await this.navigate(this.address(tab), url, signal);
    return tab;
  }

  listTabs(): TabDescriptor[] { return this.targets.list(this.controlEpoch); }
  address(tab: TabRecord): TabAddress { return { browserSessionId: this.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch: this.controlEpoch }; }
  resolve(address: TabAddress): TabRecord { this.assertEpoch(address); return this.targets.resolve(address); }

  async observe(address: TabAddress, delivery: "auto" | "inline" | "artifact" = "auto"): Promise<ScreenshotObservation> {
    this.assertEpoch(address);
    return await this.observations.capture(address, delivery);
  }

  async observeDom(address: TabAddress, maxNodes: number): Promise<DomObservation> {
    this.assertEpoch(address);
    return await this.dom.observe(address, maxNodes);
  }

  async coordinate(address: TabAddress, observationId: string, action: CoordinateAction, context: OperationContext, riskPolicy: "normal" | "newer-observation" | "local-region" = "normal"): Promise<unknown> {
    const tab = this.resolve(address);
    const point = coordinatePoint(action);
    await this.observations.guard(address, observationId, point, riskPolicy);
    return await this.motor.coordinate(tab, action, context, async () => {
      const irreversiblePoint = coordinatePoint(action);
      this.assertEpoch(address);
      await this.observations.guard(address, observationId, irreversiblePoint, riskPolicy);
    });
  }

  async domAction(address: TabAddress, observationId: string, handle: string, action: DomFallbackAction, context: OperationContext): Promise<void> {
    this.assertEpoch(address);
    const resolved = await this.dom.resolve(address, observationId, handle);
    const revalidate = async (): Promise<void> => { const current = await this.dom.resolve(address, observationId, handle); if (Math.abs(current.center.x - resolved.center.x) > 2 || Math.abs(current.center.y - resolved.center.y) > 2) throw new Error("DOM handle moved before dispatch."); };
    if (action.kind === "hover") { await this.motor.coordinate(resolved.tab, { kind: "hover", to: resolved.center }, context, revalidate); return; }
    if (action.kind === "click" || action.kind === "doubleClick") { await this.motor.coordinate(resolved.tab, { kind: action.kind, at: resolved.center, button: action.button ?? "left" }, context, revalidate); return; }
    if (action.kind === "press") { await this.motor.pressKey(resolved.tab, action.key, context); return; }
    if (action.kind !== "type") throw new Error("Unsupported DOM fallback action.");
    await this.motor.coordinate(resolved.tab, { kind: "click", at: resolved.center, button: "left" }, context, revalidate);
    await this.motor.typeText(resolved.tab, action.text, action.replace ?? false, context);
  }

  async typeText(address: TabAddress, text: string, replace: boolean, context: OperationContext): Promise<void> { await this.motor.typeText(this.resolve(address), text, replace, context); }
  async pressKey(address: TabAddress, key: string, context: OperationContext): Promise<void> { await this.motor.pressKey(this.resolve(address), key, context); }

  async navigate(address: TabAddress, rawUrl: string, signal: AbortSignal, markDispatched?: () => void): Promise<void> {
    const tab = this.resolve(address);
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Navigation URL is not HTTP(S).");
    await this.navigationAuthorization.authorize(this.actor, url, signal);
    const eventController = new AbortController();
    const abort = (): void => eventController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const loaded = this.host.cdp.waitForEvent("Page.loadEventFired", (event) => event.sessionId === tab.cdpSessionId, { timeoutMs: 15_000, signal: eventController.signal });
    try {
      markDispatched?.();
      const result = await this.host.cdp.send<{ errorText?: string }>("Page.navigate", { url: url.href }, tab.cdpSessionId, { timeoutMs: 10_000, signal });
      if (result.errorText) throw new Error("Navigation failed.");
      await loaded;
      await this.motor.initializeTab(tab);
    } catch (error) { eventController.abort(); await loaded.catch(() => undefined); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }

  subscribeFrames(address: TabAddress, interest: "idle" | "selected" = "selected"): void { this.assertEpoch(address); this.frames.subscribe(address, interest); }
  unsubscribeFrames(address: TabAddress): void { this.frames.unsubscribe(address); }
  onFrame(listener: (frame: FrameEvent) => void): void { this.frames.on("frame", listener); }
  offFrame(listener: (frame: FrameEvent) => void): void { this.frames.off("frame", listener); }

  incrementControlEpoch(): number { return this.operations.incrementEpoch(this.actor, this.browserSessionId); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.frames.close();
    const tab = this.targets.list(this.controlEpoch)[0];
    const record = tab ? this.targets.getById(tab.address.tabId) : undefined;
    await this.motor.releaseAll(record);
    await this.targets.close();
    await this.host.close();
  }

  private bindTab(tab: TabRecord): void {
    bindMotorTab(tab, this.host.cdp);
    bindObservationTab(tab, this.host.cdp);
    bindDomTab(tab, this.host.cdp);
    bindFrameTab(tab, this.host.cdp);
  }

  private assertEpoch(address: TabAddress): void {
    this.assertOpen();
    if (address.browserSessionId !== this.browserSessionId || address.controlEpoch !== this.controlEpoch) throw new Error("Control epoch or browser session is stale.");
  }
  private assertOpen(): void { if (this.closed || !this.host.running || !this.host.connected) throw new Error("Browser session is unavailable."); }

  private readonly onHostFailure = (): void => { if (!this.closed) this.operations.failSession(this.actor, this.browserSessionId); void this.motor.releaseAll(); };
  private readonly onTabRegistered = (tab: TabRecord): void => { this.bindTab(tab); void this.motor.initializeTab(tab).catch(() => undefined); };
  private readonly onTabTerminal = ({ tabId }: { tabId: string }): void => {
    this.observations.invalidateTab(tabId); this.dom.invalidateTab(tabId); this.frames.stop(tabId);
    this.operations.failTab(this.actor, this.browserSessionId, tabId);
  };
}

function coordinatePoint(action: CoordinateAction): { x: number; y: number } {
  switch (action.kind) {
    case "move": case "hover": return action.to;
    case "drag": return action.from;
    case "click": case "doubleClick": case "wheel": return action.at;
  }
}
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
