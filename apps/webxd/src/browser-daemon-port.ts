import type {
  BrowserAction,
  BrowserControlResult,
  BrowserObservation,
  BrowserOperationResult,
  BrowserPathCapability,
  BrowserPathId,
  BrowserSession,
  BrowserSessionRequest,
  BrowserVisualFrame,
  VisualGuard,
} from "../../../packages/sdk/src/index.js";
import { BrowserPortError, type AuthorityActor, type BrowserDaemonPort } from "./ports.js";

export interface BrowserRpcConnection {
  call(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
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

  constructor(private readonly connect: BrowserRpcConnectionFactory) {}

  async capabilities(signal?: AbortSignal): Promise<readonly BrowserPathCapability[]> {
    const anonymous: AuthorityActor = { principalId: "webxd-system", agentId: "webxd-system", scopes: new Set() };
    const raw = record(await (await this.connection(anonymous)).call("system.capabilities", {}, signal));
    const paths = array(raw.paths).map(pathCapability);
    if (paths.length !== 2 || paths[0]?.pathId !== "agent-browser/chrome" || paths[1]?.pathId !== "pinchtab/chrome") {
      throw new BrowserPortError("unsupported", "browser daemon did not report exactly the two supported paths", 503, true);
    }
    return paths;
  }

  async createSession(actor: AuthorityActor, request: BrowserSessionRequest, _operationId: string, signal?: AbortSignal): Promise<BrowserSession> {
    const connection = await this.connection(actor);
    const raw = record(await connection.call("session.create", {
      pathId: request.pathId,
      ...(request.url === undefined ? {} : { url: request.url }),
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
    const binding = this.owned(actor, sessionId);
    if (binding.session.pathId !== "agent-browser/chrome") throw new BrowserPortError("unsupported", `visual frames are not supported by ${binding.session.pathId}`, 400);
    const workspace = await this.openWorkspace(actor, binding, signal);
    try {
      const frame = workspaceFrame(await workspace.connection.call("workspace.getFrame", { scopeId: workspace.scopeId, leaseId: workspace.leaseId }, signal));
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
    } finally {
      await this.releaseWorkspace(workspace, signal);
    }
  }

  async act(actor: AuthorityActor, sessionId: string, action: BrowserAction, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const binding = this.owned(actor, sessionId);
    assertCapability(binding.session.capabilities, action.kind);
    if (isWorkspaceCuaAction(action)) return this.workspaceAct(actor, binding, action, operationId, signal);
    const raw = record(await (await this.connection(actor)).call("browser.act", {
      browserSessionId: sessionId,
      tabId: binding.session.tabId,
      action: legacyAction(action),
      operationId,
    }, signal));
    if (raw.ok !== true) throw new BrowserPortError("backend-failure", "browser action did not succeed", 502, true);
    return { operationId: text(raw.operationId, "operationId"), state: "succeeded" };
  }

  async setControl(actor: AuthorityActor, sessionId: string, controller: "human" | "agent", _operationId: string, signal?: AbortSignal): Promise<BrowserControlResult> {
    const binding = this.owned(actor, sessionId);
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
      await this.releaseWorkspace(workspace, signal);
    }
  }

  async cancel(actor: AuthorityActor, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const raw = record(await (await this.connection(actor)).call("operation.cancel", { operationId }, signal));
    const state = raw.state;
    if (state !== "queued" && state !== "running" && state !== "cancelling" && state !== "succeeded" && state !== "failed" && state !== "cancelled") throw new TypeError("invalid operation state");
    return { operationId, state };
  }

  async close(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<void> {
    const binding = this.owned(actor, sessionId);
    await (await this.connection(actor)).call("session.close", { browserSessionId: sessionId }, signal);
    this.#sessions.set(sessionId, { ...binding, session: { ...binding.session, state: "closed" } });
  }

  private async workspaceAct(actor: AuthorityActor, binding: SessionBinding, action: BrowserAction, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    if (binding.session.pathId !== "agent-browser/chrome") throw new BrowserPortError("unsupported", `visual input is not supported by ${binding.session.pathId}`, 400);
    const workspace = await this.openWorkspace(actor, binding, signal);
    try {
      if (workspace.controlState === "human") throw new BrowserPortError("control-conflict", "human takeover is active", 409);
      const frame = workspaceFrame(await workspace.connection.call("workspace.getFrame", { scopeId: workspace.scopeId, leaseId: workspace.leaseId }, signal));
      const guard = visualGuard(action);
      if (guard !== undefined) assertFrameGuard(guard, frame);
      const controlled = record(await workspace.connection.call("workspace.compareSetControl", {
        scopeId: workspace.scopeId,
        leaseId: workspace.leaseId,
        viewportId: workspace.viewportId,
        viewportGeneration: workspace.viewportGeneration,
        control: "human",
        expectedControlEpoch: frame.controlEpoch,
      }, signal));
      const humanEpoch = positive(controlled.controlEpoch, "controlEpoch");
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
        }, signal));
        if (result.accepted !== true) throw new BrowserPortError("backend-failure", "workspace input was not accepted", 502, true);
        return { operationId, state: "succeeded" };
      } finally {
        const returned = record(await workspace.connection.call("workspace.compareSetControl", {
          scopeId: workspace.scopeId,
          leaseId: workspace.leaseId,
          viewportId: workspace.viewportId,
          viewportGeneration: workspace.viewportGeneration,
          control: "agent",
          expectedControlEpoch: humanEpoch,
        }, signal));
        const agentEpoch = positive(returned.controlEpoch, "controlEpoch");
        this.#sessions.set(binding.session.sessionId, { ...binding, controlEpoch: agentEpoch });
      }
    } finally {
      await this.releaseWorkspace(workspace, signal);
    }
  }

  private async openWorkspace(actor: AuthorityActor, binding: SessionBinding, signal?: AbortSignal): Promise<WorkspaceContext> {
    const connection = await this.connection(actor);
    await connection.call("workspace.focusTab", { browserSessionId: binding.session.sessionId, tabId: binding.session.tabId }, signal);
    const opened = record(await connection.call("workspace.openScoped", {}, signal));
    const scopeId = text(opened.scopeId, "scopeId");
    const selected = record(await connection.call("workspace.selectOwnedTab", { scopeId, tabId: binding.session.tabId }, signal));
    const lease = record(await connection.call("workspace.acquireViewportLease", { scopeId, tabId: binding.session.tabId }, signal));
    const identity = record(lease.identity);
    if (browserPath(identity.pathId) !== binding.session.pathId) throw new BrowserPortError("wrong-path", "workspace changed the selected path", 502);
    if (text(identity.browserSessionId, "identity.browserSessionId") !== binding.session.sessionId || text(identity.tabId, "identity.tabId") !== binding.session.tabId) {
      throw new BrowserPortError("wrong-owner", "workspace selected different browser state", 403);
    }
    return {
      connection,
      scopeId,
      leaseId: text(lease.leaseId, "leaseId"),
      viewportId: text(identity.viewportId, "identity.viewportId"),
      viewportGeneration: positive(identity.viewportGeneration, "identity.viewportGeneration"),
      controlEpoch: positive(identity.controlEpoch, "identity.controlEpoch"),
      controlState: text(selected.controlState, "controlState"),
    };
  }

  private async releaseWorkspace(workspace: WorkspaceContext, signal?: AbortSignal): Promise<void> {
    await workspace.connection.call("workspace.releaseViewportLease", { scopeId: workspace.scopeId, leaseId: workspace.leaseId }, signal);
  }

  private connection(actor: AuthorityActor): Promise<BrowserRpcConnection> {
    const key = `${actor.principalId}\0${actor.agentId}`;
    let connection = this.#connections.get(key);
    if (connection === undefined) { connection = this.connect(actor); this.#connections.set(key, connection); }
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
  if (action.kind === "fill") return action;
  if (action.kind === "select") return { ...action, values: [...action.values] };
  if (action.kind === "download") return action;
  if (action.kind === "back" || action.kind === "forward" || action.kind === "reload") return action;
  if (action.kind === "wait") return { kind: "wait", milliseconds: action.milliseconds };
  if (action.kind === "upload") throw new BrowserPortError("unsupported", "typed upload handles require the browser transfer seam", 400);
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
function pathCapability(value: unknown): BrowserPathCapability { const item = record(value); return { pathId: browserPath(item.pathId), actions: stringArray(item.actions), observations: stringArray(item.observations), visual: boolean(item.visual, "visual"), touch: false, uploads: boolean(item.uploads, "uploads"), downloads: boolean(item.downloads, "downloads") }; }
function browserPath(value: unknown): BrowserPathId { if (value === "agent-browser/chrome" || value === "pinchtab/chrome") return value; throw new TypeError("unsupported browser path identity"); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("browser daemon returned a non-object"); return value as Record<string, unknown>; }
function optionalRecord(value: unknown): Record<string, unknown> | undefined { return value === undefined ? undefined : record(value); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("browser daemon returned a non-array"); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string") throw new TypeError(`browser daemon returned invalid ${name}`); return value; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new TypeError(`browser daemon returned invalid ${name}`); return value; }
function positive(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`browser daemon returned invalid ${name}`); return value as number; }
function sha256(value: unknown, name: string): string { const result = text(value, name); if (!/^[a-f0-9]{64}$/u.test(result)) throw new TypeError(`browser daemon returned invalid ${name}`); return result; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("browser daemon returned invalid string list"); return value as string[]; }
