import { pid } from "node:process";
import type {
  BrowserAction,
  BrowserControlResult,
  BrowserDebugRequest,
  BrowserDebugResult,
  BrowserObservation,
  BrowserOperationResult,
  BrowserPathCapability,
  BrowserPathId,
  BrowserSession,
  BrowserSessionRequest,
  BrowserVisualFrame,
  BrowserWorkspaceRequest,
  BrowserWorkspaceResult,
  VisualGuard,
} from "../../../packages/sdk/src/index.js";
import {
  FailClosedBrowserDestinationAuthority,
  actionDestination,
  type BrowserDestinationAuthority,
} from "./destination-authority.js";
import { BrowserPortError, type AuthorityActor, type BrowserDaemonPort } from "./ports.js";

export interface BrowserRpcConnection {
  call(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** The factory must authenticate and register the actor on one persistent Unix NDJSON connection. */
export type BrowserRpcConnectionFactory = (actor: AuthorityActor) => Promise<BrowserRpcConnection>;

interface SessionBinding {
  readonly session: BrowserSession;
  readonly hostGeneration: number;
  readonly engineGeneration: number;
  readonly controlEpoch: number;
}

interface WorkspaceContext {
  readonly connection: BrowserRpcConnection;
  readonly scopeId: string;
  readonly leaseId: string;
  readonly viewportId: string;
  readonly viewportGeneration: number;
  readonly controlEpoch: number;
  readonly controlState: string;
  readonly expiresAtMs: number;
}

interface PendingVisualFrame {
  readonly workspace: WorkspaceContext;
  readonly frame: WorkspaceFrameShape;
  readonly principalId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly pathId: BrowserPathId;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PreparedWorkspaceInput {
  readonly binding: SessionBinding;
  readonly action: BrowserAction;
  readonly operationId: string;
  readonly workspace: WorkspaceContext;
  readonly frame: WorkspaceFrameShape;
  readonly humanEpoch: number;
}

interface WorkspaceFrameShape {
  readonly viewportId: string;
  readonly viewportGeneration: number;
  readonly sequence: number;
  readonly screenshotSha256: string;
  readonly controlEpoch: number;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly payload: string;
}

export class BrowserDaemonRpcPort implements BrowserDaemonPort {
  readonly #connections = new Map<string, Promise<BrowserRpcConnection>>();
  readonly #sessions = new Map<string, SessionBinding>();
  readonly #pendingFrames = new Map<string, PendingVisualFrame>();
  readonly #sessionLanes = new Map<string, Promise<void>>();
  #shuttingDown = false;

  constructor(
    private readonly connect: BrowserRpcConnectionFactory,
    private readonly destinationAuthority: BrowserDestinationAuthority = new FailClosedBrowserDestinationAuthority(),
  ) {}

  async capabilities(signal?: AbortSignal): Promise<readonly BrowserPathCapability[]> {
    const systemIdentity = `webxd-system-${pid}`;
    const anonymous: AuthorityActor = { principalId: systemIdentity, agentId: systemIdentity, scopes: new Set() };
    const raw = record(await (await this.connection(anonymous)).call("system.capabilities", {}, signal));
    const paths = array(raw.paths).map(pathCapability);
    if (paths[0]?.pathId !== "agent-browser/chrome" || paths.some((path) => path.pathId !== "agent-browser/chrome" && path.pathId !== "pinchtab/chrome")) {
      throw new BrowserPortError("unsupported", "browser daemon did not report the required visual path", 503, true);
    }
    return paths;
  }

  async createSession(actor: AuthorityActor, request: BrowserSessionRequest, operationId: string, signal?: AbortSignal): Promise<BrowserSession> {
    const authorizedUrl = request.url === undefined
      ? undefined
      : (await this.destinationAuthority.authorize({ actor, operationId, operation: "initial", url: request.url }, signal)).normalizedUrl;
    const connection = await this.connection(actor);
    const raw = record(await connection.call("session.create", {
      pathId: request.pathId,
      ...(authorizedUrl === undefined ? {} : { url: authorizedUrl }),
      ...(request.visible === undefined ? {} : { visible: request.visible }),
      ...(request.label === undefined ? {} : { label: request.label }),
    }, signal));
    const daemonSession = record(raw.browserSession);
    const tab = record(raw.tab);
    const pathId = browserPath(raw.pathId);
    if (pathId !== request.pathId) throw new BrowserPortError("wrong-path", "browser daemon changed path identity", 502);
    const capability = (await this.capabilities(signal)).find((item) => item.pathId === pathId);
    if (capability === undefined) throw new BrowserPortError("unsupported", "browser path has no capability record", 400);
    const session: BrowserSession = {
      sessionId: text(daemonSession.browserSessionId, "browserSession.browserSessionId"),
      tabId: text(tab.tabId, "tab.tabId"),
      pathId,
      ownerPrincipalId: actor.principalId,
      ownerAgentId: actor.agentId,
      state: "ready",
      capabilities: capability,
    };
    this.#sessions.set(session.sessionId, { session, hostGeneration: 1, engineGeneration: 1, controlEpoch: positive(raw.controlEpoch, "controlEpoch") });
    return session;
  }

  async listSessions(actor: AuthorityActor, signal?: AbortSignal): Promise<readonly BrowserSession[]> {
    const connection = await this.connection(actor);
    const raw = record(await connection.call("session.list", {}, signal));
    const capabilities = await this.capabilities(signal);
    const tabs = array(raw.tabs).map(record);
    const sessions = array(raw.sessions).map((value) => {
      const daemonSession = record(value);
      const sessionId = text(daemonSession.browserSessionId, "browserSessionId");
      const pathId = browserPath(daemonSession.pathId);
      const tab = tabs.find((item) => item.browserSessionId === sessionId);
      if (tab === undefined) throw new TypeError("browser daemon session has no tab");
      const capability = capabilities.find((item) => item.pathId === pathId);
      if (capability === undefined) throw new TypeError("browser daemon session has an unsupported path");
      const session: BrowserSession = {
        sessionId,
        tabId: text(tab.tabId, "tabId"),
        pathId,
        ownerPrincipalId: actor.principalId,
        ownerAgentId: actor.agentId,
        state: "ready",
        capabilities: capability,
      };
      this.#sessions.set(sessionId, { session, hostGeneration: 1, engineGeneration: 1, controlEpoch: positive(tab.controlEpoch, "controlEpoch") });
      return session;
    });
    return sessions;
  }

  async getSession(actor: AuthorityActor, sessionId: string): Promise<BrowserSession> {
    return this.owned(actor, sessionId).session;
  }

  async observe(actor: AuthorityActor, sessionId: string, view: string, maxChars: number, operationId: string, signal?: AbortSignal): Promise<BrowserObservation> {
    const binding = this.owned(actor, sessionId);
    const raw = record(await (await this.connection(actor)).call("browser.observe", {
      browserSessionId: sessionId, tabId: binding.session.tabId, view, maxChars, operationId,
    }, signal));
    const metadata = optionalRecord(raw.metadata);
    const contentArtifactId = metadata === undefined ? undefined : optionalText(metadata.contentArtifactId);
    const artifactId = contentArtifactId ?? optionalText(raw.artifactId);
    return {
      operationId: text(raw.operationId, "operationId"),
      address: this.address(binding),
      title: text(raw.title, "title"),
      url: text(raw.url, "url"),
      content: text(raw.content, "content"),
      truncated: boolean(raw.truncated, "truncated"),
      ...(artifactId === undefined ? {} : { artifactId }),
    };
  }

  async captureFrame(actor: AuthorityActor, sessionId: string, _operationId: string, signal?: AbortSignal): Promise<BrowserVisualFrame> {
    return this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      if (binding.session.pathId !== "agent-browser/chrome") throw new BrowserPortError("unsupported", `visual frames are not supported by ${binding.session.pathId}`, 400);
      await this.invalidatePendingFrame(sessionId);
      const workspace = await this.openWorkspace(actor, binding, signal);
      try {
        const frame = workspaceFrame(await workspace.connection.call("workspace.getFrame", { scopeId: workspace.scopeId, leaseId: workspace.leaseId }, signal));
        this.retainFrame(actor, binding, workspace, frame);
        return {
          address: this.address(binding),
          mediaType: frame.mediaType,
          width: frame.width,
          height: frame.height,
          payloadBase64: frame.payload,
          screenshotSha256: frame.screenshotSha256,
          screenshotSequence: frame.sequence,
          viewportId: frame.viewportId,
          viewportGeneration: frame.viewportGeneration,
        };
      } catch (error) {
        await this.releaseWorkspace(workspace);
        throw error;
      }
    });
  }

  async act(actor: AuthorityActor, sessionId: string, action: BrowserAction, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    if (isWorkspaceCuaAction(action)) {
      const prepared = await this.withSessionLane(sessionId, async () => {
        const binding = this.owned(actor, sessionId);
        assertCapability(binding.session.capabilities, action.kind);
        return this.prepareWorkspaceAct(actor, binding, action, operationId, signal);
      });
      return this.dispatchWorkspaceAct(prepared, signal);
    }
    const prepared = await this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      assertCapability(binding.session.capabilities, action.kind);
      const candidate = actionDestination(action);
      const dispatchedAction = candidate === undefined
        ? action
        : { ...action, url: (await this.destinationAuthority.authorize({ actor, operationId, ...candidate }, signal)).normalizedUrl };
      // A pure wait does not dispatch input or navigation. Browserd still recaptures
      // and compares the exact frame before any later screenshot-bound input.
      if (action.kind !== "wait") await this.invalidatePendingFrame(sessionId);
      return { binding, dispatchedAction, connection: await this.connection(actor) };
    });
    const raw = record(await prepared.connection.call("browser.act", {
      browserSessionId: sessionId,
      tabId: prepared.binding.session.tabId,
      action: legacyAction(prepared.dispatchedAction),
      operationId,
    }, signal));
    if (raw.ok !== true) throw new BrowserPortError("backend-failure", "browser action did not succeed", 502, true);
    return { operationId: text(raw.operationId, "operationId"), state: "succeeded" };
  }

  async debug(actor: AuthorityActor, sessionId: string, request: BrowserDebugRequest, operationId: string, signal?: AbortSignal): Promise<BrowserDebugResult> {
    return this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      await this.invalidatePendingFrame(sessionId);
      const raw = record(await (await this.connection(actor)).call("browser.debug", {
        browserSessionId: sessionId,
        tabId: binding.session.tabId,
        operation: request.operation,
        args: request.args ?? {},
        ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
        operationId,
      }, signal));
      const artifactId = optionalText(raw.artifactId);
      return {
        operationId: text(raw.operationId, "operationId"),
        operation: request.operation,
        ok: boolean(raw.ok, "ok"),
        data: raw.data,
        ...(artifactId === undefined ? {} : { artifactId }),
      };
    });
  }

  async workspace(actor: AuthorityActor, request: BrowserWorkspaceRequest, _operationId: string, signal?: AbortSignal): Promise<BrowserWorkspaceResult> {
    const connection = await this.connection(actor);
    if (request.action === "list") return { action: request.action, data: await connection.call("workspace.openScoped", {}, signal) };
    if (request.action === "hide") return { action: request.action, data: await connection.call("workspace.hide", {}, signal) };
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
      if (request.action === "show") return { action: request.action, data: await connection.call("workspace.show", {}, signal) };
      throw new BrowserPortError("invalid-request", `${request.action} requires a sessionId`, 400);
    }
    const binding = this.owned(actor, sessionId);
    if (request.tabId !== undefined && request.tabId !== binding.session.tabId) throw new BrowserPortError("wrong-owner", "tab does not belong to the owned session", 403);
    if (request.action === "show" || request.action === "attach") {
      return { action: request.action, data: await connection.call("workspace.focusTab", { browserSessionId: sessionId, tabId: binding.session.tabId }, signal) };
    }
    const controller = request.action === "takeover" ? "human" : "agent";
    if (request.action === "takeover" || request.action === "return") return { action: request.action, data: await this.setControl(actor, sessionId, controller, _operationId, signal) };
    throw new BrowserPortError("unsupported", `workspace action ${request.action} is unsupported`, 400);
  }

  async setControl(actor: AuthorityActor, sessionId: string, controller: "human" | "agent", _operationId: string, signal?: AbortSignal): Promise<BrowserControlResult> {
    return this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      await this.invalidatePendingFrame(sessionId);
      const workspace = await this.openWorkspace(actor, binding, signal);
      try {
        const raw = record(await workspace.connection.call("workspace.compareSetControl", {
          scopeId: workspace.scopeId,
          leaseId: workspace.leaseId,
          viewportId: workspace.viewportId,
          viewportGeneration: workspace.viewportGeneration,
          control: controller,
          expectedControlEpoch: workspace.controlEpoch,
        }, signal));
        const next = positive(raw.controlEpoch, "controlEpoch");
        this.#sessions.set(sessionId, { ...binding, controlEpoch: next });
        return { sessionId, tabId: binding.session.tabId, controller, controlEpoch: next };
      } finally {
        await this.releaseWorkspace(workspace);
      }
    });
  }

  async cancel(actor: AuthorityActor, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const raw = record(await (await this.connection(actor)).call("operation.cancel", { operationId }, signal));
    const state = raw.state;
    if (state !== "queued" && state !== "running" && state !== "cancelling" && state !== "succeeded" && state !== "failed" && state !== "cancelled") throw new TypeError("invalid operation state");
    return { operationId, state };
  }

  async closeTab(actor: AuthorityActor, sessionId: string, tabId: string, signal?: AbortSignal): Promise<void> {
    await this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      if (binding.session.tabId !== tabId) throw new BrowserPortError("wrong-owner", "tab does not belong to the owned session", 403);
      await this.invalidatePendingFrame(sessionId);
      const connection = await this.connection(actor);
      await connection.call("workspace.hide", {}, signal);
      await connection.call("tab.close", { browserSessionId: sessionId, tabId }, signal);
    });
  }

  async close(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.withSessionLane(sessionId, async () => {
      const binding = this.owned(actor, sessionId);
      await this.invalidatePendingFrame(sessionId);
      const connection = await this.connection(actor);
      await connection.call("workspace.hide", {}, signal);
      await connection.call("session.close", { browserSessionId: sessionId }, signal);
      this.#sessions.set(sessionId, { ...binding, session: { ...binding.session, state: "closed" } });
    });
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    const lanes = [...this.#sessionLanes.values()];
    await Promise.allSettled(lanes);
    const pending = [...this.#pendingFrames.values()];
    this.#pendingFrames.clear();
    for (const item of pending) clearTimeout(item.timer);
    await Promise.allSettled(pending.map(async (item) => this.releaseWorkspace(item.workspace)));
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#sessions.clear();
    this.#sessionLanes.clear();
    await Promise.allSettled(connections.map(async (connection) => (await connection).close()));
  }

  private async prepareWorkspaceAct(actor: AuthorityActor, binding: SessionBinding, action: BrowserAction, operationId: string, signal?: AbortSignal): Promise<PreparedWorkspaceInput> {
    if (binding.session.pathId !== "agent-browser/chrome") throw new BrowserPortError("unsupported", `visual input is not supported by ${binding.session.pathId}`, 400);
    const guard = visualGuard(action);
    if (guard === undefined) throw new BrowserPortError("stale-visual", "visual input requires an exact captured frame guard", 409);
    const pending = await this.takePendingFrame(actor, binding, guard);
    const { workspace, frame } = pending;
    try {
      if (workspace.controlState === "human") throw new BrowserPortError("control-conflict", "human takeover is active", 409);
      const controlled = record(await workspace.connection.call("workspace.compareSetControl", {
        scopeId: workspace.scopeId,
        leaseId: workspace.leaseId,
        viewportId: workspace.viewportId,
        viewportGeneration: workspace.viewportGeneration,
        control: "human",
        expectedControlEpoch: frame.controlEpoch,
      }, signal));
      return { binding, action, operationId, workspace, frame, humanEpoch: positive(controlled.controlEpoch, "controlEpoch") };
    } catch (error) {
      await this.releaseWorkspace(workspace);
      throw error;
    }
  }

  private async dispatchWorkspaceAct(prepared: PreparedWorkspaceInput, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const { binding, action, operationId, workspace, frame, humanEpoch } = prepared;
    try {
      const result = record(await workspace.connection.call("workspace.input", {
        scopeId: workspace.scopeId,
        leaseId: workspace.leaseId,
        viewportId: frame.viewportId,
        viewportGeneration: frame.viewportGeneration,
        controlEpoch: humanEpoch,
        screenshotSha256: frame.screenshotSha256,
        screenshotSequence: frame.sequence,
        inputSequence: 1,
        action: cuaAction(action),
        operationId,
      }, signal));
      if (result.accepted !== true) throw new BrowserPortError("backend-failure", "workspace input was not accepted", 502, true);
      if (text(result.operationId, "operationId") !== operationId) throw new BrowserPortError("backend-failure", "workspace input operation identity changed", 502, true);
      return { operationId, state: "succeeded" };
    } finally {
      try {
        const returned = record(await workspace.connection.call("workspace.compareSetControl", {
          scopeId: workspace.scopeId,
          leaseId: workspace.leaseId,
          viewportId: workspace.viewportId,
          viewportGeneration: workspace.viewportGeneration,
          control: "agent",
          expectedControlEpoch: humanEpoch,
        }));
        const agentEpoch = positive(returned.controlEpoch, "controlEpoch");
        this.#sessions.set(binding.session.sessionId, { ...binding, controlEpoch: agentEpoch });
      } finally {
        await this.releaseWorkspace(workspace);
      }
    }
  }

  private async openWorkspace(actor: AuthorityActor, binding: SessionBinding, signal?: AbortSignal): Promise<WorkspaceContext> {
    const connection = await this.connection(actor);
    await connection.call("workspace.focusTab", { browserSessionId: binding.session.sessionId, tabId: binding.session.tabId }, signal);
    const opened = record(await connection.call("workspace.openScoped", {}, signal));
    const scopeId = text(opened.scopeId, "scopeId");
    const selected = record(await connection.call("workspace.selectOwnedTab", { scopeId, tabId: binding.session.tabId }, signal));
    const lease = record(await connection.call("workspace.acquireViewportLease", { scopeId, tabId: binding.session.tabId }, signal));
    const leaseId = text(lease.leaseId, "leaseId");
    try {
      const identity = record(lease.identity);
      if (browserPath(identity.pathId) !== binding.session.pathId) throw new BrowserPortError("wrong-path", "workspace changed the selected path", 502);
      if (text(identity.browserSessionId, "identity.browserSessionId") !== binding.session.sessionId || text(identity.tabId, "identity.tabId") !== binding.session.tabId) {
        throw new BrowserPortError("wrong-owner", "workspace selected different browser state", 403);
      }
      const localLeaseLimit = Date.now() + 30_000;
      const leaseExpiry = lease.expiresAt === undefined ? localLeaseLimit : timestamp(lease.expiresAt, "expiresAt");
      const expiresAtMs = Math.min(leaseExpiry, localLeaseLimit);
      if (expiresAtMs <= Date.now()) throw new BrowserPortError("stale-visual", "workspace lease expired before use", 409);
      return {
        connection,
        scopeId,
        leaseId,
        viewportId: text(identity.viewportId, "identity.viewportId"),
        viewportGeneration: positive(identity.viewportGeneration, "identity.viewportGeneration"),
        controlEpoch: positive(identity.controlEpoch, "identity.controlEpoch"),
        controlState: text(selected.controlState, "controlState"),
        expiresAtMs,
      };
    } catch (error) {
      await connection.call("workspace.releaseViewportLease", { scopeId, leaseId }).catch(() => undefined);
      throw error;
    }
  }

  private retainFrame(actor: AuthorityActor, binding: SessionBinding, workspace: WorkspaceContext, frame: WorkspaceFrameShape): void {
    const delay = Math.max(0, workspace.expiresAtMs - Date.now());
    let pending!: PendingVisualFrame;
    const timer = setTimeout(() => {
      void this.withSessionLane(binding.session.sessionId, async () => {
        if (this.#pendingFrames.get(binding.session.sessionId) !== pending) return;
        this.#pendingFrames.delete(binding.session.sessionId);
        await this.releaseWorkspace(workspace);
      }).catch(() => undefined);
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    pending = {
      workspace,
      frame,
      principalId: actor.principalId,
      agentId: actor.agentId,
      sessionId: binding.session.sessionId,
      tabId: binding.session.tabId,
      pathId: binding.session.pathId,
      timer,
    };
    this.#pendingFrames.set(binding.session.sessionId, pending);
  }

  private async takePendingFrame(actor: AuthorityActor, binding: SessionBinding, guard: VisualGuard): Promise<PendingVisualFrame> {
    const pending = this.#pendingFrames.get(binding.session.sessionId);
    if (pending === undefined) throw new BrowserPortError("stale-visual", "captured visual frame is missing or already used", 409);
    this.#pendingFrames.delete(binding.session.sessionId);
    clearTimeout(pending.timer);
    if (pending.workspace.expiresAtMs <= Date.now()) {
      await this.releaseWorkspace(pending.workspace).catch(() => undefined);
      throw new BrowserPortError("stale-visual", "captured visual frame lease expired", 409);
    }
    if (pending.principalId !== actor.principalId || pending.agentId !== actor.agentId || pending.sessionId !== binding.session.sessionId || pending.tabId !== binding.session.tabId) {
      await this.releaseWorkspace(pending.workspace).catch(() => undefined);
      throw new BrowserPortError("wrong-owner", "captured visual frame belongs to a different actor or tab", 403);
    }
    if (pending.pathId !== binding.session.pathId) {
      await this.releaseWorkspace(pending.workspace).catch(() => undefined);
      throw new BrowserPortError("wrong-path", "captured visual frame belongs to a different browser path", 409);
    }
    try {
      assertFrameGuard(guard, pending.frame);
    } catch (error) {
      await this.releaseWorkspace(pending.workspace).catch(() => undefined);
      throw error;
    }
    return pending;
  }

  private async invalidatePendingFrame(sessionId: string): Promise<void> {
    const pending = this.#pendingFrames.get(sessionId);
    if (pending === undefined) return;
    this.#pendingFrames.delete(sessionId);
    clearTimeout(pending.timer);
    await this.releaseWorkspace(pending.workspace);
  }

  private async withSessionLane<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (this.#shuttingDown) throw new BrowserPortError("unavailable", "browser daemon port is shutting down", 503, true);
    const previous = this.#sessionLanes.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.#sessionLanes.set(sessionId, current);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.#sessionLanes.get(sessionId) === current) this.#sessionLanes.delete(sessionId);
    }
  }

  private async releaseWorkspace(workspace: WorkspaceContext, signal?: AbortSignal): Promise<void> {
    await workspace.connection.call("workspace.releaseViewportLease", { scopeId: workspace.scopeId, leaseId: workspace.leaseId }, signal);
  }

  private connection(actor: AuthorityActor): Promise<BrowserRpcConnection> {
    const key = `${actor.principalId}\0${actor.agentId}`;
    let connection = this.#connections.get(key);
    if (connection === undefined) {
      const created = this.connect(actor).catch((error: unknown) => {
        if (this.#connections.get(key) === created) this.#connections.delete(key);
        throw error;
      });
      connection = created;
      this.#connections.set(key, connection);
    }
    return connection;
  }

  private owned(actor: AuthorityActor, sessionId: string): SessionBinding {
    const binding = this.#sessions.get(sessionId);
    if (binding === undefined) throw new BrowserPortError("not-found", "browser session was not found", 404);
    if (binding.session.ownerPrincipalId !== actor.principalId || binding.session.ownerAgentId !== actor.agentId) throw new BrowserPortError("wrong-owner", "browser session has a different owner", 403);
    return binding;
  }

  private address(binding: SessionBinding): BrowserObservation["address"] {
    return { sessionId: binding.session.sessionId, tabId: binding.session.tabId, pathId: binding.session.pathId, hostGeneration: binding.hostGeneration, engineGeneration: binding.engineGeneration, controlEpoch: binding.controlEpoch };
  }
}

function isWorkspaceCuaAction(action: BrowserAction): boolean {
  if (action.kind === "click") return "x" in action;
  return action.kind === "mouse-move" || action.kind === "mouse-down" || action.kind === "mouse-up" || action.kind === "double-click" || action.kind === "wheel" || action.kind === "drag" || action.kind === "key-press" || action.kind === "key-down" || action.kind === "key-up" || action.kind === "text-input";
}

function visualGuard(action: BrowserAction): VisualGuard | undefined {
  return "visualGuard" in action ? action.visualGuard : undefined;
}

function assertFrameGuard(guard: VisualGuard, frame: WorkspaceFrameShape): void {
  if (guard.viewportId !== frame.viewportId || guard.viewportGeneration !== frame.viewportGeneration || guard.screenshotSha256 !== frame.screenshotSha256 || guard.screenshotSequence !== frame.sequence) {
    throw new BrowserPortError("stale-visual", "visual action is not bound to the current workspace frame", 409);
  }
}

function cuaAction(action: BrowserAction): Readonly<Record<string, unknown>> {
  if (action.kind === "mouse-move") return { type: "mouse_move", x: action.x, y: action.y };
  if ((action.kind === "mouse-down" || action.kind === "mouse-up" || action.kind === "click" || action.kind === "double-click") && "x" in action) return { type: action.kind.replaceAll("-", "_"), x: action.x, y: action.y, button: action.button };
  if (action.kind === "wheel") return { type: "wheel", delta_x: action.deltaX, delta_y: action.deltaY };
  if (action.kind === "drag") return { type: "drag", from_x: action.from.x, from_y: action.from.y, to_x: action.to.x, to_y: action.to.y, button: "left" };
  if (action.kind === "key-press") return { type: "key_press", key: action.key };
  if (action.kind === "key-down" || action.kind === "key-up") return { type: action.kind.replaceAll("-", "_"), key: action.key, code: action.code ?? action.key, modifiers: action.modifiers ?? 0 };
  if (action.kind === "text-input") return { type: "text", text: action.text };
  throw new BrowserPortError("unsupported", `${action.kind} is not a workspace CUA action`, 400);
}

function legacyAction(action: BrowserAction): Readonly<Record<string, unknown>> {
  if (action.kind === "navigate") return action;
  if (action.kind === "click" && !("x" in action)) return { kind: "click", ...(action.ref === undefined ? {} : { ref: action.ref }), ...(action.selector === undefined ? {} : { selector: action.selector }) };
  if (action.kind === "fill" || action.kind === "type") return action;
  if (action.kind === "press" || action.kind === "hover" || action.kind === "scroll") return action;
  if (action.kind === "semantic-drag") return { kind: "drag", ref: action.ref, targetRef: action.targetRef };
  if (action.kind === "select") return { ...action, values: [...action.values] };
  if (action.kind === "download") return action;
  if (action.kind === "back" || action.kind === "forward" || action.kind === "reload") return action;
  if (action.kind === "wait") return action;
  if (action.kind === "tab-new") return action;
  if (action.kind === "tab-close") return action;
  if (action.kind === "tab-focus") return action;
  throw new BrowserPortError("unsupported", `${action.kind} is not supported by the frozen browser.act shape`, 400);
}

function workspaceFrame(value: unknown): WorkspaceFrameShape {
  const item = record(value);
  if (text(item.coordinateSpace, "coordinateSpace") !== "css-viewport") throw new TypeError("browser daemon returned invalid coordinateSpace");
  const mediaType = item.mediaType;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg") throw new TypeError("browser daemon returned invalid mediaType");
  return {
    viewportId: text(item.viewportId, "viewportId"),
    viewportGeneration: positive(item.viewportGeneration, "viewportGeneration"),
    sequence: positive(item.sequence, "sequence"),
    screenshotSha256: sha256(item.screenshotSha256, "screenshotSha256"),
    controlEpoch: positive(item.controlEpoch, "controlEpoch"),
    mediaType,
    width: positive(item.width, "width"),
    height: positive(item.height, "height"),
    payload: text(item.payload, "payload"),
  };
}

function assertCapability(capability: BrowserPathCapability, action: string): void { if (!capability.actions.includes(action)) throw new BrowserPortError("unsupported", `${action} is not supported by ${capability.pathId}`, 400); }
function pathCapability(value: unknown): BrowserPathCapability { const item = record(value); return { pathId: browserPath(item.pathId), actions: stringArray(item.actions).filter((action) => action !== "upload"), observations: stringArray(item.observations), visual: boolean(item.visual, "visual"), touch: false, uploads: false, downloads: boolean(item.downloads, "downloads") }; }
function browserPath(value: unknown): BrowserPathId { if (value === "agent-browser/chrome" || value === "pinchtab/chrome") return value; throw new TypeError("unsupported browser path identity"); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("browser daemon returned a non-object"); return value as Record<string, unknown>; }
function optionalRecord(value: unknown): Record<string, unknown> | undefined { return value === undefined ? undefined : record(value); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("browser daemon returned a non-array"); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string") throw new TypeError(`browser daemon returned invalid ${name}`); return value; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new TypeError(`browser daemon returned invalid ${name}`); return value; }
function positive(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`browser daemon returned invalid ${name}`); return value as number; }
function timestamp(value: unknown, name: string): number { const parsed = Date.parse(text(value, name)); if (!Number.isFinite(parsed)) throw new TypeError(`browser daemon returned invalid ${name}`); return parsed; }
function sha256(value: unknown, name: string): string { const result = text(value, name); if (!/^[a-f0-9]{64}$/u.test(result)) throw new TypeError(`browser daemon returned invalid ${name}`); return result; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("browser daemon returned invalid string list"); return value as string[]; }
