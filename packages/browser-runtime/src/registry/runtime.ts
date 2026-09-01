import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type BrowserRequest, type FrameEvent, type HumanInputEvent, type OperationStatus, type SessionDescriptor, type TabAddress, type WorkspaceBrokerRequest, type WorkspaceControlFrameBinding, type WorkspaceSnapshot, type WorkspaceStateEvent } from "@webx/browser-protocol";
import { actorKey, DenyNavigationAuthorization, type NavigationAuthorization } from "../actor/identity.js";
import { BrowserArtifactStore } from "../artifacts/store.js";
import { findChromeExecutable, type ChromeHostOptions } from "../chrome/host.js";
import type { FrameSchedulerOptions } from "../frames/scheduler.js";
import { ProfileManager } from "../chrome/profile-manager.js";
import type { ControlLeaseProof } from "../control/session-control.js";
import type { CoordinateAction, DirectHumanInputEvent } from "../motor/session-motor.js";
import { canonicalOperationFingerprint, OperationRegistry, type OperationContext } from "../operations/registry.js";
import { BrowserResourceSupervisor, DEFAULT_BROWSER_RESOURCE_LIMITS, type BrowserResourceLimits, type BrowserResourceReason, type BrowserResourceSupervisorOptions } from "../resources/supervisor.js";
import { BrowserSession, type DomFallbackAction } from "./session.js";

interface RuntimeSubscription { readonly actor: string; readonly connectionId: string; readonly subscriptionId: string; readonly address: TabAddress; readonly interest: "idle" | "selected"; readonly consumerKey: string }
interface WorkspaceSubscription { readonly connectionId: string; readonly subscriptionId: string; readonly browserSessionId: string; readonly tabId: string; readonly interest: "idle" | "selected"; readonly consumerKey: string; controlEpoch: number }
interface WorkspaceFrameSelection { readonly subscriptionId: string; readonly browserSessionId: string; readonly tabId: string }
interface ResourceLimitTerminal {
  readonly owner: string;
  readonly reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">;
  readonly expiresAtMs: number;
}
interface WorkspaceFrameLedgerEntry {
  readonly runtimeInstanceId: string;
  readonly subscriptionId: string;
  readonly actor: ActorIdentity;
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly controlEpoch: number;
  readonly frameSequence: number;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly cssViewportWidth: number;
  readonly cssViewportHeight: number;
  readonly devicePixelRatio: number;
  readonly capturedMonotonicMs: number;
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly deliveredAtMs: number;
}

export const DEFAULT_SCREENSHOT_OBSERVATION_TTL_MS = 60_000;
export const DEFAULT_DOM_OBSERVATION_TTL_MS = 60_000;
export const MIN_OBSERVATION_TTL_MS = 10_000;
export const MAX_OBSERVATION_TTL_MS = 120_000;

const RESOURCE_LIMIT_TERMINAL_TTL_MS = 60_000;
const MAX_RESOURCE_LIMIT_TERMINALS = 64;

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
  frameScheduler?: Pick<FrameSchedulerOptions, "idleIntervalMs" | "selectedIntervalMs" | "burstIntervalMs">;
  /** @deprecated Use screenshotObservationTtlMs. */
  observationFreshnessMsForTest?: number;
  egressConfigured?: boolean;
  egressBindingId?: string;
  requireEgressForSessions?: boolean;
  resourceLimits?: BrowserResourceLimits;
  resourceSupervisor?: BrowserResourceSupervisorOptions;
}

export class BrowserRuntime extends EventEmitter {
  readonly artifacts = new BrowserArtifactStore();
  readonly operations = new OperationRegistry();
  readonly resources: BrowserResourceSupervisor;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly resourceLimitTerminals = new Map<string, ResourceLimitTerminal>();
  private readonly subscriptions = new Map<string, Map<string, RuntimeSubscription>>();
  private readonly workspaceSubscriptions = new Map<string, Map<string, WorkspaceSubscription>>();
  private readonly workspaceEventSubscribers = new Set<string>();
  private readonly workspaceFrameLedgers = new Map<string, WorkspaceFrameLedgerEntry[]>();
  private readonly workspaceInputInFlight = new Map<string, { readonly inputBatchSequence: number; readonly operationId: string; readonly semanticDigest: string; readonly promise: Promise<unknown> }>();
  private readonly workspaceControlOperations = new Map<string, { readonly fingerprint: string; readonly promise: Promise<unknown> }>();
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
  private readonly frameScheduler: Pick<FrameSchedulerOptions, "idleIntervalMs" | "selectedIntervalMs" | "burstIntervalMs"> | undefined;
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
    this.frameScheduler = options.frameScheduler;
    this.egressConfigured = options.egressConfigured ?? options.chrome?.egressProxy !== undefined;
    const proxy = options.chrome?.egressProxy;
    this.egressBindingId = options.egressBindingId ?? (proxy === undefined ? undefined : `forward-proxy://${proxy.host === "::1" ? "[::1]" : proxy.host}:${proxy.port}`);
    this.requireEgressForSessions = options.requireEgressForSessions ?? false;
    this.resources = new BrowserResourceSupervisor(options.resourceLimits ?? DEFAULT_BROWSER_RESOURCE_LIMITS, options.resourceSupervisor);
  }

  get subscriptionCount(): number { let count = 0; for (const values of this.subscriptions.values()) count += values.size; for (const values of this.workspaceSubscriptions.values()) count += values.size; return count; }
  get workspaceSubscriptionCount(): number { let count = 0; for (const values of this.workspaceSubscriptions.values()) count += values.size; return count; }
  get workspaceLedgerCount(): number { let count = 0; for (const values of this.workspaceFrameLedgers.values()) count += values.length; return count; }

  listSessions(actor: ActorIdentity): SessionDescriptor[] { const owner = actorKey(actor); return [...this.sessions.values()].filter((session) => actorKey(session.actor) === owner).map((session) => session.actorDescriptor()); }
  ownsSession(actor: ActorIdentity, browserSessionId: string): boolean { const session = this.sessions.get(browserSessionId); return session !== undefined && actorKey(session.actor) === actorKey(actor); }

  workspaceSnapshot(): WorkspaceSnapshot {
    return {
      kind: "workspaceSnapshot",
      workspaceRevision: this.workspaceRevision,
      generatedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()].map((session) => {
        const descriptor = session.descriptor();
        const control = session.control.snapshot();
        const activeOperation = this.operations.workspaceSummary(descriptor.browserSessionId);
        const resource = session.resourceStatus ?? { state: "normal" as const, reason: "none" as const };
        return {
          browserSessionId: descriptor.browserSessionId,
          agentSessionId: session.actor.agentSessionId,
          actorDisplayId: `actor_${createHash("sha256").update(actorKey(session.actor)).digest("base64url").slice(0, 24)}`,
          pathId: "agentcursor/chrome" as const,
          state: descriptor.state,
          controlState: control.controlState,
          controlEpoch: control.controlEpoch,
          controlTransfer: control.controlTransfer,
          ...(control.selectedHumanControlTabId === undefined ? {} : { selectedHumanControlTabId: control.selectedHumanControlTabId }),
          leaseExpiry: control.leaseExpiry,
          captureReadiness: session.captureReadinessState,
          resource: { state: resource.state, reason: resource.reason },
          personaId: descriptor.personaId,
          cursor: descriptor.cursor,
          tabs: descriptor.tabs.map((tab) => ({ tabId: tab.address.tabId, url: tab.url, title: tab.title.slice(0, 512), state: tab.state, captureReadiness: session.tabCaptureReadiness(tab.address.tabId), documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration, frameSequence: tab.frameSequence })),
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
    assertResourceAdmission(session);
    const subscription: WorkspaceSubscription = { connectionId, subscriptionId, browserSessionId, tabId, interest, consumerKey: `workspace\u0000${connectionId}\u0000${subscriptionId}`, controlEpoch: tab.address.controlEpoch };
    session.subscribeFrames(subscription.consumerKey, tab.address, interest);
    values.set(subscriptionId, subscription);
    this.workspaceSubscriptions.set(connectionId, values);
  }

  async workspaceUnsubscribeFrames(connectionId: string, subscriptionId: string, browserSessionId: string, tabId: string): Promise<void> {
    const values = this.workspaceSubscriptions.get(connectionId);
    if (values === undefined) return;
    const subscription = values.get(subscriptionId);
    if (subscription === undefined) return;
    if (subscription.browserSessionId !== browserSessionId || subscription.tabId !== tabId) throw new BrowserProtocolError("OPERATION_CONFLICT", "Workspace subscription identity does not match.");
    values.delete(subscription.subscriptionId);
    this.pruneWorkspaceLedger(connectionId, subscription.subscriptionId);
    if (values.size === 0) this.workspaceSubscriptions.delete(connectionId);
    await this.sessions.get(subscription.browserSessionId)?.settleFrameConsumerRemoval(subscription.consumerKey);
  }

  workspaceReplaceFrames(connectionId: string, prior: WorkspaceFrameSelection | undefined, next: WorkspaceFrameSelection & { readonly interest: "idle" | "selected" }): FrameEvent | undefined {
    const values = this.workspaceSubscriptions.get(connectionId) ?? new Map<string, WorkspaceSubscription>();
    const priorSubscription = prior === undefined ? undefined : values.get(prior.subscriptionId);
    if (prior !== undefined && (priorSubscription === undefined || priorSubscription.browserSessionId !== prior.browserSessionId || priorSubscription.tabId !== prior.tabId)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Prior workspace selection is no longer current.");
    const existing = values.get(next.subscriptionId);
    if (existing !== undefined) {
      if (existing.browserSessionId !== next.browserSessionId || existing.tabId !== next.tabId || existing.interest !== next.interest || priorSubscription !== undefined) throw new BrowserProtocolError("OPERATION_CONFLICT", "Workspace subscription ID is already bound.");
      const existingSession = this.sessions.get(existing.browserSessionId);
      const existingAddress = existingSession?.descriptor().tabs.find((item) => item.address.tabId === existing.tabId)?.address;
      return existingSession !== undefined && existingAddress !== undefined ? existingSession.latestValidWorkspaceFrame(existingAddress, 2_000) : undefined;
    }
    if (priorSubscription !== undefined && priorSubscription.subscriptionId === next.subscriptionId) throw new BrowserProtocolError("OPERATION_CONFLICT", "Replacement workspace subscription ID must be new.");
    const session = this.sessions.get(next.browserSessionId);
    const tab = session?.descriptor().tabs.find((item) => item.address.tabId === next.tabId);
    if (session === undefined || tab === undefined || tab.state !== "ready") throw new BrowserProtocolError("TAB_NOT_FOUND", "Workspace tab not found.");
    assertResourceAdmission(session);
    const projectedConnectionCount = values.size - Number(priorSubscription !== undefined) + 1;
    const projectedGlobalCount = this.workspaceSubscriptionCount - Number(priorSubscription !== undefined) + 1;
    if (projectedConnectionCount > 16 || projectedGlobalCount > 32) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Workspace subscription limit reached.", true);
    const subscription: WorkspaceSubscription = { connectionId, subscriptionId: next.subscriptionId, browserSessionId: next.browserSessionId, tabId: next.tabId, interest: next.interest, consumerKey: `workspace\u0000${connectionId}\u0000${next.subscriptionId}`, controlEpoch: tab.address.controlEpoch };
    const cached = session.latestValidWorkspaceFrame(tab.address, 2_000);
    session.subscribeFrames(subscription.consumerKey, tab.address, next.interest, cached !== undefined);
    if (priorSubscription !== undefined) this.invalidateWorkspaceSubscription(connectionId, values, priorSubscription, false);
    values.set(next.subscriptionId, subscription);
    this.workspaceSubscriptions.set(connectionId, values);
    return cached;
  }

  workspaceFrameDeliveries(connectionId: string, frame: FrameEvent): Array<{ subscriptionId: string; frame: FrameEvent }> {
    const deliveries: Array<{ subscriptionId: string; frame: FrameEvent }> = [];
    for (const subscription of this.workspaceSubscriptions.get(connectionId)?.values() ?? []) {
      if (subscription.browserSessionId === frame.address.browserSessionId && subscription.tabId === frame.address.tabId && subscription.controlEpoch === frame.address.controlEpoch) deliveries.push({ subscriptionId: subscription.subscriptionId, frame });
    }
    return deliveries;
  }

  recordWorkspaceFrameDelivered(connectionId: string, subscriptionId: string, runtimeInstanceId: string, frame: FrameEvent): void {
    const session = this.sessions.get(frame.address.browserSessionId);
    const subscription = this.workspaceSubscriptions.get(connectionId)?.get(subscriptionId);
    if (session === undefined || subscription === undefined || subscription.browserSessionId !== frame.address.browserSessionId || subscription.tabId !== frame.address.tabId || subscription.controlEpoch !== frame.address.controlEpoch) return;
    const values = (this.workspaceFrameLedgers.get(connectionId) ?? []).filter((item) => Date.now() - item.deliveredAtMs <= 60_000);
    values.push({
      runtimeInstanceId, subscriptionId, actor: session.actor,
      browserSessionId: frame.address.browserSessionId, tabId: frame.address.tabId,
      controlEpoch: frame.address.controlEpoch, frameSequence: frame.frameSequence,
      documentGeneration: frame.documentGeneration, viewportGeneration: frame.viewportGeneration,
      imagePixelWidth: frame.imagePixelWidth, imagePixelHeight: frame.imagePixelHeight,
      cssViewportWidth: frame.viewport.width, cssViewportHeight: frame.viewport.height,
      devicePixelRatio: frame.viewport.devicePixelRatio, capturedMonotonicMs: frame.capturedMonotonicMs,
      artifactId: frame.artifactId, sha256: frame.sha256, byteLength: frame.byteLength, deliveredAtMs: Date.now(),
    });
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

  async workspaceAcquireControl(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.acquire" }>): Promise<unknown> {
    return await this.executeWorkspaceControlOperation(connectionId, request, async () => {
      const session = this.requireWorkspaceSession(request.browserSessionId);
      assertResourceAdmission(session);
      this.requireWorkspaceControlFrame(connectionId, request.browserSessionId, request.tabId, request.frame, 1_500);
      if (request.expectedControlEpoch !== request.frame.controlEpoch) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser control frame epoch does not match the expected state.", true);
      const lease = await session.control.acquire({ connectionId, subscriptionId: request.frame.subscriptionId, tabId: request.tabId, expectedControlEpoch: request.expectedControlEpoch });
      return {
        kind: "workspaceControlLease", browserSessionId: request.browserSessionId,
        selectedTabId: lease.selectedTabId, controlState: "human", controlEpoch: lease.controlEpoch,
        controlTransfer: "none", captureReadiness: "ready", leaseExpiry: "healthy",
        inputTargetGeneration: lease.inputTargetGeneration, leaseId: lease.leaseId,
        leaseExpiresInMs: lease.leaseExpiresInMs,
      };
    });
  }

  workspaceHeartbeatControl(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.heartbeat" }>): unknown {
    const session = this.requireWorkspaceSession(request.browserSessionId);
    const lease = session.control.heartbeat(connectionId, request.leaseId);
    return {
      kind: "workspaceControlHeartbeat", browserSessionId: request.browserSessionId,
      selectedTabId: lease.selectedTabId, controlState: "human", controlEpoch: lease.controlEpoch,
      leaseExpiry: lease.leaseExpiresInMs <= session.control.expectedHeartbeatIntervalMs * 2 ? "expiring" : "healthy",
      leaseExpiresInMs: lease.leaseExpiresInMs,
    };
  }

  async workspaceReleaseControl(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.release" }>): Promise<unknown> {
    return await this.executeWorkspaceControlOperation(connectionId, request, async () => {
      const session = this.requireWorkspaceSession(request.browserSessionId);
      await session.control.release({ connectionId, leaseId: request.leaseId });
      return this.workspaceControlStatus(request.browserSessionId);
    });
  }

  async workspaceInputBatch(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.input.batch" }>, signal?: AbortSignal): Promise<unknown> {
    const session = this.requireWorkspaceSession(request.browserSessionId);
    assertResourceAdmission(session);
    const proof: ControlLeaseProof = {
      connectionId, leaseId: request.leaseId, browserSessionId: request.browserSessionId,
      tabId: request.tabId, controlEpoch: request.controlEpoch, inputTargetGeneration: request.inputTargetGeneration,
    };
    session.control.authorizeInputLease(proof);
    let semanticDigest: string;
    try {
      semanticDigest = session.humanInput.semanticFingerprint(request);
    } catch (error) {
      session.humanInput.stop();
      await this.terminateControlFailedSession(request.browserSessionId);
      throw error;
    }
    const retained = session.humanInput.retainedAcknowledgement(request.inputBatchSequence, request.operationId, semanticDigest);
    if (retained !== undefined) return retained;
    const active = this.workspaceInputInFlight.get(request.browserSessionId);
    if (active !== undefined) {
      if (active.inputBatchSequence === request.inputBatchSequence && active.operationId === request.operationId && active.semanticDigest === semanticDigest) return await active.promise;
      if (active.inputBatchSequence === request.inputBatchSequence || active.operationId === request.operationId) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser input retry conflicts with an active batch.", false);
      throw new BrowserProtocolError("INPUT_RATE_LIMITED", "A browser input batch is already in flight.", true);
    }
    const promise = this.dispatchWorkspaceInputBatch(session, connectionId, request, proof, semanticDigest, signal);
    const record = { inputBatchSequence: request.inputBatchSequence, operationId: request.operationId, semanticDigest, promise };
    this.workspaceInputInFlight.set(request.browserSessionId, record);
    try { return await promise; }
    finally { if (this.workspaceInputInFlight.get(request.browserSessionId) === record) this.workspaceInputInFlight.delete(request.browserSessionId); }
  }

  private async dispatchWorkspaceInputBatch(session: BrowserSession, connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.input.batch" }>, proof: ControlLeaseProof, semanticDigest: string, signal?: AbortSignal): Promise<unknown> {
    const releaseOnly = isHeldReleaseOnly(request.events, session.motor);
    const ledger = this.requireWorkspaceControlFrame(
      connectionId, request.browserSessionId, request.tabId, request.frame,
      releaseOnly ? Number.POSITIVE_INFINITY : inputFrameFreshnessMs(request.events),
      releaseOnly,
    );
    const events = mapHumanInputEvents(request.events, ledger, releaseOnly ? { x: session.motor.state.x, y: session.motor.state.y } : undefined);
    if (!releaseOnly) session.humanInput.assertFrameGuard(request.frame.frameSequence, events);
    let awaitingNewFrame = false;
    let reserved = false;
    let dispatched;
    try {
      dispatched = await session.dispatchHumanInput(request.tabId, request.controlEpoch, events, () => {
        session.control.commitInputBatch(proof, request.inputBatchSequence);
        reserved = true;
        awaitingNewFrame = session.humanInput.noteFrameGuard(request.frame.frameSequence, events);
      }, signal);
    } catch (error) {
      if (reserved) {
        session.humanInput.stop();
        void this.terminateControlFailedSession(request.browserSessionId);
      }
      throw error;
    }
    if (awaitingNewFrame) session.frames.requestCapture(request.tabId);
    const acknowledgement = {
      kind: "workspaceInputAck" as const,
      inputBatchSequence: request.inputBatchSequence,
      acceptedEventCount: request.events.length,
      coalescedPointerMoveCount: dispatched.coalescedPointerMoveCount,
      awaitingNewFrame,
    };
    session.humanInput.retainAcknowledgement(request.operationId, semanticDigest, acknowledgement);
    return acknowledgement;
  }

  workspaceControlStatus(browserSessionId: string): unknown {
    const session = this.requireWorkspaceSession(browserSessionId);
    const control = session.control.snapshot();
    return {
      kind: "workspaceControlStatus", browserSessionId,
      controlState: control.controlState, controlEpoch: control.controlEpoch,
      controlTransfer: control.controlTransfer,
      ...(control.selectedHumanControlTabId === undefined ? {} : { selectedHumanControlTabId: control.selectedHumanControlTabId }),
      captureReadiness: session.captureReadinessState, leaseExpiry: control.leaseExpiry,
    };
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
    for (const session of this.sessions.values()) session.control.workspaceDisconnected(connectionId);
    const workspace = this.workspaceSubscriptions.get(connectionId);
    this.workspaceSubscriptions.delete(connectionId);
    this.workspaceEventSubscribers.delete(connectionId);
    this.workspaceFrameLedgers.delete(connectionId);
    for (const key of [...this.workspaceControlOperations.keys()]) if (key.startsWith(`${connectionId}\u0000`)) this.workspaceControlOperations.delete(key);
    for (const subscription of workspace?.values() ?? []) this.sessions.get(subscription.browserSessionId)?.frames.removeConsumer(subscription.consumerKey);
  }

  private async executeWorkspaceControlOperation(connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.acquire" | "workspace.control.release" }>, task: () => Promise<unknown>): Promise<unknown> {
    const key = `${connectionId}\u0000${request.operationId}`;
    const fingerprint = workspaceControlFingerprint(request);
    const existing = this.workspaceControlOperations.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser control operation identity is already bound.", false);
      return await existing.promise;
    }
    const promise = task();
    this.workspaceControlOperations.set(key, { fingerprint, promise });
    while (this.workspaceControlOperations.size > 128) {
      const first = this.workspaceControlOperations.keys().next().value as string | undefined;
      if (first === undefined || first === key) break;
      this.workspaceControlOperations.delete(first);
    }
    return await promise;
  }

  private fenceSessionAuthority(browserSessionId: string, nextEpoch: number): void {
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 1) throw new BrowserProtocolError("CONTROL_TRANSFER_PENDING", "Browser control epoch is unavailable.", true);
    for (const [connectionId, values] of this.subscriptions) {
      for (const [subscriptionId, subscription] of values) if (subscription.address.browserSessionId === browserSessionId) values.delete(subscriptionId);
      if (values.size === 0) this.subscriptions.delete(connectionId);
    }
    for (const [connectionId, entries] of this.workspaceFrameLedgers) {
      const retained = entries.filter((entry) => entry.browserSessionId !== browserSessionId);
      if (retained.length === 0) this.workspaceFrameLedgers.delete(connectionId); else this.workspaceFrameLedgers.set(connectionId, retained);
    }
  }

  private async establishHumanWorkspaceFrameStream(connectionId: string, subscriptionId: string, browserSessionId: string, tabId: string, epoch: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = this.requireWorkspaceSession(browserSessionId);
    const values = this.workspaceSubscriptions.get(connectionId);
    const selected = values?.get(subscriptionId);
    if (selected === undefined || selected.browserSessionId !== browserSessionId || selected.tabId !== tabId || selected.interest !== "selected") {
      throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser control selection is no longer current.", true);
    }
    for (const [otherConnectionId, otherValues] of this.workspaceSubscriptions) {
      for (const subscription of [...otherValues.values()]) {
        if (subscription.browserSessionId === browserSessionId && subscription !== selected) this.invalidateWorkspaceSubscription(otherConnectionId, otherValues, subscription);
      }
    }
    const tab = session.descriptor().tabs.find((item) => item.address.tabId === tabId);
    if (tab === undefined || tab.state !== "ready" || tab.address.controlEpoch !== epoch) throw new BrowserProtocolError("CONTROL_NOT_READY", "Browser view is preparing.", true);
    selected.controlEpoch = epoch;
    session.subscribeFrames(selected.consumerKey, tab.address, "selected");
    signal.throwIfAborted();
  }

  private async establishAgentWorkspaceFrameStreams(browserSessionId: string, epoch: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = this.requireWorkspaceSession(browserSessionId);
    for (const values of this.workspaceSubscriptions.values()) {
      for (const subscription of values.values()) {
        if (subscription.browserSessionId !== browserSessionId) continue;
        const tab = session.descriptor().tabs.find((item) => item.address.tabId === subscription.tabId);
        if (tab === undefined || tab.state !== "ready" || tab.address.controlEpoch !== epoch) continue;
        subscription.controlEpoch = epoch;
        session.subscribeFrames(subscription.consumerKey, tab.address, subscription.interest);
      }
    }
    signal.throwIfAborted();
  }

  private async terminateResourceLimitedSession(browserSessionId: string, reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void> {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined) return;
    session.setResourceStatus({ state: "closing", reason });
    await session.close();
    if (this.sessions.get(browserSessionId) !== session) return;
    this.sessions.delete(browserSessionId);
    this.rememberResourceLimitTerminal(session.actor, browserSessionId, reason);
    this.removeSessionSubscriptions(browserSessionId);
    this.workspaceChanged("session", browserSessionId);
  }

  private async terminateControlFailedSession(browserSessionId: string): Promise<void> {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined) return;
    try { await session.close(); } catch { /* The failed control session remains terminal and inaccessible. */ }
    if (this.sessions.get(browserSessionId) !== session) return;
    this.sessions.delete(browserSessionId);
    this.resources.unregister(browserSessionId);
    this.removeSessionSubscriptions(browserSessionId);
    this.workspaceChanged("session", browserSessionId);
  }

  private requireWorkspaceSession(browserSessionId: string): BrowserSession {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined) throw new BrowserProtocolError("SESSION_NOT_FOUND", "Browser session not found.");
    return session;
  }

  private requireWorkspaceControlFrame(connectionId: string, browserSessionId: string, tabId: string, binding: WorkspaceControlFrameBinding, maxAgeMs: number, releaseException = false): WorkspaceFrameLedgerEntry {
    const values = (this.workspaceFrameLedgers.get(connectionId) ?? []).filter((entry) => Date.now() - entry.deliveredAtMs <= 60_000);
    if (values.length === 0) this.workspaceFrameLedgers.delete(connectionId); else this.workspaceFrameLedgers.set(connectionId, values);
    const exact = [...values].reverse().find((entry) => entry.subscriptionId === binding.subscriptionId
      && entry.runtimeInstanceId === binding.runtimeInstanceId && entry.browserSessionId === browserSessionId && entry.tabId === tabId
      && entry.controlEpoch === binding.controlEpoch && entry.frameSequence === binding.frameSequence
      && entry.documentGeneration === binding.documentGeneration && entry.viewportGeneration === binding.viewportGeneration
      && entry.imagePixelWidth === binding.imagePixelWidth && entry.imagePixelHeight === binding.imagePixelHeight);
    const subscription = this.workspaceSubscriptions.get(connectionId)?.get(binding.subscriptionId);
    if (exact === undefined || subscription === undefined
      || subscription.browserSessionId !== browserSessionId || subscription.tabId !== tabId
      || (!releaseException && subscription.controlEpoch !== binding.controlEpoch)
      || performance.now() - exact.capturedMonotonicMs > maxAgeMs) {
      throw new BrowserProtocolError("INPUT_FRAME_STALE", "Browser control frame is stale.", true);
    }
    const session = this.requireWorkspaceSession(browserSessionId);
    const tab = session.descriptor().tabs.find((item) => item.address.tabId === tabId);
    if (tab === undefined || tab.state !== "ready") throw new BrowserProtocolError("INPUT_FRAME_STALE", "Browser control frame is stale.", true);
    if (!releaseException && (tab.address.controlEpoch !== binding.controlEpoch
      || tab.documentGeneration !== binding.documentGeneration || tab.viewportGeneration !== binding.viewportGeneration
      || !this.artifacts.hasWorkspaceFrame(exact.actor, exact.artifactId, browserSessionId, tabId, exact.sha256, exact.byteLength))) {
      throw new BrowserProtocolError("INPUT_FRAME_STALE", "Browser control frame is stale.", true);
    }
    return exact;
  }

  private getSession(actor: ActorIdentity, browserSessionId: string): BrowserSession {
    const session = this.sessions.get(browserSessionId);
    if (session !== undefined) {
      if (actorKey(session.actor) !== actorKey(actor)) throw new BrowserProtocolError("SESSION_NOT_FOUND", "Browser session not found.");
      return session;
    }
    this.pruneResourceLimitTerminals();
    const terminal = this.resourceLimitTerminals.get(browserSessionId);
    if (terminal?.owner === actorKey(actor)) throw new BrowserProtocolError("BROWSER_RESOURCE_LIMIT", "Browser session reached a resource limit.", false, { reason: terminal.reason });
    throw new BrowserProtocolError("SESSION_NOT_FOUND", "Browser session not found.");
  }

  private rememberResourceLimitTerminal(actor: ActorIdentity, browserSessionId: string, reason: ResourceLimitTerminal["reason"]): void {
    this.pruneResourceLimitTerminals();
    this.resourceLimitTerminals.delete(browserSessionId);
    this.resourceLimitTerminals.set(browserSessionId, { owner: actorKey(actor), reason, expiresAtMs: Date.now() + RESOURCE_LIMIT_TERMINAL_TTL_MS });
    while (this.resourceLimitTerminals.size > MAX_RESOURCE_LIMIT_TERMINALS) {
      const oldest = this.resourceLimitTerminals.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.resourceLimitTerminals.delete(oldest);
    }
  }

  private pruneResourceLimitTerminals(): void {
    const now = Date.now();
    for (const [browserSessionId, terminal] of this.resourceLimitTerminals) if (terminal.expiresAtMs <= now) this.resourceLimitTerminals.delete(browserSessionId);
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
      if (existing !== undefined) {
        if (request.kind !== "session.create") {
          const existingSessionId = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.browserSessionId : request.address.browserSessionId;
          const existingSession = this.sessions.get(existingSessionId);
          if (request.kind !== "session.close") assertResourceAdmission(existingSession);
          existingSession?.control?.assertAgentAdmission();
        }
        return await this.awaitExisting(actor, request.operationId, signal);
      }
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
            ...(this.frameScheduler === undefined ? {} : { frameScheduler: this.frameScheduler }),
            controlIntegration: {
              authorityFenced: (browserSessionId, nextEpoch) => this.fenceSessionAuthority(browserSessionId, nextEpoch),
              establishHumanFrameStream: async (connectionId, subscriptionId, browserSessionId, tabId, epoch, signal) => await this.establishHumanWorkspaceFrameStream(connectionId, subscriptionId, browserSessionId, tabId, epoch, signal),
              establishAgentFrameStream: async (browserSessionId, epoch, signal) => await this.establishAgentWorkspaceFrameStreams(browserSessionId, epoch, signal),
              changed: (browserSessionId) => this.workspaceChanged("control", browserSessionId),
              terminalCleanupRequired: (browserSessionId) => { void this.terminateControlFailedSession(browserSessionId); },
            },
          }, context.signal, () => context.markDispatched());
          if (context.signal.aborted) { await session.close(); throw context.signal.reason; }
          this.resourceLimitTerminals.delete(session.browserSessionId);
          this.sessions.set(session.browserSessionId, session);
          this.resources.register({
            browserSessionId: session.browserSessionId,
            processIdentity: session.processIdentity,
            profileDirectory: session.profileDirectory,
            controlState: () => session.control.state,
            hasRunningWork: () => this.operations.hasPendingSession(session.actor, session.browserSessionId),
            fence: (reason) => {
              session.setResourceStatus({ state: "draining", reason });
              this.removeSessionSubscriptions(session.browserSessionId);
              this.workspaceChanged("runtime", session.browserSessionId);
            },
            cancelOperations: () => this.operations.limitSession(session.actor, session.browserSessionId),
            awaitOperationSettlement: async (resourceSignal) => await this.operations.awaitSessionSettlement(session.actor, session.browserSessionId, resourceSignal),
            returnHumanControl: async (resourceSignal) => await session.returnHumanControlForResourceLimit(resourceSignal),
            close: async (reason) => await this.terminateResourceLimitedSession(session.browserSessionId, reason),
            changed: (status) => { session.setResourceStatus(status); this.workspaceChanged("runtime", session.browserSessionId); },
          });
          session.onFrame(this.onFrame);
          session.onCaptureReadiness(() => this.workspaceChanged("control", session.browserSessionId));
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

    if (request.kind === "tab.list") return { kind: "tabs", tabs: session.listTabs() };
    if (request.kind !== "session.close") assertResourceAdmission(session);
    session.control?.assertAgentAdmission();

    if (request.kind === "session.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); context.markDispatched(); await session.close(); this.sessions.delete(browserSessionId); this.resources.unregister(browserSessionId); this.removeSessionSubscriptions(browserSessionId); this.workspaceChanged("session", browserSessionId); return session.descriptor(); }, signal);
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
    try { await this.resources.close(); } catch (error) { failures.push(error); }
    this.subscriptions.clear();
    this.workspaceSubscriptions.clear();
    this.workspaceEventSubscribers.clear();
    this.workspaceFrameLedgers.clear();
    this.workspaceControlOperations.clear();
    this.workspaceInputInFlight.clear();
    this.resourceLimitTerminals.clear();
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
    const resourceSupervision = this.resources.summary();
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
      resourceSupervision,
      sessionCapacity: { current, limit: this.maxSessionsGlobal, available: availableCapacity },
    };
  }

  private async execute<T>(actor: ActorIdentity, request: BrowserRequest, laneKey: string, browserSessionId: string | undefined, controlEpoch: number | undefined, task: (context: OperationContext) => Promise<T>, signal?: AbortSignal, connectionId?: string): Promise<T> {
    this.operations.submit(actor, {
      operationId: request.operationId, kind: request.kind, fingerprint: requestFingerprint(request, connectionId), laneKey, deadline: request.deadline,
      ...(browserSessionId !== undefined ? { browserSessionId } : {}), ...("address" in request ? { tabId: request.address.tabId } : {}), ...(controlEpoch !== undefined ? { controlEpoch } : {}),
      ...(request.kind === "tab.close" ? { failOnTargetTermination: false } : {}),
    }, async (context) => {
      if (browserSessionId !== undefined) {
        const activeSession = this.getSession(actor, browserSessionId);
        if (request.kind !== "session.close") assertResourceAdmission(activeSession);
        activeSession.control?.assertAgentAdmission();
      }
      return await task(context);
    });
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
  private invalidateWorkspaceSubscription(connectionId: string, values: Map<string, WorkspaceSubscription>, subscription: WorkspaceSubscription, removeEmpty = true): void {
    if (values.get(subscription.subscriptionId) !== subscription) return;
    values.delete(subscription.subscriptionId);
    this.sessions.get(subscription.browserSessionId)?.invalidateFrameConsumer(subscription.consumerKey);
    this.pruneWorkspaceLedger(connectionId, subscription.subscriptionId);
    if (removeEmpty && values.size === 0) this.workspaceSubscriptions.delete(connectionId);
  }
  private pruneWorkspaceLedger(connectionId: string, subscriptionId: string): void { const values = this.workspaceFrameLedgers.get(connectionId)?.filter((item) => item.subscriptionId !== subscriptionId); if (values === undefined || values.length === 0) this.workspaceFrameLedgers.delete(connectionId); else this.workspaceFrameLedgers.set(connectionId, values); }
  private removeTabSubscriptions(sessionId: string, tabId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId && subscription.address.tabId === tabId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } for (const [connectionId, values] of this.workspaceSubscriptions) { for (const [id, subscription] of values) if (subscription.browserSessionId === sessionId && subscription.tabId === tabId) { this.sessions.get(sessionId)?.frames.removeConsumer(subscription.consumerKey); values.delete(id); this.pruneWorkspaceLedger(connectionId, id); } if (values.size === 0) this.workspaceSubscriptions.delete(connectionId); } }
  private removeSessionSubscriptions(sessionId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } for (const [connectionId, values] of this.workspaceSubscriptions) { for (const [id, subscription] of values) if (subscription.browserSessionId === sessionId) { this.sessions.get(sessionId)?.frames.removeConsumer(subscription.consumerKey); values.delete(id); this.pruneWorkspaceLedger(connectionId, id); } if (values.size === 0) this.workspaceSubscriptions.delete(connectionId); } }
  private readonly onFrame = (frame: FrameEvent): void => { this.emit("frame", frame); };
  private workspaceChanged(eventKind: WorkspaceStateEvent["eventKind"], browserSessionId?: string, tabId?: string): void {
    this.workspaceRevision++;
    const event: WorkspaceStateEvent = { protocolVersion: PROTOCOL_VERSION, kind: "workspace.state.changed", revision: this.workspaceRevision, eventKind, ...(browserSessionId === undefined ? {} : { browserSessionId }), ...(tabId === undefined ? {} : { tabId }) };
    this.emit("workspaceState", event);
  }
}

function isHeldReleaseOnly(events: readonly HumanInputEvent[], motor: { isButtonHeld(button: "left" | "middle" | "right"): boolean; isHumanKeyHeld(key: string, code?: string): boolean }): boolean {
  if (events.length === 0) return false;
  const releasedButtons = new Set<string>();
  const releasedKeys = new Set<string>();
  for (const event of events) {
    if (event.kind === "pointerUp") {
      if (releasedButtons.has(event.button) || !motor.isButtonHeld(event.button)) return false;
      releasedButtons.add(event.button);
    } else if (event.kind === "keyUp") {
      const identity = event.code ?? event.key;
      if (releasedKeys.has(identity) || !motor.isHumanKeyHeld(event.key, event.code)) return false;
      releasedKeys.add(identity);
    } else return false;
  }
  return true;
}

function inputFrameFreshnessMs(events: readonly HumanInputEvent[]): number {
  if (events.some((event) => event.kind === "pointerDown" || event.kind === "pointerUp" || event.kind === "wheel")) return 2_000;
  if (events.some((event) => event.kind === "keyDown" || event.kind === "keyUp" || event.kind === "text")) return 3_000;
  return 5_000;
}

function mapHumanInputEvents(events: readonly HumanInputEvent[], frame: WorkspaceFrameLedgerEntry, staleReleasePoint?: { readonly x: number; readonly y: number }): DirectHumanInputEvent[] {
  const point = (value: { readonly imageX: number; readonly imageY: number }): { readonly x: number; readonly y: number } => {
    if (!Number.isFinite(value.imageX) || !Number.isFinite(value.imageY)
      || value.imageX < 0 || value.imageY < 0 || value.imageX >= frame.imagePixelWidth || value.imageY >= frame.imagePixelHeight) {
      throw new BrowserProtocolError("COORDINATE_OUT_OF_BOUNDS", "Browser input coordinate is outside the painted frame.");
    }
    return {
      x: value.imageX * frame.cssViewportWidth / frame.imagePixelWidth,
      y: value.imageY * frame.cssViewportHeight / frame.imagePixelHeight,
    };
  };
  return events.map((event): DirectHumanInputEvent => {
    if (event.kind === "pointerMove") return { kind: event.kind, point: point(event.point) };
    if (event.kind === "pointerDown" || event.kind === "pointerUp") return { kind: event.kind, point: event.kind === "pointerUp" && staleReleasePoint !== undefined ? staleReleasePoint : point(event.point), button: event.button, clickCount: event.clickCount ?? 1 };
    if (event.kind === "wheel") return { kind: event.kind, point: point(event.point), deltaX: event.deltaX, deltaY: event.deltaY };
    if (event.kind === "keyDown") return { kind: event.kind, key: event.key, ...(event.code === undefined ? {} : { code: event.code }), location: event.location ?? 0, modifiers: event.modifiers ?? 0, repeat: event.repeat ?? false };
    if (event.kind === "keyUp") return { kind: event.kind, key: event.key, ...(event.code === undefined ? {} : { code: event.code }), location: event.location ?? 0, modifiers: event.modifiers ?? 0 };
    return { kind: "text", text: event.text };
  });
}

function workspaceControlFingerprint(request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.acquire" | "workspace.control.release" }>): string {
  const semantics = request.kind === "workspace.control.acquire"
    ? { kind: request.kind, browserSessionId: request.browserSessionId, tabId: request.tabId, expectedControlEpoch: request.expectedControlEpoch, frame: request.frame }
    : { kind: request.kind, browserSessionId: request.browserSessionId, leaseId: request.leaseId };
  return createHash("sha256").update(JSON.stringify(semantics)).digest("base64url");
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
function assertResourceAdmission(session: BrowserSession | undefined): void { (session as unknown as { assertResourceAdmission?: () => void } | undefined)?.assertResourceAdmission?.(); }
function observationTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_OBSERVATION_TTL_MS || value > MAX_OBSERVATION_TTL_MS) throw new BrowserProtocolError("INVALID_REQUEST", `${name} must be an integer from ${MIN_OBSERVATION_TTL_MS} to ${MAX_OBSERVATION_TTL_MS} milliseconds.`);
  return value;
}
