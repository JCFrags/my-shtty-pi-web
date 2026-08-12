export const PRODUCT_PATHS = ["agent-browser/chrome", "pinchtab/chrome"] as const;
export type ProductPathId = (typeof PRODUCT_PATHS)[number];
export type ControlState = "agent" | "takeover-pending" | "human" | "return-pending" | "conflict";
export type ViewportState = "unselected" | "connecting" | "live" | "stale" | "reconnecting" | "unsupported" | "failed" | "closed";
export type OperationState = "idle" | "queued" | "running" | "succeeded" | "cancelling" | "cancelled" | "failed";

export interface WorkspaceIdentity {
  agentLabel: string;
  browserSessionId: string;
  sessionLabel: string;
  tabId: string;
  viewportId: string;
  pathId: ProductPathId;
  backend: "agent-browser" | "pinchtab";
  engine: "chrome";
  coordinateSpace: "css-viewport";
  viewportGeneration: number;
  hostGeneration: number;
  engineGeneration: number;
  controlEpoch: number;
}

export interface WorkspaceTab {
  tabId: string;
  browserSessionId: string;
  title: string;
  url: string;
  state: "idle" | "running" | "waiting" | "crashed";
}

export interface WorkspaceSession {
  browserSessionId: string;
  label: string;
  pathId: ProductPathId;
  backend: "agent-browser" | "pinchtab";
  engine: "chrome";
}

export interface SafeFailure {
  code: "ownership_lost" | "lease_expired" | "stream_disconnected" | "geometry_changed" | "control_conflict" | "browser_crashed" | "operation_failed" | "daemon_disconnected" | "unsupported";
  message: string;
  recovery: "refresh" | "renew-lease" | "retry" | "return-control" | "none";
  diagnosticRef?: string;
}

export interface WorkspaceOperation {
  operationId: string;
  label: string;
  state: OperationState;
  cancellable: boolean;
}

export interface WorkspaceSnapshot {
  scopeId: string;
  agentLabel: string;
  sessions: WorkspaceSession[];
  tabs: WorkspaceTab[];
  selected?: WorkspaceIdentity;
  viewportState: ViewportState;
  controlState: ControlState;
  operation?: WorkspaceOperation;
  failure?: SafeFailure;
  events: Array<{ id: string; at: string; message: string }>;
}

export interface ViewportGeometry {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
}

export interface ViewportLease {
  leaseId: string;
  streamUrl?: string;
  expiresAt: string;
  transport: "polled-frames" | "unsupported";
  identity: WorkspaceIdentity;
  geometry: ViewportGeometry;
  inputSupported: boolean;
}

export interface WorkspaceFrame {
  viewportId: string;
  viewportGeneration: number;
  sequence: number;
  capturedAt: string;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  coordinateSpace: "css-viewport";
  payload: string;
  screenshotSha256: string;
  controlEpoch: number;
  geometry: ViewportGeometry;
}

const SAFE_FAILURES: Record<SafeFailure["code"], Omit<SafeFailure, "code">> = {
  ownership_lost: { message: "This view is no longer available.", recovery: "refresh" },
  lease_expired: { message: "Live view authorization expired.", recovery: "renew-lease" },
  stream_disconnected: { message: "The live view disconnected.", recovery: "retry" },
  geometry_changed: { message: "The viewport geometry changed. Input is disabled.", recovery: "renew-lease" },
  control_conflict: { message: "Control changed in another workspace.", recovery: "refresh" },
  browser_crashed: { message: "The browser tab crashed.", recovery: "retry" },
  operation_failed: { message: "The browser operation failed.", recovery: "retry" },
  daemon_disconnected: { message: "The browser service disconnected.", recovery: "retry" },
  unsupported: { message: "Live view is not supported by this path.", recovery: "none" },
};

export function safeFailure(value: unknown): SafeFailure {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requested = typeof record.code === "string" ? record.code : "operation_failed";
  const code = requested in SAFE_FAILURES ? requested as SafeFailure["code"] : "operation_failed";
  const base = SAFE_FAILURES[code];
  const diagnosticRef = typeof record.diagnosticRef === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(record.diagnosticRef)
    ? record.diagnosticRef
    : undefined;
  return { code, ...base, ...(diagnosticRef ? { diagnosticRef } : {}) };
}

export function isSupportedPath(value: string): value is ProductPathId {
  return PRODUCT_PATHS.some((path) => path === value);
}

export function selectOwnedTab(snapshot: WorkspaceSnapshot, tabId: string): WorkspaceTab | undefined {
  return snapshot.tabs.find((tab) => tab.tabId === tabId && snapshot.sessions.some((session) => session.browserSessionId === tab.browserSessionId));
}

export function acceptFrame(frame: WorkspaceFrame, lease: ViewportLease, lastSequence: number): "accept" | "stale" | "invalid" {
  if (frame.viewportId !== lease.identity.viewportId || frame.viewportGeneration !== lease.identity.viewportGeneration) return "stale";
  if (frame.sequence <= lastSequence) return "stale";
  if (frame.mediaType !== "image/jpeg" && frame.mediaType !== "image/png") return "invalid";
  if (frame.coordinateSpace !== lease.identity.coordinateSpace) return "invalid";
  if (frame.width !== frame.geometry.imageWidth || frame.height !== frame.geometry.imageHeight) return "invalid";
  if (frame.geometry.viewportWidth < 1 || frame.geometry.viewportHeight < 1 || frame.geometry.deviceScaleFactor <= 0) return "invalid";
  if (frame.width < 1 || frame.height < 1 || frame.width * frame.height > 40_000_000) return "invalid";
  if (!Number.isFinite(Date.parse(frame.capturedAt))) return "invalid";
  if (!/^[a-f0-9]{64}$/.test(frame.screenshotSha256) || frame.controlEpoch < 1) return "invalid";
  return "accept";
}

export function mapViewportPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  geometry: ViewportGeometry,
): { x: number; y: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0 || geometry.viewportWidth <= 0 || geometry.viewportHeight <= 0) return undefined;
  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) return undefined;
  return {
    x: Math.min(geometry.viewportWidth - Number.EPSILON, Math.max(0, normalizedX * geometry.viewportWidth)),
    y: Math.min(geometry.viewportHeight - Number.EPSILON, Math.max(0, normalizedY * geometry.viewportHeight)),
  };
}
