import { randomBytes } from "node:crypto";
import { BrowserProtocolError, type ActorIdentity, type DomObservation, type FrameEvent, type ScreenshotObservation, type SessionDescriptor, type TabAddress, type TabDescriptor } from "@webx/browser-protocol";
import type { NavigationAuthorization, NavigationAuthorizationContext } from "../actor/identity.js";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import { ChromeHost, type ChromeHostOptions } from "../chrome/host.js";
import { bindFrameTab, FrameScheduler } from "../frames/scheduler.js";
import { SessionMotor, bindMotorTab, type CoordinateAction, type MouseButton } from "../motor/session-motor.js";
import { DomObservationStore, bindDomTab } from "../observations/dom-store.js";
import { bindObservationTab, ObservationStore } from "../observations/store.js";
import type { OperationContext, OperationRegistry } from "../operations/registry.js";
import { TargetRegistry, type TabRecord, type TerminalTabEvent } from "../targets/registry.js";

export type DomFallbackAction =
  | { kind: "click" | "doubleClick"; button?: MouseButton }
  | { kind: "hover" }
  | { kind: "type"; text: string; replace?: boolean }
  | { kind: "press"; key: string };

export class BrowserSession {
  private closeState: "open" | "closing" | "closed" | "cleanup-failed" = "open";
  private closePromise: Promise<void> | undefined;
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
    private readonly artifacts: BrowserArtifactStore,
    private readonly navigationAuthorization: NavigationAuthorization,
    personaSeed: number,
    motorMinimumPathMs: number,
    observationFreshnessMs: number,
  ) {
    this.motor = new SessionMotor(browserSessionId, personaSeed, motorMinimumPathMs);
    this.observations = new ObservationStore(actor, targets, artifacts, this.motor, { freshnessMs: observationFreshnessMs, currentEpoch: () => this.controlEpoch });
    this.dom = new DomObservationStore(targets);
    this.frames = new FrameScheduler(actor, targets, artifacts, this.motor, () => this.controlEpoch);
    host.on("exit", this.onHostExit);
    host.on("disconnect", this.onHostDisconnect);
    targets.on("tabTerminal", this.onTabTerminal);
    targets.on("tabRegistered", this.onTabRegistered);
  }

  static async create(actor: ActorIdentity, operations: OperationRegistry, artifacts: BrowserArtifactStore, navigationAuthorization: NavigationAuthorization, options: Omit<ChromeHostOptions, "hostId"> & { initialUrl?: string; initialNavigationContext?: NavigationAuthorizationContext; personaSeed?: number; motorMinimumPathMs?: number; observationFreshnessMs?: number } = {}, signal?: AbortSignal, markProcessDispatched?: () => void): Promise<BrowserSession> {
    signal?.throwIfAborted();
    const browserSessionId = opaqueId("session");
    const { initialUrl, initialNavigationContext, personaSeed, motorMinimumPathMs, observationFreshnessMs, ...hostOptions } = options;
    const host = await ChromeHost.launch({ hostId: browserSessionId, ...hostOptions }, signal, markProcessDispatched);
    try {
      signal?.throwIfAborted();
      const targets = await TargetRegistry.create(browserSessionId, host);
      const session = new BrowserSession(actor, browserSessionId, host, targets, operations, artifacts, navigationAuthorization, personaSeed ?? randomBytes(4).readUInt32BE(), motorMinimumPathMs ?? 0, observationFreshnessMs ?? 3_000);
      const tab = await session.createTab(undefined, signal);
      if (initialUrl !== undefined) await session.navigate(session.address(tab), initialUrl, signal ?? new AbortController().signal, undefined, initialNavigationContext ?? { operationId: "session.create" });
      return session;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  get controlEpoch(): number { return this.operations.currentEpoch(this.actor, this.browserSessionId); }
  get personaId(): string { return this.motor.personaId; }

  descriptor(): SessionDescriptor {
    return { kind: "session", browserSessionId: this.browserSessionId, controlEpoch: this.controlEpoch, state: this.closeState === "open" ? this.host.connected ? "ready" : "degraded" : "closed", personaId: this.personaId, cursor: this.motor.state, tabs: this.targets.list(this.controlEpoch) };
  }

  async createTab(url?: string, signal = new AbortController().signal, markDispatched?: () => void, navigationContext: NavigationAuthorizationContext = { operationId: "tab.create" }): Promise<TabRecord> {
    this.assertOpen();
    const tab = await this.targets.createTab("about:blank", { signal, ...(markDispatched ? { markDispatched } : {}) });
    try {
      this.bindTab(tab);
      await this.motor.initializeTab(tab);
      signal.throwIfAborted();
      if (url !== undefined) await this.navigate(this.address(tab), url, signal, undefined, navigationContext);
      signal.throwIfAborted();
      return tab;
    } catch (error) {
      await this.targets.rollbackRegisteredTab(tab);
      throw error;
    }
  }

  listTabs(): TabDescriptor[] { return this.targets.list(this.controlEpoch); }
  address(tab: TabRecord): TabAddress { return { browserSessionId: this.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch: this.controlEpoch }; }
  resolve(address: TabAddress): TabRecord { this.assertEpoch(address); return this.targets.resolve(address); }

  async observe(address: TabAddress, delivery: "auto" | "inline" | "artifact" = "auto", signal?: AbortSignal): Promise<ScreenshotObservation> {
    this.assertEpoch(address);
    return await this.observations.capture(address, delivery, signal);
  }

  async observeDom(address: TabAddress, maxNodes: number, signal?: AbortSignal): Promise<DomObservation> {
    this.assertEpoch(address);
    return await this.dom.observe(address, maxNodes, signal);
  }

  async coordinate(address: TabAddress, observationId: string, action: CoordinateAction, context: OperationContext, riskPolicy: "normal" | "newer-observation" | "local-region" = "normal", coordinateSpace: "imagePixels" | "cssViewport" = "imagePixels"): Promise<unknown> {
    const tab = this.resolve(address);
    const converted = convertCoordinateAction(action, (point) => this.observations.convertPoint(address, observationId, point, coordinateSpace));
    const point = coordinatePoint(converted);
    await this.observations.guard(address, observationId, point, riskPolicy, context.signal);
    return await this.motor.coordinate(tab, converted, context, async () => {
      const irreversiblePoint = coordinatePoint(converted);
      this.assertEpoch(address);
      await this.observations.guard(address, observationId, irreversiblePoint, riskPolicy, context.signal);
    });
  }

  async domAction(address: TabAddress, observationId: string, handle: string, action: DomFallbackAction, context: OperationContext): Promise<void> {
    this.assertEpoch(address);
    const resolved = await this.dom.resolve(address, observationId, handle, context.signal);
    context.checkpoint();
    const revalidate = async (): Promise<void> => {
      const current = await this.dom.resolve(address, observationId, handle, context.signal);
      context.checkpoint();
      assertDomHandleUnmoved(resolved.center, current.center);
    };
    if (action.kind === "hover") { await this.motor.coordinate(resolved.tab, { kind: "hover", to: resolved.center }, context, revalidate); return; }
    if (action.kind === "click" || action.kind === "doubleClick") { await this.motor.coordinate(resolved.tab, { kind: action.kind, at: resolved.center, button: action.button ?? "left" }, context, revalidate); return; }
    if (action.kind === "press") { await this.motor.pressKey(resolved.tab, action.key, context); return; }
    if (action.kind !== "type") throw new Error("Unsupported DOM fallback action.");
    await this.motor.coordinate(resolved.tab, { kind: "click", at: resolved.center, button: "left" }, context, revalidate);
    context.checkpoint();
    await this.motor.typeText(resolved.tab, action.text, action.replace ?? false, context);
  }

  async typeText(address: TabAddress, text: string, replace: boolean, context: OperationContext): Promise<void> { await this.motor.typeText(this.resolve(address), text, replace, context); }
  async pressKey(address: TabAddress, key: string, context: OperationContext): Promise<void> { await this.motor.pressKey(this.resolve(address), key, context); }

  async navigate(address: TabAddress, rawUrl: string, signal: AbortSignal, markDispatched?: () => void, authorizationContext: NavigationAuthorizationContext = { operationId: "navigate" }): Promise<void> {
    const tab = this.resolve(address);
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserProtocolError("INVALID_REQUEST", "Navigation URL is not HTTP(S).");
    await this.navigationAuthorization.authorize(this.actor, url, signal, authorizationContext);
    signal.throwIfAborted();
    const eventController = new AbortController();
    const abort = (): void => eventController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const loaded = this.host.cdp.waitForEvent("Page.loadEventFired", (event) => event.sessionId === tab.cdpSessionId, { timeoutMs: 15_000, signal: eventController.signal });
    try {
      const result = await this.host.cdp.send<{ errorText?: string }>("Page.navigate", { url: url.href }, tab.cdpSessionId, { timeoutMs: 10_000, signal, ...(markDispatched ? { onDispatch: markDispatched } : {}) });
      if (result.errorText) throw new BrowserProtocolError("CDP_ERROR", "Navigation failed.");
      await loaded;
      await this.motor.initializeTab(tab);
    } catch (error) { eventController.abort(); await loaded.catch(() => undefined); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }

  subscribeFrames(consumerKey: string, address: TabAddress, interest: "idle" | "selected" = "selected"): void { this.assertEpoch(address); this.frames.subscribe(consumerKey, address, interest); }
  async unsubscribeFrames(consumerKey: string, address: TabAddress): Promise<void> { await this.frames.unsubscribe(consumerKey, address); }
  disconnectFrameConsumer(prefix: string): void { this.frames.removeConsumerPrefix(prefix); }
  onFrame(listener: (frame: FrameEvent) => void): void { this.frames.on("frame", listener); }
  offFrame(listener: (frame: FrameEvent) => void): void { this.frames.off("frame", listener); }

  incrementControlEpoch(): number { const epoch = this.operations.incrementEpoch(this.actor, this.browserSessionId); this.frames.invalidateEpoch(epoch); void this.motor.releaseAll(); return epoch; }

  async close(): Promise<void> {
    if (this.closeState === "closed") return;
    if (this.closePromise !== undefined) return await this.closePromise;
    this.closeState = "closing";
    const promise = this.closeInternal();
    this.closePromise = promise;
    try { await promise; this.closeState = "closed"; }
    catch (error) { this.closeState = "cleanup-failed"; throw error; }
    finally { if (this.closePromise === promise) this.closePromise = undefined; }
  }

  private async closeInternal(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.frames.close(); } catch (error) { failures.push(error); }
    try { await this.motor.releaseAll(); } catch (error) { failures.push(error); }
    try { await this.targets.close(); } catch (error) { failures.push(error); }
    try { await this.host.close(); } catch (error) { failures.push(error); }
    try { this.artifacts.clearSession(this.actor, this.browserSessionId); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Browser session cleanup failed.");
  }

  private bindTab(tab: TabRecord): void {
    bindMotorTab(tab, this.host.cdp);
    bindObservationTab(tab, this.host.cdp);
    bindDomTab(tab, this.host.cdp);
    bindFrameTab(tab, this.host.cdp);
  }

  private assertEpoch(address: TabAddress): void {
    this.assertOpen();
    if (address.browserSessionId !== this.browserSessionId || address.controlEpoch !== this.controlEpoch) throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
  }
  private assertOpen(): void { if (this.closeState !== "open" || !this.host.running || !this.host.connected) throw new BrowserProtocolError("CDP_DISCONNECTED", "Browser session is unavailable.", true); }

  private readonly onHostExit = (): void => { if (this.closeState === "open") this.operations.failSession(this.actor, this.browserSessionId, "BROWSER_EXITED"); void this.motor.releaseAll(); };
  private readonly onHostDisconnect = (): void => { if (this.closeState === "open") this.operations.failSession(this.actor, this.browserSessionId, "CDP_DISCONNECTED"); void this.motor.releaseAll(); };
  private readonly onTabRegistered = (tab: TabRecord): void => { this.bindTab(tab); void this.motor.initializeTab(tab).catch(() => undefined); };
  private readonly onTabTerminal = ({ tabId, tab }: TerminalTabEvent): void => {
    if (this.motor.isActiveTab(tabId)) void this.motor.releaseAll(tab);
    this.observations.invalidateTab(tabId); this.dom.invalidateTab(tabId); void this.frames.stop(tabId);
    this.artifacts.clearTab(this.actor, this.browserSessionId, tabId);
    this.operations.failTab(this.actor, this.browserSessionId, tabId);
  };
}

export function assertDomHandleUnmoved(initial: { x: number; y: number }, current: { x: number; y: number }): void {
  if (Math.abs(current.x - initial.x) > 2 || Math.abs(current.y - initial.y) > 2) throw new BrowserProtocolError("HANDLE_STALE", "DOM target moved before dispatch.");
}

function convertCoordinateAction(action: CoordinateAction, convert: (point: { x: number; y: number }) => { x: number; y: number }): CoordinateAction {
  switch (action.kind) {
    case "move": case "hover": return { kind: action.kind, to: convert(action.to) };
    case "drag": return { kind: "drag", from: convert(action.from), to: convert(action.to) };
    case "click": case "doubleClick": return { kind: action.kind, at: convert(action.at), button: action.button };
    case "wheel": return { kind: "wheel", at: convert(action.at), deltaX: action.deltaX, deltaY: action.deltaY };
  }
}

function coordinatePoint(action: CoordinateAction): { x: number; y: number } {
  switch (action.kind) {
    case "move": case "hover": return action.to;
    case "drag": return action.from;
    case "click": case "doubleClick": case "wheel": return action.at;
  }
}
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
