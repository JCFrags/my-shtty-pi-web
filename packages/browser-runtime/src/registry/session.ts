import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserProtocolError, type ActorIdentity, type DomObservation, type FrameEvent, type ScreenshotObservation, type SessionDescriptor, type TabAddress, type TabDescriptor } from "@webx/browser-protocol";
import type { NavigationAuthorization, NavigationAuthorizationContext } from "../actor/identity.js";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import { SessionCaptureCoordinator } from "../capture/coordinator.js";
import { captureProofIdentity, SessionCaptureReadiness, type CaptureReadinessState } from "../capture/readiness.js";
import { ChromeHost, type ChromeHostOptions } from "../chrome/host.js";
import { HumanInputController } from "../control/human-input.js";
import { SessionControlAuthority, SessionControlError, type SanitizedSessionControl } from "../control/session-control.js";
import { bindFrameTab, FrameScheduler, type FrameCaptureOutcome, type FrameSchedulerOptions } from "../frames/scheduler.js";
import { SessionMotor, bindMotorTab, type CoordinateAction, type DirectHumanInputEvent, type DirectHumanInputResult, type MouseButton } from "../motor/session-motor.js";
import { DomObservationStore, bindDomTab } from "../observations/dom-store.js";
import { bindObservationTab, ObservationStore } from "../observations/store.js";
import type { OperationContext, OperationRegistry } from "../operations/registry.js";
import type { BrowserResourceStatus } from "../resources/supervisor.js";
import { TargetRegistry, type TabRecord, type TerminalTabEvent } from "../targets/registry.js";

export type DomFallbackAction =
  | { kind: "click" | "doubleClick"; button?: MouseButton }
  | { kind: "hover" }
  | { kind: "type"; text: string; replace?: boolean }
  | { kind: "press"; key: string };

export interface BrowserSessionControlIntegration {
  authorityFenced(browserSessionId: string, nextEpoch: number): void;
  establishHumanFrameStream(connectionId: string, subscriptionId: string, browserSessionId: string, tabId: string, epoch: number, signal: AbortSignal): Promise<void>;
  establishAgentFrameStream(browserSessionId: string, epoch: number, signal: AbortSignal): Promise<void>;
  changed(browserSessionId: string, state: SanitizedSessionControl): void;
  terminalCleanupRequired(browserSessionId: string, reason: string): void;
}

export class BrowserSession extends EventEmitter {
  private closeState: "open" | "closing" | "closed" | "cleanup-failed" = "open";
  private closePromise: Promise<void> | undefined;
  private automaticWarmupAttempts = 0;
  private automaticWarmupTabId: string | undefined;
  private resourceStatusValue: BrowserResourceStatus = { state: "normal", reason: "none" };
  readonly captureCoordinator: SessionCaptureCoordinator;
  readonly captureReadiness: SessionCaptureReadiness;
  readonly control: SessionControlAuthority;
  readonly motor: SessionMotor;
  readonly observations: ObservationStore;
  readonly dom: DomObservationStore;
  readonly frames: FrameScheduler;
  readonly humanInput: HumanInputController;

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
    screenshotObservationTtlMs: number,
    domObservationTtlMs: number,
    frameScheduler: Pick<FrameSchedulerOptions, "idleIntervalMs" | "selectedIntervalMs" | "burstIntervalMs"> | undefined,
    controlIntegration: BrowserSessionControlIntegration,
  ) {
    super();
    this.captureCoordinator = new SessionCaptureCoordinator();
    this.captureReadiness = new SessionCaptureReadiness(() => this.emit("captureReadiness"));
    this.motor = new SessionMotor(browserSessionId, personaSeed, motorMinimumPathMs);
    this.humanInput = new HumanInputController(this.motor);
    this.observations = new ObservationStore(actor, targets, artifacts, this.motor, { freshnessMs: screenshotObservationTtlMs, currentEpoch: () => this.controlEpoch, captureCoordinator: this.captureCoordinator });
    this.dom = new DomObservationStore(targets, { retentionMs: domObservationTtlMs });
    this.frames = new FrameScheduler(actor, targets, artifacts, this.motor, () => this.controlEpoch, { ...frameScheduler, captureCoordinator: this.captureCoordinator });
    this.control = new SessionControlAuthority({
      browserSessionId,
      currentEpoch: () => this.controlEpoch,
      advanceEpoch: () => this.advanceAuthorityEpoch(),
      assertAcquireReady: (tabId) => this.assertControlReady(tabId),
      invalidateAgentAuthority: (nextEpoch) => { this.invalidateActorObservations(); controlIntegration.authorityFenced(browserSessionId, nextEpoch); },
      awaitAgentSettlement: async (signal) => await this.operations.awaitSessionSettlement(this.actor, browserSessionId, signal),
      stopHumanInput: () => this.humanInput.stop(),
      awaitHumanInputSettlement: async (signal) => await this.humanInput.awaitSettlement(signal),
      releaseHeldInput: async (signal) => { signal.throwIfAborted(); await this.motor.releaseAll(); signal.throwIfAborted(); },
      heldInputCount: () => this.motor.heldInputState.buttons.length + this.motor.heldInputState.keys.length,
      establishHumanFrameStream: async (connectionId, subscriptionId, tabId, epoch, signal) => {
        await controlIntegration.establishHumanFrameStream(connectionId, subscriptionId, browserSessionId, tabId, epoch, signal);
        await this.awaitFreshWorkspaceFrame(tabId, epoch, signal);
        this.humanInput.start(tabId, epoch);
      },
      invalidateHumanAuthority: (nextEpoch) => { this.invalidateActorObservations(); controlIntegration.authorityFenced(browserSessionId, nextEpoch); },
      establishAgentFrameStream: async (epoch, signal) => await controlIntegration.establishAgentFrameStream(browserSessionId, epoch, signal),
      changed: (state) => controlIntegration.changed(browserSessionId, state),
      terminalCleanupRequired: (reason) => controlIntegration.terminalCleanupRequired(browserSessionId, reason),
    });
    this.frames.on("captureOutcome", this.onCaptureReadinessOutcome);
    host.on("exit", this.onHostExit);
    host.on("disconnect", this.onHostDisconnect);
    targets.on("tabTerminal", this.onTabTerminal);
    targets.on("tabRegistered", this.onTabRegistered);
    targets.on("tabGenerationChanged", this.onTabGenerationChanged);
  }

  static async create(actor: ActorIdentity, operations: OperationRegistry, artifacts: BrowserArtifactStore, navigationAuthorization: NavigationAuthorization, options: Omit<ChromeHostOptions, "hostId"> & { initialUrl?: string; initialNavigationContext?: NavigationAuthorizationContext; personaSeed?: number; motorMinimumPathMs?: number; screenshotObservationTtlMs?: number; domObservationTtlMs?: number; observationFreshnessMs?: number; frameScheduler?: Pick<FrameSchedulerOptions, "idleIntervalMs" | "selectedIntervalMs" | "burstIntervalMs">; controlIntegration?: BrowserSessionControlIntegration } = {}, signal?: AbortSignal, markProcessDispatched?: () => void): Promise<BrowserSession> {
    signal?.throwIfAborted();
    const browserSessionId = opaqueId("session");
    const { initialUrl, initialNavigationContext, personaSeed, motorMinimumPathMs, screenshotObservationTtlMs, domObservationTtlMs, observationFreshnessMs, frameScheduler, controlIntegration, ...hostOptions } = options;
    const host = await ChromeHost.launch({ hostId: browserSessionId, ...hostOptions }, signal, markProcessDispatched);
    try {
      signal?.throwIfAborted();
      const targets = await TargetRegistry.create(browserSessionId, host);
      const session = new BrowserSession(actor, browserSessionId, host, targets, operations, artifacts, navigationAuthorization, personaSeed ?? randomBytes(4).readUInt32BE(), motorMinimumPathMs ?? 0, screenshotObservationTtlMs ?? observationFreshnessMs ?? 60_000, domObservationTtlMs ?? 60_000, frameScheduler, controlIntegration ?? NOOP_CONTROL_INTEGRATION);
      const tab = await session.createTab(undefined, signal, undefined, { operationId: "session.create" }, false);
      if (initialUrl !== undefined) await session.navigate(session.address(tab), initialUrl, signal ?? new AbortController().signal, undefined, initialNavigationContext ?? { operationId: "session.create" });
      session.startCaptureWarmup(tab, true);
      return session;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  get controlEpoch(): number { return this.operations.currentEpoch(this.actor, this.browserSessionId); }
  get personaId(): string { return this.motor.personaId; }
  get captureReadinessState(): CaptureReadinessState { return this.captureReadiness.state; }
  get resourceStatus(): BrowserResourceStatus { return this.resourceStatusValue; }
  get processIdentity(): { readonly pid: number; readonly processStartTicks: string } { return this.host.processIdentity; }
  get profileDirectory(): string { return this.host.profileDirectory; }
  tabCaptureReadiness(tabId: string): CaptureReadinessState { return this.captureReadiness.tabState(tabId); }

  descriptor(): SessionDescriptor {
    const healthy = this.host.connected && this.resourceStatusValue.state === "normal";
    return { kind: "session", browserSessionId: this.browserSessionId, controlEpoch: this.controlEpoch, state: this.closeState === "open" ? healthy ? "ready" : "degraded" : "closed", personaId: this.personaId, cursor: this.motor.state, tabs: this.targets.list(this.controlEpoch) };
  }

  actorDescriptor(): SessionDescriptor {
    const descriptor = this.descriptor();
    if (this.control.state === "agent") return descriptor;
    return { ...descriptor, cursor: { ...descriptor.cursor, x: 0, y: 0, pathSequence: 0, sampleSequence: 0, visible: false } };
  }

  async createTab(url?: string, signal = new AbortController().signal, markDispatched?: () => void, navigationContext: NavigationAuthorizationContext = { operationId: "tab.create" }, prewarm = false): Promise<TabRecord> {
    this.assertOpen();
    const tab = await this.targets.createTab("about:blank", { signal, ...(markDispatched ? { markDispatched } : {}) });
    try {
      this.bindTab(tab);
      await this.motor.initializeTab(tab);
      signal.throwIfAborted();
      if (url !== undefined) await this.navigate(this.address(tab), url, signal, undefined, navigationContext);
      signal.throwIfAborted();
      this.captureReadiness.begin(tab, this.controlEpoch);
      if (prewarm) this.startCaptureWarmup(tab, true);
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

  setResourceStatus(status: BrowserResourceStatus): void { this.resourceStatusValue = status; }
  assertResourceAdmission(): void {
    if (this.resourceStatusValue.state === "draining" || this.resourceStatusValue.state === "resource-limited" || this.resourceStatusValue.state === "closing" || this.resourceStatusValue.state === "closed") {
      const reason = this.resourceStatusValue.reason === "profile-storage" ? "profile-storage" : this.resourceStatusValue.reason === "global-memory" ? "global-memory" : "session-memory";
      throw new BrowserProtocolError("BROWSER_RESOURCE_LIMIT", "Browser session reached a resource limit.", false, { reason });
    }
  }
  async returnHumanControlForResourceLimit(signal: AbortSignal): Promise<void> { await this.control.returnForResourceLimit(signal); }

  async dispatchHumanInput(tabId: string, controlEpoch: number, events: readonly DirectHumanInputEvent[], beforeDispatch: () => void, signal?: AbortSignal): Promise<{ readonly result: DirectHumanInputResult; readonly coalescedPointerMoveCount: number }> {
    const tab = this.targets.getById(tabId);
    if (tab === undefined || tab.state !== "open") throw new BrowserProtocolError("TAB_NOT_FOUND", "Workspace tab not found.");
    return await this.humanInput.dispatch(tab, controlEpoch, events, beforeDispatch, signal);
  }

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

  subscribeFrames(consumerKey: string, address: TabAddress, interest: "idle" | "selected" = "selected", deferInitialCapture = false): void { this.assertEpoch(address); this.frames.subscribe(consumerKey, address, interest, deferInitialCapture); }
  async unsubscribeFrames(consumerKey: string, address: TabAddress): Promise<void> { await this.frames.unsubscribe(consumerKey, address); }
  invalidateFrameConsumer(consumerKey: string): void { this.frames.removeConsumer(consumerKey); }
  async settleFrameConsumerRemoval(consumerKey: string): Promise<void> { await this.frames.removeConsumerAndSettle(consumerKey); }
  latestValidWorkspaceFrame(address: TabAddress, maxAgeMs = 2_000): FrameEvent | undefined { this.assertEpoch(address); return this.frames.latestValidFrame(address, maxAgeMs); }
  disconnectFrameConsumer(prefix: string): void { this.frames.removeConsumerPrefix(prefix); }
  onFrame(listener: (frame: FrameEvent) => void): void { this.frames.on("frame", listener); }
  offFrame(listener: (frame: FrameEvent) => void): void { this.frames.off("frame", listener); }
  onCaptureReadiness(listener: () => void): void { this.on("captureReadiness", listener); }
  offCaptureReadiness(listener: () => void): void { this.off("captureReadiness", listener); }

  incrementControlEpoch(): number {
    const epoch = this.advanceAuthorityEpoch();
    this.automaticWarmupTabId = undefined;
    for (const descriptor of this.targets.list(epoch)) { const tab = this.targets.getById(descriptor.address.tabId); if (tab !== undefined) this.captureReadiness.begin(tab, epoch); }
    void this.motor.releaseAll();
    return epoch;
  }

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
    this.control.close();
    this.captureReadiness.markUnavailable();
    this.frames.off("captureOutcome", this.onCaptureReadinessOutcome);
    this.targets.off("tabGenerationChanged", this.onTabGenerationChanged);
    try { await this.frames.close(); } catch (error) { failures.push(error); }
    try { await this.captureCoordinator.close(); } catch (error) { failures.push(error); }
    try { await this.motor.releaseAll(); } catch (error) { failures.push(error); }
    try { await this.targets.close(); } catch (error) { failures.push(error); }
    try { await this.host.close(); } catch (error) { failures.push(error); }
    try { this.artifacts.clearSession(this.actor, this.browserSessionId); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Browser session cleanup failed.");
  }

  private advanceAuthorityEpoch(): number {
    const epoch = this.operations.incrementEpoch(this.actor, this.browserSessionId);
    this.frames.invalidateEpoch(epoch);
    return epoch;
  }

  private assertControlReady(tabId: string): void {
    this.assertOpen();
    const tab = this.targets.getById(tabId);
    if (tab === undefined || tab.state !== "open" || this.captureReadiness.state !== "ready" || this.captureReadiness.tabState(tabId) !== "ready") {
      throw new SessionControlError("CONTROL_NOT_READY", "Browser view is preparing.", true);
    }
  }

  private invalidateActorObservations(): void {
    for (const tab of this.targets.list(this.controlEpoch)) {
      this.observations.invalidateTab(tab.address.tabId);
      this.dom.invalidateTab(tab.address.tabId);
    }
    this.artifacts.clearAgentObservations(this.actor, this.browserSessionId);
  }

  private async awaitFreshWorkspaceFrame(tabId: string, epoch: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const tab = this.targets.getById(tabId);
    if (tab === undefined || tab.state !== "open") throw new SessionControlError("CONTROL_NOT_READY", "Browser control tab is unavailable.", true);
    const address = this.address(tab);
    if (address.controlEpoch !== epoch) throw new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control epoch changed.", true);
    if (this.frames.latestValidFrame(address, 1_500) !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener("abort", abort); this.frames.off("frame", frame); };
      const abort = (): void => { cleanup(); reject(signal.reason ?? new SessionControlError("CONTROL_TRANSFER_PENDING", "Browser control frame wait was cancelled.", true)); };
      const frame = (candidate: FrameEvent): void => {
        if (candidate.address.browserSessionId !== this.browserSessionId || candidate.address.tabId !== tabId || candidate.address.controlEpoch !== epoch) return;
        cleanup(); resolve();
      };
      this.frames.on("frame", frame);
      signal.addEventListener("abort", abort, { once: true });
      this.frames.requestCapture(tabId);
      if (signal.aborted) abort();
    });
  }

  private startCaptureWarmup(tab: TabRecord, automatic = false): void {
    if (this.closeState !== "open" || tab.state !== "open") return;
    this.captureReadiness.begin(tab, this.controlEpoch);
    if (!automatic || this.automaticWarmupAttempts >= 3 || this.automaticWarmupTabId !== undefined) return;
    this.automaticWarmupTabId = tab.tabId;
    const key = captureReadinessConsumerKey(tab.tabId);
    const address = this.address(tab);
    if (!this.frames.hasConsumer(key, address)) this.frames.subscribe(key, address, "selected");
    this.frames.requestCapture(tab.tabId);
  }

  private bindTab(tab: TabRecord): void {
    bindMotorTab(tab, this.host.cdp);
    bindObservationTab(tab, this.host.cdp);
    bindDomTab(tab, this.host.cdp);
    bindFrameTab(tab, this.host.cdp);
  }

  private assertEpoch(address: TabAddress): void {
    this.assertResourceAdmission();
    this.assertOpen();
    if (address.browserSessionId !== this.browserSessionId || address.controlEpoch !== this.controlEpoch) throw new BrowserProtocolError("CONTROL_EPOCH_STALE", "Control epoch is stale.");
  }
  private assertOpen(): void { if (this.closeState !== "open" || !this.host.running || !this.host.connected) throw new BrowserProtocolError("CDP_DISCONNECTED", "Browser session is unavailable.", true); }

  private readonly onCaptureReadinessOutcome = (outcome: FrameCaptureOutcome): void => {
    if (!outcome.selectedAtStart) return;
    const state = outcome.result === "succeeded"
      ? this.captureReadiness.succeeded(outcome.identity)
      : (this.captureReadiness.failed(outcome.identity), this.captureReadiness.tabState(outcome.identity.tabId));
    if (this.automaticWarmupTabId !== outcome.identity.tabId) return;
    this.automaticWarmupAttempts++;
    const exhausted = this.automaticWarmupAttempts >= 3;
    if (state === "ready" || exhausted) {
      if (state !== "ready") {
        const current = this.targets.getById(outcome.identity.tabId);
        if (current !== undefined && current.state === "open") this.captureReadiness.failed(captureProofIdentity(current, this.controlEpoch));
      }
      this.automaticWarmupTabId = undefined;
      void this.frames.removeConsumerAndSettle(captureReadinessConsumerKey(outcome.identity.tabId));
      return;
    }
    this.frames.requestCapture(outcome.identity.tabId);
  };
  private readonly onTabGenerationChanged = (tab: TabRecord): void => { this.captureReadiness.begin(tab, this.controlEpoch); };
  private readonly onHostExit = (): void => { if (this.closeState === "open") this.operations.failSession(this.actor, this.browserSessionId, "BROWSER_EXITED"); this.control.close(); this.captureReadiness.markUnavailable(); void this.motor.releaseAll(); };
  private readonly onHostDisconnect = (): void => { if (this.closeState === "open") this.operations.failSession(this.actor, this.browserSessionId, "CDP_DISCONNECTED"); this.control.close(); this.captureReadiness.markUnavailable(); void this.motor.releaseAll(); };
  private readonly onTabRegistered = (tab: TabRecord): void => { this.bindTab(tab); void this.motor.initializeTab(tab).then(() => this.captureReadiness.begin(tab, this.controlEpoch), () => { this.captureReadiness.begin(tab, this.controlEpoch); this.captureReadiness.failed(captureProofIdentity(tab, this.controlEpoch)); }); };
  private readonly onTabTerminal = ({ tabId, tab }: TerminalTabEvent): void => {
    void this.control.controlledTabClosed(tabId).catch(() => undefined);
    this.captureReadiness.remove(tabId);
    if (this.automaticWarmupTabId === tabId) { this.automaticWarmupTabId = undefined; void this.frames.removeConsumerAndSettle(captureReadinessConsumerKey(tabId)); }
    this.captureCoordinator.cancelTab(tabId);
    if (this.motor.isActiveTab(tabId)) void this.motor.releaseAll(tab);
    this.observations.invalidateTab(tabId); this.dom.invalidateTab(tabId); void this.frames.stop(tabId, 0);
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
const NOOP_CONTROL_INTEGRATION: BrowserSessionControlIntegration = {
  authorityFenced: () => undefined,
  establishHumanFrameStream: async () => undefined,
  establishAgentFrameStream: async () => undefined,
  changed: () => undefined,
  terminalCleanupRequired: () => undefined,
};
function captureReadinessConsumerKey(tabId: string): string { return `capture-readiness\u0000${tabId}`; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
