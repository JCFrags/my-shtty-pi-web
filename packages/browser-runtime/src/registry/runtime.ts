import { EventEmitter } from "node:events";
import { BrowserProtocolError, type ActorIdentity, type BrowserRequest, type FrameEvent, type OperationStatus, type SessionDescriptor, type TabAddress } from "@webx/browser-protocol";
import { actorKey, DenyNavigationAuthorization, type NavigationAuthorization } from "../actor/identity.js";
import { BrowserArtifactStore } from "../artifacts/store.js";
import type { ChromeHostOptions } from "../chrome/host.js";
import { ProfileManager } from "../chrome/profile-manager.js";
import type { CoordinateAction } from "../motor/session-motor.js";
import { canonicalOperationFingerprint, OperationRegistry, type OperationContext } from "../operations/registry.js";
import { BrowserSession, type DomFallbackAction } from "./session.js";

interface RuntimeSubscription { readonly actor: string; readonly connectionId: string; readonly subscriptionId: string; readonly address: TabAddress; readonly interest: "idle" | "selected"; readonly consumerKey: string }

export interface BrowserRuntimeOptions {
  navigationAuthorization?: NavigationAuthorization;
  chrome?: Omit<ChromeHostOptions, "hostId" | "profileManager">;
  maxSessionsPerActor?: number;
  maxSubscriptionsPerConnection?: number;
  maxSubscriptionsPerActor?: number;
  personaSeedForTest?: number;
  motorMinimumPathMsForTest?: number;
  observationFreshnessMsForTest?: number;
}

export class BrowserRuntime extends EventEmitter {
  readonly artifacts = new BrowserArtifactStore();
  readonly operations = new OperationRegistry();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly subscriptions = new Map<string, Map<string, RuntimeSubscription>>();
  private readonly navigationAuthorization: NavigationAuthorization;
  private readonly chrome: Omit<ChromeHostOptions, "hostId" | "profileManager">;
  private readonly profileManager: ProfileManager;
  private readonly maxSessionsPerActor: number;
  private readonly maxSubscriptionsPerConnection: number;
  private readonly maxSubscriptionsPerActor: number;
  private readonly personaSeedForTest: number | undefined;
  private readonly motorMinimumPathMsForTest: number;
  private readonly observationFreshnessMsForTest: number | undefined;

  constructor(options: BrowserRuntimeOptions = {}) {
    super();
    this.navigationAuthorization = options.navigationAuthorization ?? new DenyNavigationAuthorization();
    this.chrome = options.chrome ?? {};
    this.profileManager = new ProfileManager(this.chrome.profileRoot);
    this.maxSessionsPerActor = options.maxSessionsPerActor ?? 4;
    this.maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection ?? 64;
    this.maxSubscriptionsPerActor = options.maxSubscriptionsPerActor ?? 256;
    this.personaSeedForTest = options.personaSeedForTest;
    this.motorMinimumPathMsForTest = options.motorMinimumPathMsForTest ?? 0;
    this.observationFreshnessMsForTest = options.observationFreshnessMsForTest;
  }

  get subscriptionCount(): number { let count = 0; for (const values of this.subscriptions.values()) count += values.size; return count; }

  listSessions(actor: ActorIdentity): SessionDescriptor[] { const owner = actorKey(actor); return [...this.sessions.values()].filter((session) => actorKey(session.actor) === owner).map((session) => session.descriptor()); }
  ownsSession(actor: ActorIdentity, browserSessionId: string): boolean { const session = this.sessions.get(browserSessionId); return session !== undefined && actorKey(session.actor) === actorKey(actor); }

  shouldDeliverFrame(connectionId: string, actor: ActorIdentity, frame: FrameEvent): boolean {
    for (const subscription of this.subscriptions.get(connectionId)?.values() ?? []) if (subscription.actor === actorKey(actor) && sameAddress(subscription.address, frame.address)) return true;
    return false;
  }

  releaseConnection(connectionId: string): void {
    const values = this.subscriptions.get(connectionId);
    if (values === undefined) return;
    this.subscriptions.delete(connectionId);
    for (const subscription of values.values()) this.sessions.get(subscription.address.browserSessionId)?.frames.removeConsumer(subscription.consumerKey);
  }

  private getSession(actor: ActorIdentity, browserSessionId: string): BrowserSession {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined || actorKey(session.actor) !== actorKey(actor)) throw new BrowserProtocolError("SESSION_NOT_FOUND", "Browser session not found.");
    return session;
  }

  async dispatch(actor: ActorIdentity, request: BrowserRequest, signal?: AbortSignal, connectionId?: string): Promise<unknown> {
    ensureRequestLive(request);
    signal?.throwIfAborted();
    if (request.kind === "capabilities.get") return { kind: "capabilities", headed: true, screenshotFirst: true, domFallback: true, virtualMouse: true, osMouse: false };
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

    if (request.kind === "session.create") {
      return await this.execute(actor, request, `actor:${actorKey(actor)}:sessions`, undefined, undefined, async (context) => {
        context.checkpoint();
        if (this.listSessions(actor).length >= this.maxSessionsPerActor) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Browser session limit reached.", true);
        const session = await BrowserSession.create(actor, this.operations, this.artifacts, this.navigationAuthorization, {
          ...this.chrome, profileManager: this.profileManager,
          ...(request.initialUrl !== undefined ? { initialUrl: request.initialUrl } : {}),
          ...(this.personaSeedForTest !== undefined ? { personaSeed: this.personaSeedForTest } : {}),
          motorMinimumPathMs: this.motorMinimumPathMsForTest,
          ...(this.observationFreshnessMsForTest !== undefined ? { observationFreshnessMs: this.observationFreshnessMsForTest } : {}),
        }, context.signal, () => context.markDispatched());
        if (context.signal.aborted) { await session.close(); throw context.signal.reason; }
        this.sessions.set(session.browserSessionId, session);
        session.onFrame(this.onFrame);
        session.targets.on("tabTerminal", ({ tabId }: { tabId: string }) => this.removeTabSubscriptions(session.browserSessionId, tabId));
        return session.descriptor();
      }, signal);
    }

    const browserSessionId = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.browserSessionId : request.address.browserSessionId;
    const session = this.getSession(actor, browserSessionId);
    const controlEpoch = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.controlEpoch : request.address.controlEpoch;
    const motorLane = `motor:${actorKey(actor)}:${browserSessionId}`;

    if (request.kind === "session.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); context.markDispatched(); await session.close(); this.sessions.delete(browserSessionId); this.removeSessionSubscriptions(browserSessionId); return session.descriptor(); }, signal);
    if (request.kind === "tab.list") return { kind: "tabs", tabs: session.listTabs() };
    if (request.kind === "tab.create") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const tab = await session.createTab(request.url, context.signal, () => context.markDispatched()); return session.listTabs().find((item) => item.address.tabId === tab.tabId); }, signal);
    if (request.kind === "tab.focus") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.targets.focus(request.address, context.signal, () => context.markDispatched()); return session.listTabs().find((item) => item.address.tabId === request.address.tabId); }, signal);
    if (request.kind === "tab.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const tab = session.resolve(request.address); if (session.motor.isActiveTab(tab.tabId)) await session.motor.releaseAll(tab); await session.targets.closeTab(request.address, context.signal, () => context.markDispatched()); this.removeTabSubscriptions(browserSessionId, request.address.tabId); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "observe.screenshot") return await this.execute(actor, request, `capture:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async (context) => await session.observe(request.address, request.delivery, context.signal), signal);
    if (request.kind === "observe.domFallback") return await this.execute(actor, request, `dom:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async () => await session.observeDom(request.address, request.maxNodes), signal);
    if (request.kind === "action.coordinate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.coordinate(request.address, request.observationId, request.action as CoordinateAction, context, request.riskPolicy); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "action.domFallback") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.domAction(request.address, request.domObservationId, request.handle, request.action as DomFallbackAction, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "navigate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.navigate(request.address, request.url, context.signal, () => context.markDispatched()); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.text") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.typeText(request.address, request.text, request.replace ?? false, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.key") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.pressKey(request.address, request.key, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "frames.subscribe") return await this.execute(actor, request, `frames:${browserSessionId}`, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const id = requireConnectionId(connectionId); const subscription = this.addSubscription(actor, id, request.subscriptionId, request.address, request.interest ?? "selected"); session.subscribeFrames(subscription.consumerKey, request.address, subscription.interest); context.markDispatched(); return { kind: "subscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: true }; }, signal);
    if (request.kind === "frames.unsubscribe") return await this.execute(actor, request, `frames:${browserSessionId}`, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const id = requireConnectionId(connectionId); const subscription = this.findSubscription(actor, id, request.subscriptionId); if (subscription !== undefined) { if (!sameAddress(subscription.address, request.address)) throw new BrowserProtocolError("OPERATION_CONFLICT", "Frame subscription address does not match."); session.unsubscribeFrames(subscription.consumerKey, request.address); this.subscriptions.get(id)?.delete(request.subscriptionId); } context.markDispatched(); return { kind: "subscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: false }; }, signal);
    throw new BrowserProtocolError("INVALID_REQUEST", "Unsupported browser request.");
  }

  incrementControlEpochForTest(actor: ActorIdentity, browserSessionId: string): number { const session = this.getSession(actor, browserSessionId); const epoch = session.incrementControlEpoch(); this.removeSessionSubscriptions(browserSessionId); return epoch; }

  async close(): Promise<void> { const sessions = [...this.sessions.values()]; this.sessions.clear(); this.subscriptions.clear(); await Promise.allSettled(sessions.map(async (session) => { session.offFrame(this.onFrame); await session.close(); })); this.artifacts.clear(); this.operations.clear(); }

  private async execute<T>(actor: ActorIdentity, request: BrowserRequest, laneKey: string, browserSessionId: string | undefined, controlEpoch: number | undefined, task: (context: OperationContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.operations.submit(actor, {
      operationId: request.operationId, fingerprint: requestFingerprint(request), laneKey, deadline: request.deadline,
      ...(browserSessionId !== undefined ? { browserSessionId } : {}), ...("address" in request ? { tabId: request.address.tabId } : {}), ...(controlEpoch !== undefined ? { controlEpoch } : {}),
    }, task);
    const abort = (): void => { try { this.operations.cancel(actor, request.operationId); } catch { /* Already pruned. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const status: OperationStatus = await this.operations.wait(actor, request.operationId);
      if (status.state !== "committed") { const error = status.error; throw new BrowserProtocolError(error?.code ?? "INTERNAL_ERROR", error?.message ?? `Operation ${status.state}.`, error?.retryable ?? false, error?.details); }
      return this.operations.result(actor, request.operationId) as T;
    } finally { signal?.removeEventListener("abort", abort); }
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
  private removeTabSubscriptions(sessionId: string, tabId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId && subscription.address.tabId === tabId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } }
  private removeSessionSubscriptions(sessionId: string): void { for (const [connectionId, values] of this.subscriptions) { for (const [id, subscription] of values) if (subscription.address.browserSessionId === sessionId) values.delete(id); if (values.size === 0) this.subscriptions.delete(connectionId); } }
  private readonly onFrame = (frame: FrameEvent): void => { this.emit("frame", frame); };
}

function requestFingerprint(request: BrowserRequest): string { const { requestId: _requestId, deadline: _deadline, ...semantics } = request; return canonicalOperationFingerprint(semantics); }
function requireConnectionId(connectionId: string | undefined): string { if (connectionId === undefined) throw new BrowserProtocolError("AUTH_FAILED", "Frame operations require a bound connection."); return connectionId; }
function ensureRequestLive(request: BrowserRequest): void { if (Date.parse(request.deadline) <= Date.now()) throw new BrowserProtocolError("DEADLINE_EXCEEDED", "Request deadline has expired."); }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
