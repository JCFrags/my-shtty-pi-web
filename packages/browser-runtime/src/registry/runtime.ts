import { EventEmitter } from "node:events";
import type { ActorIdentity, BrowserRequest, FrameEvent, OperationStatus, SessionDescriptor } from "@webx/browser-protocol";
import { actorKey, DenyNavigationAuthorization, type NavigationAuthorization } from "../actor/identity.js";
import { BrowserArtifactStore } from "../artifacts/store.js";
import type { ChromeHostOptions } from "../chrome/host.js";
import type { CoordinateAction } from "../motor/session-motor.js";
import { OperationRegistry, type OperationContext } from "../operations/registry.js";
import { BrowserSession, type DomFallbackAction } from "./session.js";

export interface BrowserRuntimeOptions {
  navigationAuthorization?: NavigationAuthorization;
  chrome?: Omit<ChromeHostOptions, "hostId">;
  maxSessionsPerActor?: number;
  personaSeedForTest?: number;
  motorMinimumPathMsForTest?: number;
  observationFreshnessMsForTest?: number;
}

export class BrowserRuntime extends EventEmitter {
  readonly artifacts = new BrowserArtifactStore();
  readonly operations = new OperationRegistry();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly navigationAuthorization: NavigationAuthorization;
  private readonly chrome: Omit<ChromeHostOptions, "hostId">;
  private readonly maxSessionsPerActor: number;
  private readonly personaSeedForTest: number | undefined;
  private readonly motorMinimumPathMsForTest: number;
  private readonly observationFreshnessMsForTest: number | undefined;

  constructor(options: BrowserRuntimeOptions = {}) {
    super();
    this.navigationAuthorization = options.navigationAuthorization ?? new DenyNavigationAuthorization();
    this.chrome = options.chrome ?? {};
    this.maxSessionsPerActor = options.maxSessionsPerActor ?? 4;
    this.personaSeedForTest = options.personaSeedForTest;
    this.motorMinimumPathMsForTest = options.motorMinimumPathMsForTest ?? 0;
    this.observationFreshnessMsForTest = options.observationFreshnessMsForTest;
  }

  listSessions(actor: ActorIdentity): SessionDescriptor[] {
    const owner = actorKey(actor);
    return [...this.sessions.values()].filter((session) => actorKey(session.actor) === owner).map((session) => session.descriptor());
  }

  ownsSession(actor: ActorIdentity, browserSessionId: string): boolean {
    const session = this.sessions.get(browserSessionId);
    return session !== undefined && actorKey(session.actor) === actorKey(actor);
  }

  private getSession(actor: ActorIdentity, browserSessionId: string): BrowserSession {
    const session = this.sessions.get(browserSessionId);
    if (session === undefined || actorKey(session.actor) !== actorKey(actor)) throw new Error("Browser session not found.");
    return session;
  }

  async dispatch(actor: ActorIdentity, request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
    if (request.kind === "capabilities.get") return { kind: "capabilities", headed: true, screenshotFirst: true, domFallback: true, virtualMouse: true, osMouse: false };
    if (request.kind === "session.list") return { kind: "sessions", sessions: this.listSessions(actor) };
    if (request.kind === "operation.status") return this.operations.status(actor, request.targetOperationId);
    if (request.kind === "operation.cancel") return this.operations.cancel(actor, request.targetOperationId);
    if (request.kind === "artifact.read") {
      const bytes = await this.artifacts.read(actor, request.artifactId);
      const offset = request.offset ?? 0;
      const maxBytes = request.maxBytes ?? 1024 * 1024;
      if (offset > bytes.byteLength) throw new Error("Artifact offset is outside the artifact.");
      const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes));
      return { kind: "artifact", artifactId: request.artifactId, mediaType: "image/png", byteLength: chunk.byteLength, sha256: await import("@webx/artifacts").then(({ sha256Hex }) => sha256Hex(bytes)), offset, totalBytes: bytes.byteLength, eof: offset + chunk.byteLength >= bytes.byteLength, base64: Buffer.from(chunk).toString("base64") };
    }

    if (request.kind === "session.create") {
      return await this.execute(actor, request, `actor:${actorKey(actor)}:sessions`, undefined, undefined, async (context) => {
        context.checkpoint();
        if (this.listSessions(actor).length >= this.maxSessionsPerActor) throw new Error("Browser session limit reached.");
        const session = await BrowserSession.create(actor, this.operations, this.artifacts, this.navigationAuthorization, { ...this.chrome, ...(request.initialUrl !== undefined ? { initialUrl: request.initialUrl } : {}), ...(this.personaSeedForTest !== undefined ? { personaSeed: this.personaSeedForTest } : {}), motorMinimumPathMs: this.motorMinimumPathMsForTest, ...(this.observationFreshnessMsForTest !== undefined ? { observationFreshnessMs: this.observationFreshnessMsForTest } : {}) });
        this.sessions.set(session.browserSessionId, session);
        session.onFrame(this.onFrame);
        context.markDispatched();
        return session.descriptor();
      }, signal);
    }

    const browserSessionId = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.browserSessionId : request.address.browserSessionId;
    const session = this.getSession(actor, browserSessionId);
    const controlEpoch = request.kind === "session.close" || request.kind === "tab.create" || request.kind === "tab.list" ? request.controlEpoch : request.address.controlEpoch;
    const motorLane = `motor:${actorKey(actor)}:${browserSessionId}`;

    if (request.kind === "session.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.close(); this.sessions.delete(browserSessionId); context.markDispatched(); return session.descriptor(); }, signal);
    if (request.kind === "tab.list") return { kind: "tabs", tabs: session.listTabs() };
    if (request.kind === "tab.create") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); const tab = await session.createTab(request.url, context.signal); context.markDispatched(); return session.listTabs().find((item) => item.address.tabId === tab.tabId); }, signal);
    if (request.kind === "tab.focus") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.targets.focus(request.address); context.markDispatched(); return session.listTabs().find((item) => item.address.tabId === request.address.tabId); }, signal);
    if (request.kind === "tab.close") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.targets.closeTab(request.address); context.markDispatched(); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "observe.screenshot") return await this.execute(actor, request, `capture:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async () => await session.observe(request.address, request.delivery), signal);
    if (request.kind === "observe.domFallback") return await this.execute(actor, request, `dom:${browserSessionId}:${request.address.tabId}`, browserSessionId, controlEpoch, async () => await session.observeDom(request.address, request.maxNodes), signal);
    if (request.kind === "action.coordinate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.coordinate(request.address, request.observationId, request.action as CoordinateAction, context, request.riskPolicy); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "action.domFallback") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.domAction(request.address, request.domObservationId, request.handle, request.action as DomFallbackAction, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "navigate") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { context.checkpoint(); await session.navigate(request.address, request.url, context.signal, () => context.markDispatched()); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.text") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.typeText(request.address, request.text, request.replace ?? false, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "input.key") return await this.execute(actor, request, motorLane, browserSessionId, controlEpoch, async (context) => { await session.pressKey(request.address, request.key, context); return { kind: "ack", operationId: request.operationId }; }, signal);
    if (request.kind === "frames.subscribe") { session.subscribeFrames(request.address, request.interest); return { kind: "ack", operationId: request.operationId }; }
    if (request.kind === "frames.unsubscribe") { session.unsubscribeFrames(request.address); return { kind: "ack", operationId: request.operationId }; }
    throw new Error("Unsupported browser request.");
  }

  incrementControlEpochForTest(actor: ActorIdentity, browserSessionId: string): number { return this.getSession(actor, browserSessionId).incrementControlEpoch(); }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => { session.offFrame(this.onFrame); await session.close(); }));
  }

  private async execute<T>(actor: ActorIdentity, request: BrowserRequest, laneKey: string, browserSessionId: string | undefined, controlEpoch: number | undefined, task: (context: OperationContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.operations.submit(actor, {
      operationId: request.operationId, laneKey, deadline: request.deadline,
      ...(browserSessionId !== undefined ? { browserSessionId } : {}),
      ...("address" in request ? { tabId: request.address.tabId } : {}),
      ...(controlEpoch !== undefined ? { controlEpoch } : {}),
    }, task);
    const abort = (): void => { try { this.operations.cancel(actor, request.operationId); } catch { /* Already pruned. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const status: OperationStatus = await this.operations.wait(actor, request.operationId, signal);
      if (status.state !== "committed") throw new Error(status.error?.message ?? `Operation ${status.state}.`);
      return this.operations.result(actor, request.operationId) as T;
    } finally { signal?.removeEventListener("abort", abort); }
  }

  private readonly onFrame = (frame: FrameEvent): void => { this.emit("frame", frame); };
}
