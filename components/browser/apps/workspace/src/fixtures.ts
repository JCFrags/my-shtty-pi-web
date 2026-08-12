import type { ControlState, SafeFailure, ViewportLease, ViewportState, WorkspaceSnapshot } from "./model.ts";

export const FIXTURE_STATES = [
  "no-session", "connecting", "live", "takeover-pending", "human", "return-pending", "stale",
  "unsupported", "queued", "cancelling", "cancelled", "crashed", "failed",
] as const;
export type FixtureState = (typeof FIXTURE_STATES)[number];

const identity = {
  agentLabel: "Public fixture agent",
  browserSessionId: "session-public-fixture",
  sessionLabel: "Public fixture session",
  tabId: "tab-public-fixture",
  viewportId: "viewport-public-fixture",
  pathId: "agent-browser/chrome" as const,
  backend: "agent-browser" as const,
  engine: "chrome" as const,
  coordinateSpace: "css-viewport" as const,
  viewportGeneration: 7,
  hostGeneration: 1,
  engineGeneration: 1,
  controlEpoch: 12,
};

export function parseFixtureState(search: string): FixtureState | undefined {
  const state = new URLSearchParams(search).get("fixture");
  return FIXTURE_STATES.find((candidate) => candidate === state);
}

export function fixtureData(state: FixtureState): { snapshot: WorkspaceSnapshot; lease?: ViewportLease; fixtureFrameUrl?: string } {
  if (state === "no-session") {
    return {
      snapshot: { scopeId: "scope-public-fixture", agentLabel: identity.agentLabel, sessions: [], tabs: [], viewportState: "unselected", controlState: "agent", events: [] },
    };
  }
  const viewportState: ViewportState = state === "unsupported" ? "unsupported" : state === "crashed" || state === "failed" ? "failed" : state === "stale" ? "stale" : state === "connecting" ? "connecting" : "live";
  const controlState: ControlState = state === "takeover-pending" || state === "human" || state === "return-pending" ? state : "agent";
  const failure: SafeFailure | undefined = state === "crashed"
    ? { code: "browser_crashed", message: "The browser tab crashed.", recovery: "retry", diagnosticRef: "fixture-crash-01" }
    : state === "failed"
      ? { code: "operation_failed", message: "The browser operation failed.", recovery: "retry", diagnosticRef: "fixture-failure-01" }
      : state === "unsupported"
        ? { code: "unsupported", message: "Live view is not supported by this path.", recovery: "none" }
        : undefined;
  const operationState = state === "queued" || state === "cancelling" || state === "cancelled" ? state : "idle";
  const snapshot: WorkspaceSnapshot = {
    scopeId: "scope-public-fixture",
    agentLabel: identity.agentLabel,
    sessions: [{ browserSessionId: identity.browserSessionId, label: identity.sessionLabel, pathId: identity.pathId, backend: identity.backend, engine: identity.engine }],
    tabs: [{ tabId: identity.tabId, browserSessionId: identity.browserSessionId, title: "Public fixture page", url: "https://example.com/", state: state === "crashed" ? "crashed" : "idle" }],
    selected: identity,
    viewportState,
    controlState,
    operation: operationState === "idle" ? undefined : { operationId: "operation-public-fixture", label: "Open public fixture", state: operationState, cancellable: operationState !== "cancelled" },
    failure,
    events: [
      { id: "event-2", at: "12:00:02", message: statusMessage(state) },
      { id: "event-1", at: "12:00:01", message: "Public fixture tab selected." },
    ],
  };
  return {
    snapshot,
    fixtureFrameUrl: "/public-fixture.svg",
    lease: {
      leaseId: "lease-public-fixture",
      expiresAt: "2099-01-01T00:00:00.000Z",
      transport: state === "unsupported" ? "unsupported" : "polled-frames",
      identity,
      geometry: { imageWidth: 1280, imageHeight: 960, viewportWidth: 640, viewportHeight: 480, deviceScaleFactor: 2 },
      inputSupported: state !== "unsupported" && state !== "stale" && state !== "crashed" && state !== "failed",
    },
  };
}

function statusMessage(state: FixtureState): string {
  const messages: Record<FixtureState, string> = {
    "no-session": "No browser session is available.", connecting: "Connecting to the live view.", live: "The live view is current.",
    "takeover-pending": "Taking control after the current action.", human: "Human control is active.", "return-pending": "Returning control to the agent.",
    stale: "The last frame is stale.", unsupported: "This path does not support a live view.", queued: "The operation is queued.",
    cancelling: "Cancellation is pending.", cancelled: "The operation was cancelled.", crashed: "The browser tab crashed.", failed: "A safe failure is shown.",
  };
  return messages[state];
}
