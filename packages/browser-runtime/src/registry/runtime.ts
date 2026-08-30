import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserProtocolError, type ActorIdentity, type BrowserRequest, type FrameEvent, type OperationStatus, type SessionDescriptor, type TabAddress, type WorkspaceBrokerRequest, type WorkspaceFrameEvent, type WorkspaceSnapshot, type WorkspaceStateEvent } from "@webx/browser-protocol";
import { actorKey, DenyNavigationAuthorization, type NavigationAuthorization } from "../actor/identity.js";
import { BrowserArtifactStore } from "../artifacts/store.js";
import { findChromeExecutable, type ChromeHostOptions } from "../chrome/host.js";
import { ProfileManager } from "../chrome/profile-manager.js";
import type { CoordinateAction } from "../motor/session-motor.js";
import { canonicalOperationFingerprint, OperationRegistry, type OperationContext } from "../operations/registry.js";
import { BrowserSession, type DomFallbackAction } from "./session.js";

interface RuntimeSubscription { readonly actor: string; readonly connectionId: string; readonly subscriptionId: string; readonly address: TabAddress; readonly interest: "idle" | "selected"; readonly consumerKey: string }
interface WorkspaceSubscription { readonly connectionId: string; readonly subscriptionId: string; readonly browserSessionId: string; readonly tabId: string; readonly interest: "idle" | "selected"; readonly consumerKey: string }
interface WorkspaceFrameLedgerEntry { readonly subscriptionId: string; readonly actor: ActorIdentity; readonly browserSessionId: string; readonly tabId: string; readonly frameSequence: number; readonly artifactId: string; readonly deliveredAtMs: number }

export const DEFAULT_SCREENSHOT_OBSERVATION_TTL_MS = 60_000;
export const DEFAULT_DOM_OBSERVATION_TTL_MS = 60_000;
export const MIN_OBSERVATION_TTL_MS = 10_000;
export const MAX_OBSERVATION_TTL_MS = 120_000;

export interface BrowserRuntimeOptions {
  navigationAuthorization?: NavigationAuthorization;
  chrome?: Omit<ChromeHostOptions, "hostId" | "profileManager">;
  maxSessionsPerActor?: number;
  maxSessionsGlobal?: number;
  maxSubscriptionsPerConnection?: number;
  maxSubscriptionsPerActor?: number;
  personaSeedForTest?: number;
  motorMinimumPathMsForTest?: number;
  screenshotObservationTtlMs?: number;
  domObservationTtlMs?: number;
  /** @deprecated Use screenshotObservationTtlMs. */
  observationFreshnessMsForTest?: number;
  egressConfigured?: boolean;
  egressBindingId?: string;
  requireEgressForSessions?: boolean;
}

export class BrowserRuntime extends EventEmitter {
  readonly artifacts = new BrowserArtifactStore();
  readonly operations = new OperationRegistry();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly subscriptions = new Map<string, Map<string, RuntimeSubscription>>();
  private readonly workspaceSubscriptions = new Map<string, Map<string, WorkspaceSubscription>>();
  private readonly workspaceEventSubscribers = new Set<string>();
  private readonly workspaceFrameLedgers = new Map<string, WorkspaceFrameLedgerEntry[]>();
  private workspaceRevision = 0;
  private readonly navigationAuthorization: NavigationAuthorization;
  private readonly chrome: Omit<ChromeHostOptions, "hostId" | "profileManager">;
  private readonly profileManager: ProfileManager;
  private readonly maxSessionsPerActor: number;
  private readonly maxSessionsGlobal: number;
  private creatingSessions = 0;
  private closeState: "open" | "closing" | "closed" | "cleanup-failed" = "open";
  private closePromise: Promise<void> | undefined;
  private readonly maxSubscriptionsPerConnection: number;
  private readonly maxSubscriptionsPerActor: number;
  private readonly personaSeedForTest: number | undefined;
  private readonly motorMinimumPathMsForTest: number;
  private readonly screenshotObservationTtlMs: number;
  private readonly domObservationTtlMs: number;
  private readonly egressConfigured: boolean;
  private readonly egressBindingId: string | undefined;
  private readonly requireEgressForSessions: boolean;

  constructor(options: BrowserRuntimeOptions = {}) {
    super();
    this.navigationAuthorization = options.navigationAuthorization ?? new DenyNavigationAuthorization();
    this.chrome = options.chrome ?? {};
    this.profileManager = new ProfileManager(this.chrome.profileRoot);
    this.maxSessionsPerActor = options.maxSessionsPerActor ?? 4;
    this.maxSessionsGlobal = options.maxSessionsGlobal ?? 16;
    if (!Number.isInteger(this.maxSessionsGlobal) || this.maxSessionsGlobal < 1 || this.maxSessionsGlobal > 256) throw new BrowserProtocolError("INVALID_REQUEST", "Global browser session limit is invalid.");
    this.maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection ?? 64;
    this.maxSubscriptionsPerActor = options.maxSubscriptionsPerActor ?? 256;
    this.personaSeedForTest = options.personaSeedForTest;
    this.motorMinimumPathMsForTest = options.motorMinimumPathMsForTest ?? 0;
    this.screenshotObservationTtlMs = observationTtl(options.screenshotObservationTtlMs ?? options.observationFreshnessMsForTest ?? DEFAULT_SCREENSHOT_OBSERVATION_TTL_MS, "Screenshot observation TTL");
    this.domObservationTtlMs = observationTtl(options.domObservationTtlMs ?? DEFAULT_DOM_OBSERVATION_TTL_MS, "DOM observation TTL");
    this.egressConfigured = options.egressConfigured ?? options.chrome?.egressProxy !== undefined;
    const proxy = options.chrome?.egressProxy;
    this.egressBindingId = options.egressBindingId ?? (proxy === undefined ? undefined : `forward-proxy://${proxy.host === "::1" ? "[::1]" : proxy.host}:${proxy.port}`);
    this.requireEgressForSessions = options.requireEgressForSessions ?? false;
  }

  get subscriptionCount(): number { let count = 0; for (const values of this.subscriptions.values()) count += values.size; for (const values of this.workspaceSubscriptions.values()) count += values.size; return count; }
  get workspaceSubscriptionCount(): number { let count = 0; for (const values of this.workspaceSubscriptions.values()) count += values.size; return count; }
  get workspaceLedgerCount(): number { let count = 0; for (const values of this.workspaceFrameLedgers.values()) count += values.length; return count; }

  listSessions(actor: ActorIdentity): SessionDescriptor[] { const owner = actorKey(actor); return [...this.sessions.values()].filter((session) => actorKey(session.actor) === owner).map((session) => session.descriptor()); }
  ownsSession(actor: ActorIdentity, browserSessionId: string): boolean { const session = this.sessions.get(browserSessionId); return session !== undefined && actorKey(session.actor) === actorKey(actor); }

  workspaceSnapshot(): WorkspaceSnapshot {
    return {
      kind: "workspaceSnapshot",
      workspaceRevision: this.workspaceRevision,
      generatedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()].map((session) => {
        const descriptor = session.descriptor();
        const activeOperation = this.operations.workspaceSummary(descriptor.browserSessionId);
        return {
          browserSessionId: descriptor.browserSessionId,
          agentSessionId: session.actor.agentSessionId,
          actorDisplayId: `actor_${createHash("sha256").update(actorKey(session.actor)).digest("base64url").slice(0, 24)}`,
          pathId: "agentcursor/chrome" as const,
          state: descriptor.state,
          controlState: "agent" as const,
          personaId: descriptor.personaId,
          cursor: descriptor.cursor,
          tabs: descriptor.tabs.map((tab) => ({ tabId: tab.address.tabId, url: tab.url, title: tab.title.slice(0, 512), state: tab.state, documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration, frameSequence: tab.frameSequence })),
          ...(activeOperation === undefined ? {} : { activeOperation }),
        };
      }),
    };
  }

  workspaceSubscribeEvents(connectionId: string): void { this.workspaceEventSubscribers.add(connectionId); }
  workspaceUnsubscribeEvents(connectionId: string): void { this.workspaceEventSubscribers.delete(connectionId); }
  shouldDeliverWorkspaceEvent(connectionId: string): boolean { return this.workspaceEventSubscribers.has(connectionId); }

  workspaceSubscribeFrames(connectionId: string, subscriptionId: string, browserSessionId: string, tabId: string, interest: "idle" | "selected"): void {
    const values = this.workspaceSubscriptions.get(connectionId) ?? new Map<string, WorkspaceSubscription>();
    const existing = values.get(subscriptionId);
    if (existing !== undefined) {
      if (existing.browserSessionId !== browserSessionId || existing.tabId !== tabId || existing.interest !== interest) throw new BrowserProtocolError("OPERATION_CONFLICT", "Workspace subscription ID is already bound.");
      return;
    }
    if (values.size >= 16 || this.workspaceSubscriptionCount >= 32) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Workspace subscription limit reached.", true);
    const session = this.sessions.get(browserSessionId);
    const tab = session?.descriptor().tabs.find((item) => item.address.tabId === tabId);
    if (session === undefined || tab === undefined || tab.state !== "ready") throw new BrowserProtocolError("TAB_NOT_FOUND", "Workspace tab not found.");
    const subscription: WorkspaceSubscription = { connectionId, subscriptionId, browserSessionId, tabId, interest, consumerKey: `workspace\u0000${connectionId}\u0000${subscriptionId}` };
    session.subscribeFrames(subscription.consumerKey, tab.address, interest);
    values.set(subscriptionId, subscription);
    this.workspaceSubscriptions.set(connectionId, values);
  }

  async workspaceUnsubscribeFrames(connectionId: string, subscriptionId: string, browserSessionId: string, tabId: string): Promise<void> {
    const values = this.workspaceSubscriptions.get(connectionId);
    const subscription = values?.get(subscriptionId);
    if (subscription === undefined) return;
    if (subscription.browserSessionId !== browserSessionId || subscription.tabId !== tabId) throw new BrowserProtocolError("OPERATION_CONFLICT", "Workspace subscription identity does not match.");
    const session = this.sessions.get(browserSessionId);
    const address = session?.descriptor().tabs.find((item) => item.address.tabId === tabId)?.address;
    if (session !== undefined && address !== undefined) await session.unsubscribeFrames(subscription.consumerKey, address);
    values?.delete(subscriptionId);
    if (values?.size === 0) this.workspaceSubscriptions.delete(connectionId);
    this.pruneWorkspaceLedger(connectionId, subscriptionId);
  }

  workspaceFrameDeliveries(connectionId: string, frame: FrameEvent): Array<{ subscriptionId: string; frame: FrameEvent }> {
    const deliveries: Array<{ subscriptionId: string; frame: FrameEvent }> = [];
    for (const subscription of this.workspaceSubscriptions.get(connectionId)?.values() ?? []) {
      if (subscription.browserSessionId === frame.address.browserSessionId && subscription.tabId === frame.address.tabId) deliveries.push({ subscriptionId: subscription.subscriptionId, frame });
    }
    return deliveries;
  }

  recordWorkspaceFrameDelivered(connectionId: string, subscriptionId: string, frame: FrameEvent): void {
    const session = this.sessions.get(frame.address.browserSessionId);
    const subscription = this.workspaceSubscriptions.get(connectionId)?.get(subscriptionId);
    if (session === undefined || subscription === undefined || subscription.browserSessionId !== frame.address.browserSessionId || subscription.tabId !== frame.address.tabId) return;
    const values = (this.workspaceFrameLedgers.get(connectionId) ?? []).filter((item) => Date.now() - item.deliveredAtMs <= 60_000);
    values.push({ subscriptionId, actor: session.actor, browserSessionId: frame.address.browserSessionId, tabId: frame.address.tabId, frameSequence: frame.frameSequence, artifactId: frame.artifactId, deliveredAtMs: Date.now() });
    while (values.filter((item) => item.subscriptionId === subscriptionId).length > 2) values.splice(values.findIndex((item) => item.subscriptionId === subscriptionId), 1);
    while (values.length > 32) values.shift();
    this.workspaceFrameLedgers.set(connectionId, values);
  }

  async workspaceReadFrame(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.frame.read" }>): Promise<unknown> {
    const values = this.workspaceFrameLedgers.get(connectionId) ?? [];
    const entry = values.find((item) => item.subscriptionId === request.subscriptionId && item.browserSessionId === request.browserSessionId && item.tabId === request.tabId && item.frameSequence === request.frameSequence && item.artifactId === request.artifactId && Date.now() - item.deliveredAtMs <= 60_000);
    if (entry === undefined || this.workspaceSubscriptions.get(connectionId)?.has(request.subscriptionId) !== true) throw new BrowserProtocolError("ARTIFACT_FORBIDDEN", "Workspace frame artifact is not available.");
    const artifact = await this.artifacts.read(entry.actor, entry.artifactId);
    if (artifact.descriptor.purpose !== "workspace-frame" || artifact.descriptor.browserSessionId !== entry.browserSessionId || artifact.descriptor.tabId !== entry.tabId) throw new BrowserProtocolError("ARTIFACT_FORBIDDEN", "Workspace frame artifact is not available.");
    const offset = request.offset ?? 0;
    const maxBytes = request.maxBytes ?? 1024 * 1024;
    if (offset > artifact.bytes.byteLength) throw new BrowserProtocolError("INVALID_REQUEST", "Workspace frame offset is outside the artifact.");
    const chunk = artifact.bytes.slice(offset, Math.min(artifact.bytes.byteLength, offset + maxBytes));
    return { kind: "workspaceFrameArtifact", artifactId: entry.artifactId, browserSessionId: entry.browserSessionId, tabId: entry.tabId, subscriptionId: entry.subscriptionId, frameSequence: entry.frameSequence, mediaType: artifact.descriptor.mediaType, byteLength: chunk.byteLength, sha256: artifact.descriptor.sha256, offset, totalBytes: artifact.bytes.byteLength, eof: offset + chunk.byteLength >= artifact.bytes.byteLength, base64: Buffer.from(chunk).toString("base64") };
  }

  shouldDeliverFrame(connectionId: string, actor: ActorIdentity, frame: FrameEvent): boolean {
    for (const subscription of this.subscriptions.get(connectionId)?.values() ?? []) if (subscription.actor === actorKey(actor) && sameAddress(subscription.address, frame.address)) return true;
    return false;
  }

  releaseConnection(connectionId: string): void {
    const values = this.subscriptions.get(connectionId);
    this.subscriptions.delete(connectionId);
    for (const subscription of values?.values() ?? []) this.sessions.get(subscription.address.browserSessionId)?.frames.removeConsumer(subscription.consumerKey);
    this.releaseWorkspaceConnection(connectionId);
  }

  releaseWorkspaceConnection(connectionId: string): void {
    const workspace = this.workspaceSubscriptions.get(connectionId);
    this.workspaceSubscriptions.delete(connectionId);
    this.workspaceEventSubscribers.delete(connectionId);
    this.workspaceFrameLedgers.delete(connectionId);
    for (const subscription of workspace?.values() ?? []) this.sessions.get(subscription.browserSessionId)?.frames.removeConsumer(subscription.consumerKey);
  }

  private getSession(actor: ActorIdentity, browserSessionId: string): BrowserSession {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined || actorKey(session.actor) !== actorKey(actor)) throw new BrowserProtocolError("SESSION_NOT_FOUND", "Browser session not found.");
    return session;
  }

  async dispatch(actor: ActorIdentity, request: BrowserRequest, signal?: AbortSignal, connectionId?: string): Promise<unknown> {
    if (this.closeState !== "open") throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Browser runtime is closing.", true);
    ensureRequestLive(request);
    signal?.throwIfAborted();
    if (request.kind === "capabilities.get") return await this.capabilities();
    if (request.kind === "session.list") return { kind: "sessions", sessions: this.listSessions(actor) };
    if (request.kind === "operation.status") return this.operations.status(actor, request.targetOperationId);
    if (request.kind === "operation.cancel") return this.operations.cancel(actor, request.targetOperationId);
    if (request.kind === "artifact.read") {
      const artifact = await this.artifacts.read(actor, request.artifactId);
      const offset = request.offset ?? 0;
      const maxBytes = request.maxBytes ?? 1024 * 1024;
      if (offset > artifact.bytes.byteLength) throw new BrowserProtocolError("INVALID_REQUEST", "Artifact offset is outside the artifact.");
      const chunk = artifact.bytes.slice(offset, Math.min(artifact.bytes.byteLength, offset + maxBytes));
      return { kind: "artifact", artifactId: request.artifactId, mediaType: artifact.descriptor.mediaType, byteLength: chunk.byteLength, sha256: artifact.descriptor.sha256, offset, totalBytes: artifact.bytes.byteLength, eof: offset + chunk.byteLength >= artifact.bytes.byteLength, base64: Buffer.from(chunk).toString("base64") };
    }

    if (isExecutedRequest(request)) {
      const existing = this.operations.lookup(actor, request.operationId, requestFingerprint(request, connectionId));
      if (existing !== undefined) return await this.awaitExisting(actor, request.operationId, signal);
    }

    if (request.kind === "session.create") {
      return await this.execute(actor, request, `actor:${actorKey(actor)}:sessions`, undefined, undefined, async (context) => {
        context.checkpoint();
        if (this.requireEgressForSessions && !this.egressConfigured) throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "Browser egress is not configured.", true);
        if (this.listSessions(actor).length >= this.maxSessionsPerActor) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Browser session limit reached.", true);
        if (this.sessions.size + this.creatingSessions >= this.maxSessionsGlobal) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Global browser session limit reached.", true);
        this.creatingSessions++;
        try {
          const session = await BrowserSession.create(actor, this.operations, this.artifacts, this.navigationAuthorization, {
            ...this.chrome, profileManager: this.profileManager,
            ...(request.initialUrl !== undefined ? { initialUrl: request.initialUrl, initialNavigationContext: { operationId: request.operationId, ...(request.navigationAuthorization !== undefined ? { authorization: request.navigationAuthorization } : {}) } } : {}),
            ...(this.personaSeedForTest !== undefined ? { personaSeed: this.personaSeedForTest } : {}),
            motorMinimumPathMs: this.motorMinimumPathMsForTest,
            screenshotObservationTtlMs: this.screenshotObservationTtlMs,
            domObservationTtlMs: this.domObservationTtlMs,
          }, context.signal, () => context.markDispatched());
          if (context.signal.aborted) { await session.close(); throw context.signal.reason; }
          this.sessions.set(session.browserSessionId, session);
          session.onFrame(this.onFrame);
          session.targets.on("tabTerminal", ({ tabId }: { tabId: string }) => { this.removeTabSubscriptions(session.browserSessionId, tabId); this.workspaceChanged("tab", session.browserSessionId, tabId); });
          this.workspaceChanged("session", session.browserSessionId);
          return session.descriptor();
        } finally { this.creatingSessions--; }
      }, signal);
    }

    const browserSessionId = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.browserSessionId : request.address.browserSessionId;
    const session = this.getSession(actor, browserSessionId);
    const controlEpoch = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.controlEpoch : request.address.controlEpoch;
    const motorLane = `motor:${actorKey(actor)}:${browserSessionId}`;

    if (request.kind === "session.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); context.markDispatched(); await session.close(); this.sessions.delete(browserSessionId); this.removeSessionSubscriptions(browserSessionId); this.workspaceChanged("session", browserSessionId); return session.descriptor(); }, signal);
    if (request.kind === "tab.list") return { kind: "tabs", tabs: session.listTabs() };
    if (request.kind === "tab.create") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const tab = await session.createTab(request.url, context.signal, () => context.markDispatched(), { operationId: request.operationId, ...(request.navigationAuthorization !== undefined ? { authorization: request.navigationAuthorization } : {}) }); this.workspaceChanged("tab", browserSessionId, tab.tabId); return session.listTabs().find((item) => item.address.tabId === tab.tabId); }, signal);
    if (request.kind === "tab.focus") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.targets.focus(request.address, context.signal, () => context.markDispatched()); return session.listTabs().find((item) => item.address.tabId === request.address.tabId); }, signal);
    if (request.kind === "tab.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const tab = session.resolve(request.address); if (session.motor.isActiveTab(tab.tabId)) await session.motor.releaseAll(tab); await session.targets.closeTab(request.address, context.signal, () => context.markDispatched()); this.removeTabSubscriptions(browserSessionId, request.address.tabId); this.workspaceChanged("tab", browserSessionId, request.address.tabId); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "observe.screenshot") return await this.execute(actor, request, `capture:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async (context) => await session.observe(request.address, request.delivery, context.signal), signal);
    if (request.kind === "observe.domFallback") return await this.execute(actor, request, `dom:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async (context) => await session.observeDom(request.address, request.maxNodes, context.signal), signal);
    if (request.kind === "action.coordinate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.coordinate(request.address, request.observationId, request.action as CoordinateAction, context, request.riskPolicy, request.coordinateSpace ?? "imagePixels"); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "action.domFallback") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.domAction(request.address, request.domObservationId, request.handle, request.action as DomFallbackAction, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "navigate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.navigate(request.address, request.url, context.signal, () => context.markDispatched(), { operationId: request.operationId, authorization: request.navigationAuthorization }); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.text") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.typeText(request.address, request.text, request.replace ?? false, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.key") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.pressKey(request.address, request.key, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "frames.subscribe") return await this.execute(actor, request, `frames:${browserSessionId}`, browserSessionId, controlEpoch, async (context) => {
      context.checkpoint();
      const id = requireConnectionId(connectionId);
      const prior = this.findSubscription(actor, id, request.subscriptionId);
      const subscription = this.addSubscription(actor, id, request.subscriptionId, request.address, request.interest ?? "selected");
      try { session.subscribeFrames(subscription.consumerKey, request.address, subscription.interest); }
      catch (error) { if (prior === undefined) this.removeSubscription(id, request.subscriptionId, subscription); throw error; }
      context.markDispatched();
      return { kind: "subscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: true };
    }, signal, connectionId);
    if (request.kind === "frames.unsubscribe") return await this.execute(actor, request, `frames:${browserSessionId}`, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const id = requireConnectionId(connectionId); const subscription = this.findSubscription(actor, id, request.subscriptionId); if (subscription !== undefined) { if (!sameAddress(subscription.address, request.address)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription address does not match."); await session.unsubscribeFrames(subscription.consumerKey, request.address); this.removeSubscription(id, request.subscriptionId, subscription); } context.markDispatched(); return { kind: "subscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: false }; }, signal, connectionId);
    throw new BrowserProtocolError("INVALID_REQUEST", "Unsupported browser request.");
  }

  incrementControlEpochForTest(actor: ActorIdentity, browserSessionId: string): number { const session = this.getSession(actor, browserSessionId); const epoch = session.incrementControlEpoch(); this.removeSessionSubscriptions(browserSessionId); return epoch; }

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
    this.subscriptions.clear();
    this.workspaceSubscriptions.clear();
    this.workspaceEventSubscribers.clear();
    this.workspaceFrameLedgers.clear();
    for (const [id, session] of [...this.sessions]) {
      session.offFrame(this.onFrame);
      try { await session.close(); this.sessions.delete(id); }
      catch (error) { failures.push(error); }
    }
    this.artifacts.clear();
    this.operations.clear();
    try { await this.profileManager.close(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Browser runtime cleanup failed.");
  }

  private async capabilities(): Promise<unknown> {
    const executableAvailable = await findChromeExecutable(this.chrome.executable).then(() => true, () => false);
    const displayAvailable = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
    const profileRootUsable = await this.profileManager.initialize().then(() => true, () => false);
    const current = this.sessions.size + this.creatingSessions;
    const availableCapacity = Math.max(0, this.maxSessionsGlobal - current);
    const runtimeState = this.closeState === "open" ? "open" : this.closeState === "cleanup-failed" ? "cleanup-failed" : "closing";
    return {
      kind: "capabilities",
      available: executableAvailable && displayAvailable && profileRootUsable && this.egressConfigured && runtimeState === "open" && availableCapacity > 0,
      headed: displayAvailable,
      screenshotFirst: true,
      domFallback: true,
      virtualMouse: true,
      osMouse: false,
      executableAvailable,
      displayAvailable,
      profileRootUsable,
      egressConfigured: this.egressConfigured,
      ...(this.egressBindingId === undefined ? {} : { egressBindingId: this.egressBindingId }),
      runtimeState,
      sessionCapacity: { current, limit: this.maxSessionsGlobal, available: availableCapacity },
    };
  }

  private async execute<T>(actor: ActorIdentity, request: BrowserRequest, laneKey: string, browserSessionId: string | undefined, controlEpoch: number | undefined, task: (context: OperationContext) => Promise<T>, signal?: AbortSignal, connectionId?: string): Promise<T> {
    this.operations.submit(actor, {
      operationId: request.operationId, kind: request.kind, fingerprint: requestFingerprint(request, connectionId), laneKey, deadline: request.deadline,
      ...(browserSessionId !== undefined ? { browserSessionId } : {}), ...("address" in request ? { tabId: request.address.tabId } : {}), ...(controlEpoch !== undefined ? { controlEpoch } : {}),
      ...(request.kind === "tab.close" ? { failOnTargetTermination: false } : {}),
    }, task);
    this.workspaceChanged("operation", browserSessionId, "address" in request ? request.address.tabId : undefined);
    const abort = (): void => { try { this.operations.cancel(actor, request.operationId); } catch { /* Already pruned. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const status: OperationStatus = await this.operations.wait(actor, request.operationId);
      if (status.state !== "committed") { const error = status.error; throw new BrowserProtocolError(error?.code ?? "INTERNAL_ERROR", error?.message ?? `Operation ${status.state}.`, error?.retryable ?? false, error?.details); }
      const result = this.operations.result(actor, request.operationId);
      await this.validateResultResources(actor, result);
      return result as T;
    } finally { signal?.removeEventListener("abort", abort); this.workspaceChanged("operation", browserSessionId, "address" in request ? request.address.tabId : undefined); }
  }

  private async awaitExisting(actor: ActorIdentity, operationId: string, signal?: AbortSignal): Promise<unknown> {
    const status = await this.operations.wait(actor, operationId, signal);
    if (status.state !== "committed") {
      const error = status.error;
      throw new BrowserProtocolError(error?.code ?? "INTERNAL_ERROR", error?.message ?? `Operation ${status.state}.`, error?.retryable ?? false, error?.details);
    }
    const result = this.operations.result(actor, operationId);
    await this.validateResultResources(actor, result);
    return result;
  }

  private async validateResultResources(actor: ActorIdentity, result: unknown): Promise<void> {
    if (!isRecord(result)) return;
    if (result.kind === "screenshotObservation" && typeof result.observationId === "string" && isRecord(result.address) && typeof result.address.browserSessionId === "string") {
      const session = this.sessions.get(result.address.browserSessionId);
      if (session === undefined || actorKey(session.actor) !== actorKey(actor) || !session.observations.hasUsable(result.observationId)) throw new BrowserProtocolError("OBSERVATION_STALE", "Screenshot observation is stale.");
      if (isRecord(result.image) && result.image.kind === "artifact" && typeof result.image.artifactId === "string") await this.artifacts.read(actor, result.image.artifactId);
      return;
    }
    if (result.kind === "domObservation" && typeof result.observationId === "string" && isRecord(result.address) && typeof result.address.browserSessionId === "string") {
      const session = this.sessions.get(result.address.browserSessionId);
      if (session === undefined || actorKey(session.actor) !== actorKey(actor) || !session.dom.hasUsable(result.observationId)) throw new BrowserProtocolError("OBSERVATION_STALE", "DOM observation is stale.");
    }
  }

  private addSubscription(actor: ActorIdentity, connectionId: string, subscriptionId: string, address: TabAddress, interest: "idle" | "selected"): RuntimeSubscription {
    const values = this.subscriptions.get(connectionId) ?? new Map<string, RuntimeSubscription>();
    const existing = values.get(subscriptionId);
    if (existing !== undefined) { if (!sameAddress(existing.address, address) || existing.interest !== interest) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription ID is already bound."); return existing; }
    if (values.size >= this.maxSubscriptionsPerConnection) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Connection subscription limit reached.", true);
    let actorCount = 0; for (const map of this.subscriptions.values()) for (const item of map.values()) if (item.actor === actorKey(actor)) actorCount++;
    if (actorCount >= this.maxSubscriptionsPerActor) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Actor subscription limit reached.", true);
    const subscription: RuntimeSubscription = { actor: actorKey(actor), connectionId, subscriptionId, address: { ...address }, interest, consumerKey: `${connectionId}\u0000${subscriptionId}` };
    values.set(subscriptionId, subscription); this.subscriptions.set(connectionId, values); return subscription;
  }
  private findSubscription(actor: ActorIdentity, connectionId: string, subscriptionId: string): RuntimeSubscription | undefined { const value = this.subscriptions.get(connectionId)?.get(subscriptionId); return value?.actor === actorKey(actor) ? value : undefined; }
  private removeSubscription(connectionId: string, subscriptionId: string, expected: RuntimeSubscription): void { const values = this.subscriptions.get(connectionId); if (values?.get(subscriptionId) !== expected) return; values.delete(subscriptionId); if (values.size === 0) this.subscriptions.delete(connectionId); }
  private pruneWorkspaceLedger(connectionId: string, subscriptionId: string): void { const values = this.workspaceFrameLedgers.get(connectionId)?.filter((item) => item.subscriptionId !== subscriptionId); if (values === undefined || values.length === 0) this.workspaceFrameLedgers.delete(connectionId); else this.workspaceFrameLedgers.set(connectionId, values); }
  private removeTabSubscriptions(sessionId: string, tabId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId && subscription.address.tabId === tabId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } for (const [connectionId, values] of this.workspaceSubscriptions) { for (const [id, subscription] of values) if (subscription.browserSessionId === sessionId && subscription.tabId === tabId) { this.sessions.get(sessionId)?.frames.removeConsumer(subscription.consumerKey); values.delete(id); this.pruneWorkspaceLedger(connectionId, id); } if (values.size === 0) this.workspaceSubscriptions.delete(connectionId); } }
  private removeSessionSubscriptions(sessionId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } for (const [connectionId, values] of this.workspaceSubscriptions) { for (const [id, subscription] of values) if (subscription.browserSessionId === sessionId) { this.sessions.get(sessionId)?.frames.removeConsumer(subscription.consumerKey); values.delete(id); this.pruneWorkspaceLedger(connectionId, id); } if (values.size === 0) this.workspaceSubscriptions.delete(connectionId); } }
  private readonly onFrame = (frame: FrameEvent): void => { this.emit("frame", frame); };
  private workspaceChanged(eventKind: WorkspaceStateEvent["eventKind"], browserSessionId?: string, tabId?: string): void {
    this.workspaceRevision++;
    const event: WorkspaceStateEvent = { protocolVersion: "browser.v2", kind: "workspace.state.changed", revision: this.workspaceRevision, eventKind, ...(browserSessionId === undefined ? {} : { browserSessionId }), ...(tabId === undefined ? {} : { tabId }) };
    this.emit("workspaceState", event);
  }
}

function requestFingerprint(request: BrowserRequest, connectionId?: string): string {
  const semantics = { ...request } as Record<string, unknown>;
  delete semantics.requestId;
  delete semantics.deadline;
  if (request.kind === "frames.subscribe" || request.kind === "frames.unsubscribe") semantics.connectionId = connectionId ?? "unbound";
  return canonicalOperationFingerprint(semantics);
}
function isExecutedRequest(request: BrowserRequest): boolean {
  return request.kind !== "capabilities.get" && request.kind !== "session.list" && request.kind !== "tab.list" && request.kind !== "operation.status" && request.kind !== "operation.cancel" && request.kind !== "artifact.read";
}
function requireConnectionId(connectionId: string | undefined): string { if (connectionId === undefined) throw new BrowserProtocolError("AUTH_FAILED", "Frame operations require a bound connection."); return connectionId; }
function ensureRequestLive(request: BrowserRequest): void { if (Date.parse(request.deadline) <= Date.now()) throw new BrowserProtocolError("DEADLINE_EXCEEDED", "Request deadline has expired."); }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function observationTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_OBSERVATION_TTL_MS || value > MAX_OBSERVATION_TTL_MS) throw new BrowserProtocolError("INVALID_REQUEST", `${name} must be an integer from ${MIN_OBSERVATION_TTL_MS} to ${MAX_OBSERVATION_TTL_MS} milliseconds.`);
  return value;
}
