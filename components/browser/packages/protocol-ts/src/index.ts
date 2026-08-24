export const PROTOCOL_VERSION = "2.0.0" as const;
export const PROTOCOL_MAJOR = 2 as const;
export const SUPPORTED_PATH_IDS = ["agent-browser/chrome", "pinchtab/chrome"] as const;

export type BrowserPathId = (typeof SUPPORTED_PATH_IDS)[number];
export type PrincipalId = string;
export type AgentId = string;
export type SessionId = string;
export type TabId = string;
export type OperationId = string;
export type ObservationId = string;
export type ArtifactId = string;
export type TransferId = string;

export interface AuthenticatedPrincipal {
  principalId: PrincipalId;
  authenticationId: string;
}

export interface OwnerIdentity {
  principalId: PrincipalId;
  agentId: AgentId;
}

export interface PathIdentity {
  pathId: BrowserPathId;
  backendVersion: string;
  provider: "chrome";
  hostId: string;
  hostGeneration: number;
  engineGeneration: number;
}

export interface ProtocolAddress {
  agentId: AgentId;
  sessionId: SessionId;
  tabId: TabId;
  pathId: BrowserPathId;
  hostGeneration: number;
  engineGeneration: number;
  controlEpoch: number;
}

export type ActionKind =
  | "navigate" | "mouse-move" | "mouse-down" | "mouse-up" | "click" | "double-click"
  | "wheel" | "drag" | "key-press" | "key-down" | "key-up" | "text-input" | "fill"
  | "select" | "upload" | "download" | "back" | "forward" | "reload" | "wait";

export type ObservationView = "main" | "interactive" | "visual" | "full" | "diff";

export interface CapabilityTruth {
  pathId: BrowserPathId;
  actions: ActionKind[];
  observations: ObservationView[];
  touch: false;
  uploads: boolean;
  downloads: boolean;
  visual: boolean;
}

export interface BrowserSessionV2 {
  sessionId: SessionId;
  owner: OwnerIdentity;
  path: PathIdentity;
  capabilities: CapabilityTruth;
  state: "creating" | "ready" | "closing" | "closed" | "failed" | "recovering";
  createdAt: string;
}

export interface ViewportBinding {
  viewportId: string;
  generation: number;
  cssWidth: number;
  cssHeight: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
  coordinateSpace: "css-viewport-top-left";
}

export interface ScreenshotBinding {
  artifactId: ArtifactId;
  sha256: string;
  sequence: number;
  capturedAt: string;
  pixelWidth: number;
  pixelHeight: number;
  viewport: ViewportBinding;
}

export interface VisualGuard {
  viewportId: string;
  viewportGeneration: number;
  screenshotSha256: string;
  screenshotSequence: number;
}

export interface CssPoint { x: number; y: number }
export type MouseButton = "left" | "middle" | "right";

export type BrowserActionV2 =
  | { kind: "navigate"; url: string }
  | { kind: "mouse-move"; point: CssPoint; visualGuard: VisualGuard }
  | { kind: "mouse-down" | "mouse-up" | "click" | "double-click"; point: CssPoint; button: MouseButton; visualGuard: VisualGuard }
  | { kind: "wheel"; deltaX: number; deltaY: number; visualGuard: VisualGuard }
  | { kind: "drag"; from: CssPoint; to: CssPoint; visualGuard: VisualGuard }
  | { kind: "key-press" | "key-down" | "key-up"; key: string }
  | { kind: "text-input"; text: string }
  | { kind: "fill"; ref?: string; text: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "upload"; ref: string; uploadHandleIds: TransferId[] }
  | { kind: "download"; ref: string }
  | { kind: "back" | "forward" | "reload" }
  | { kind: "wait"; milliseconds: number };

export interface InteractiveControl {
  ref: string;
  role: string;
  name: string;
  state?: string;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ProtocolObservation {
  observationId: ObservationId;
  operationId: OperationId;
  owner: OwnerIdentity;
  address: ProtocolAddress;
  path: PathIdentity;
  view: ObservationView;
  sequence: number;
  observedAt: string;
  title: string;
  url: string;
  content: string;
  controls?: InteractiveControl[];
  changed?: string[];
  screenshot?: ScreenshotBinding;
  fullArtifactId?: ArtifactId;
  truncated: boolean;
}

export interface PostActionEvidence {
  observationId: ObservationId;
  sequence: number;
  summary: string;
  changed: string[];
}

export interface ActionOutcomeV2 {
  operationId: OperationId;
  owner: OwnerIdentity;
  address: ProtocolAddress;
  path: PathIdentity;
  dispatched: boolean;
  evidence: PostActionEvidence;
  downloadArtifactId?: ArtifactId;
}

export type OperationState = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export interface DurableOperation {
  operationId: OperationId;
  owner: OwnerIdentity;
  address: ProtocolAddress;
  path: PathIdentity;
  kind: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  cancellationRequested: boolean;
  error?: StructuredError;
}

export interface CancellationResult {
  operationId: OperationId;
  outcome: "cancelled" | "already-terminal" | "not-cancellable";
  state: OperationState;
  completedAt: string;
}

export interface OwnedArtifact {
  artifactId: ArtifactId;
  owner: OwnerIdentity;
  sessionId?: SessionId;
  tabId?: TabId;
  kind: "screenshot" | "full-observation" | "download" | "upload" | "pdf" | "diagnostic";
  sha256: string;
  mediaType: string;
  size: number;
  createdAt: string;
  integrityVerified: true;
}

export interface TransferHandle {
  transferId: TransferId;
  owner: OwnerIdentity;
  direction: "upload" | "download";
  state: "staged" | "committed" | "consumed" | "failed" | "expired";
  sha256: string;
  size: number;
  expiresAt: string;
  artifactId?: ArtifactId;
}

export interface ControlLease {
  owner: OwnerIdentity;
  sessionId: SessionId;
  tabId: TabId;
  controller: "agent" | "human";
  controlEpoch: number;
  viewportGeneration: number;
  changedAt: string;
}

export type ErrorCode =
  | "invalid-request" | "unauthenticated" | "wrong-owner" | "not-found" | "wrong-path"
  | "stale-generation" | "stale-visual" | "stale-control-epoch" | "unsupported" | "conflict"
  | "cancelled" | "backend-failure" | "integrity-failure" | "cleanup-failure";

export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  path?: PathIdentity;
  operationId?: OperationId;
}

export const RPC_METHODS = [
  "system.capabilities", "session.create", "session.list", "session.close",
  "tab.create", "tab.list", "tab.close", "browser.observe", "browser.act",
  "operation.get", "operation.cancel", "artifact.list", "artifact.get", "artifact.delete",
  "transfer.stageUpload", "transfer.commitUpload", "control.takeover", "control.return",
  "lifecycle.cleanup", "lifecycle.recover",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_EVENTS = [
  "session.changed", "tab.changed", "operation.changed", "artifact.created", "control.changed", "lifecycle.changed",
] as const;
export type RpcEvent = (typeof RPC_EVENTS)[number];

export interface JsonRpcRequest<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: string | number;
  method: RpcMethod;
  params: P;
}
export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: R;
  error?: StructuredError;
}
export interface JsonRpcNotification<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: RpcEvent;
  params?: P;
}

export class ProtocolValidationError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
export function isSupportedPathId(value: unknown): value is BrowserPathId {
  return typeof value === "string" && (SUPPORTED_PATH_IDS as readonly string[]).includes(value);
}

export function assertProtocolAddress(value: unknown): asserts value is ProtocolAddress {
  if (!isRecord(value)) throw new ProtocolValidationError("invalid-request", "address must be an object");
  for (const key of ["agentId", "sessionId", "tabId"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new ProtocolValidationError("invalid-request", `${key} must be a non-empty string`);
    }
  }
  if (!isSupportedPathId(value.pathId)) throw new ProtocolValidationError("invalid-request", "unsupported pathId");
  for (const key of ["hostGeneration", "engineGeneration", "controlEpoch"] as const) {
    if (!positiveInteger(value[key])) throw new ProtocolValidationError("invalid-request", `${key} must be a positive integer`);
  }
}

export function assertBinding(
  principal: AuthenticatedPrincipal,
  owner: OwnerIdentity,
  address: ProtocolAddress,
  path: PathIdentity,
  currentControlEpoch: number,
): void {
  assertProtocolAddress(address);
  if (principal.principalId !== owner.principalId || address.agentId !== owner.agentId) {
    throw new ProtocolValidationError("wrong-owner", "browser state has a different owner");
  }
  if (address.pathId !== path.pathId) throw new ProtocolValidationError("wrong-path", "session path is immutable");
  if (address.hostGeneration !== path.hostGeneration || address.engineGeneration !== path.engineGeneration) {
    throw new ProtocolValidationError("stale-generation", "host or engine generation is stale");
  }
  if (address.controlEpoch !== currentControlEpoch) {
    throw new ProtocolValidationError("stale-control-epoch", "control epoch is stale");
  }
}

export function assertCurrentVisual(guard: VisualGuard, screenshot: ScreenshotBinding): void {
  if (guard.viewportId !== screenshot.viewport.viewportId || guard.viewportGeneration !== screenshot.viewport.generation
    || guard.screenshotSha256 !== screenshot.sha256 || guard.screenshotSequence !== screenshot.sequence) {
    throw new ProtocolValidationError("stale-visual", "visual input is not bound to the current screenshot");
  }
}

export function assertPointInViewport(point: CssPoint, viewport: ViewportBinding): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
    || point.x >= viewport.cssWidth || point.y >= viewport.cssHeight) {
    throw new ProtocolValidationError("invalid-request", "CSS point is outside the viewport");
  }
}

export function isMajorCompatible(version: string): boolean {
  return Number.parseInt(version.split(".", 1)[0] ?? "", 10) === PROTOCOL_MAJOR;
}

// Temporary source-compatibility aliases for candidate code that still uses the
// protocol 1 coordinator model. They are not part of the protocol 2 schema.
export type PiMode = "tui" | "rpc" | "json" | "print";
export type BrowserBackend = "agent-browser" | "pinchtab";
export type BrowserEngine = "lightpanda" | "chromium";
export type BrowserControl = "agent" | "human" | "shared";
export interface AgentRegistration { agentId: string; clientId: string; piSessionId?: string; piSessionFile?: string; piSessionName?: string; cwd: string; pid: number; mode: PiMode; startedAt: string; lastHeartbeatAt: string }
export interface BrowserProfile { profileId: string; name: string; engine: "chromium"; dataDir: string; extensions: string[]; launchArgs: string[]; visibleByDefault: boolean }
export interface BrowserHost { hostId: string; backend: BrowserBackend; engine: BrowserEngine; profileId?: string; state: "starting" | "ready" | "stopping" | "stopped" | "failed"; backendSessionId: string; createdAt: string }
export interface BrowserSession { browserSessionId: string; ownerAgentId: string; hostId: string; label: string; createdAt: string; lastActivityAt: string }
export interface TabInfo { tabId: string; hostId: string; browserSessionId: string; ownerAgentId: string; title: string; url: string; index: number; control: BrowserControl; state: "idle" | "running" | "waiting" | "crashed"; lastActionAt?: string }
export interface ArtifactRecord { artifactId: string; sha256: string; ownerAgentId?: string; browserSessionId?: string; tabId?: string; mediaType: string; size: number; path: string; sourceUrl?: string; createdAt: string; metadata: Record<string, unknown> }
export interface BrowserAddress { agentId: string; browserSessionId: string; tabId: string }
export interface Observation { view: ObservationView; title: string; url: string; content: string; controls?: InteractiveControl[]; changed?: string[]; artifactId?: string; truncated: boolean; metadata?: Record<string, unknown> }
export type BrowserAction =
  | { kind: "navigate"; url: string } | { kind: "click"; ref?: string; selector?: string }
  | { kind: "fill" | "type"; ref?: string; selector?: string; text: string } | { kind: "press"; key: string }
  | { kind: "select"; ref?: string; selector?: string; values: string[] } | { kind: "hover"; ref?: string; selector?: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number } | { kind: "drag"; ref: string; targetRef: string }
  | { kind: "upload"; ref?: string; selector?: string; files: string[] } | { kind: "download"; ref?: string; selector?: string }
  | { kind: "back" | "forward" | "reload" } | { kind: "wait"; milliseconds?: number; selector?: string; text?: string }
  | { kind: "tab-new"; url?: string } | { kind: "tab-close"; tabId?: string } | { kind: "tab-focus"; tabId: string };
export interface ActionResult { ok: boolean; action: string; url?: string; title?: string; changed: string[]; newTabId?: string; downloadArtifactId?: string; artifactId?: string; backend?: Record<string, unknown> }
export interface BrowserCapabilities { backend: BrowserBackend; engines: BrowserEngine[]; actions: BrowserAction["kind"][]; debug: string[]; persistentProfiles: boolean; extensions: boolean; viewportStreaming: boolean; directTabAddressing: boolean }
export interface StreamInfo { protocol: string; url: string; token?: string; width?: number; height?: number; metadata?: Record<string, unknown> }
export type RpcErrorShape = StructuredError;
export const assertExplicitAddress = (value: unknown): asserts value is BrowserAddress => {
  if (!isRecord(value)) throw new TypeError("browser address is required");
  for (const key of ["agentId", "browserSessionId", "tabId"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new TypeError(`${key} must be a non-empty string`);
  }
};
