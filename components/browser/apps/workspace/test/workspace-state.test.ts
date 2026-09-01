import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App";
import { clearRenderedFrame, resetFrameMetrics, type FrameMetrics } from "../src/FrameViewport";
import type {
  FrameMetadata,
  FrontendStateRecord,
  PublicWorkspaceState,
  WorkspaceApi,
  WorkspaceSession,
  WorkspaceSnapshot,
  WorkspaceTab,
} from "../src/bridge";
import {
  displayText,
  findSelected,
  FrameSequenceWatermark,
  framePaintBindingKey,
  framePaintReadinessEligible,
  frameRejectionReason,
  initialWorkspaceViewState,
  reduceWorkspaceRecord,
} from "../src/workspaceState";

const sessionA = makeSession("session:a", "actor_AAAAAAAAA", "Agent <script>alert(1)</script>", "tab:a");
const sessionB = makeSession("session:b", "actor_BBBBBBBBB", "Agent B", "tab:b");
const snapshot: WorkspaceSnapshot = {
  generatedAt: "2026-08-30T00:00:00.000Z",
  browserdState: "ready",
  sessions: [sessionA, sessionB],
};
const selected = { browserSessionId: "session:a", tabId: "tab:a" };

function makeSession(browserSessionId: string, actorDisplayId: string, agentLabel: string, tabId: string): WorkspaceSession {
  return {
    browserSessionId,
    actorDisplayId,
    agentLabel,
    pathId: "agentcursor/chrome",
    state: "ready",
    controlState: "agent",
    captureReadiness: "ready",
    personaDisplayId: "persona_AAAAAAAA",
    cursor: { x: 12, y: 34, visible: true },
    tabs: [{
      tabId,
      title: `<img src=x onerror=alert(1)>\u202e`,
      url: "http://fixture.local/test?value=<script>",
      state: "ready",
      captureReadiness: "ready",
    }],
    lastActivityAt: "2026-08-30T00:00:00.000Z",
  };
}

function metadata(overrides: Partial<FrameMetadata> = {}): FrameMetadata {
  return {
    deliveryId: 1,
    capturedAt: "2026-08-30T00:00:00.000Z",
    publishedAt: "2026-08-30T00:00:00.001Z",
    receivedAt: "2026-08-30T00:00:00.002Z",
    mediaType: "image/png",
    byteLength: 8,
    sha256: "a".repeat(64),
    imagePixelWidth: 10,
    imagePixelHeight: 10,
    ...overrides,
  };
}

function publicState(overrides: Partial<PublicWorkspaceState> = {}): PublicWorkspaceState {
  return { connection: "ready", snapshot, selected, droppedBeforeFrontend: 0, inflightFrame: false, ...overrides };
}

function firstTab(session: WorkspaceSession): WorkspaceTab {
  const tab = session.tabs.at(0);
  if (!tab) throw new Error("test session must contain one tab");
  return tab;
}

describe("workspace state", () => {
  it("reduces multi-agent snapshots, selections, reconnects, and removal", () => {
    let state = reduceWorkspaceRecord(initialWorkspaceViewState, { kind: "snapshot", snapshot });
    expect(state.publicState.snapshot?.sessions).toHaveLength(2);
    state = reduceWorkspaceRecord(state, { kind: "selection", selected });
    expect(findSelected(state.publicState.snapshot?.sessions, state.publicState.selected)?.session.actorDisplayId).toBe(sessionA.actorDisplayId);
    state = reduceWorkspaceRecord(state, { kind: "current", state: { ...state.publicState, connection: "reconnecting" } });
    expect(state.status.connection).toBe("reconnecting");
    state = reduceWorkspaceRecord(state, { kind: "snapshot", snapshot: { ...snapshot, sessions: [sessionB] } });
    expect(findSelected(state.publicState.snapshot?.sessions, state.publicState.selected)).toBeUndefined();
    state = reduceWorkspaceRecord(state, { kind: "selectionCleared" });
    expect(state.publicState.selected).toBeUndefined();
  });

  it("retains launcher errors across ordinary current and snapshot records", () => {
    let state = reduceWorkspaceRecord(initialWorkspaceViewState, {
      kind: "error",
      error: { code: "INVALID_SELECTION", message: "The selected browser tab is unavailable.", retryable: false },
    });
    state = reduceWorkspaceRecord(state, { kind: "current", state: publicState() });
    state = reduceWorkspaceRecord(state, { kind: "snapshot", snapshot });
    expect(state.error).toBe("The selected browser tab is unavailable.");
    state = reduceWorkspaceRecord(state, { kind: "selection", selected });
    expect(state.error).toBeUndefined();
  });

  it("accepts only bounded display metadata while Rust retains frame authority", () => {
    expect(frameRejectionReason(metadata(), publicState(), 0)).toBeUndefined();
    expect(frameRejectionReason(metadata(), { ...publicState(), selected: undefined }, 0)).toBe("selection");
    expect(frameRejectionReason(metadata({ deliveryId: 1 }), publicState(), 1)).toBe("sequence");
    expect(frameRejectionReason(metadata({ imagePixelWidth: 32_768, imagePixelHeight: 32_768 }), publicState(), 0)).toBe("dimensions");
    expect(metadata()).not.toHaveProperty("subscriptionId");
    expect(metadata()).not.toHaveProperty("controlEpoch");
  });

  it("invalidates retained pixels on public control, tab, or readiness changes while Rust retains authority", () => {
    const initial = publicState();
    const initialKey = framePaintBindingKey(initial);
    const changed = (sessionChanges: Partial<WorkspaceSession>, tabChanges: Partial<WorkspaceTab> = {}) => publicState({
      snapshot: {
        ...snapshot,
        sessions: [{ ...sessionA, ...sessionChanges, tabs: [{ ...firstTab(sessionA), ...tabChanges }] }, sessionB],
      },
    });
    expect(framePaintBindingKey(changed({ controlState: "human" }))).not.toBe(initialKey);
    expect(framePaintBindingKey(changed({}, { state: "crashed" }))).not.toBe(initialKey);
    const degraded = changed({ captureReadiness: "degraded" });
    const warming = changed({}, { captureReadiness: "warming" });
    expect(framePaintBindingKey(degraded)).toBe(initialKey);
    expect(framePaintBindingKey(warming)).toBe(initialKey);
    expect(framePaintReadinessEligible(initial)).toBe(true);
    expect(framePaintReadinessEligible(degraded)).toBe(false);
    expect(framePaintReadinessEligible(warming)).toBe(false);

    let cleared: [number, number, number, number] | undefined;
    let removed = false;
    const canvas = {
      width: 10,
      height: 20,
      style: { width: "10px", height: "20px" },
      getContext: () => ({ clearRect: (x: number, y: number, width: number, height: number) => { cleared = [x, y, width, height]; } }),
      removeAttribute: (name: string) => { if (name === "data-frame-sequence") removed = true; },
    } as unknown as HTMLCanvasElement;
    clearRenderedFrame(canvas);
    expect(cleared).toEqual([0, 0, 10, 20]);
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height, removed]).toEqual([0, 0, "0px", "0px", true]);

    const priorMetrics: FrameMetrics = {
      metadata: metadata(),
      paintedAt: "2026-08-30T00:00:01.000Z",
      droppedBeforeDecode: 2,
      droppedDuringDecode: 3,
      malformedFrames: 4,
      digestFailures: 5,
      dimensionFailures: 6,
    };
    expect(resetFrameMetrics(priorMetrics)).toEqual({
      droppedBeforeDecode: 2,
      droppedDuringDecode: 3,
      malformedFrames: 0,
      digestFailures: 0,
      dimensionFailures: 0,
    });
  });

  it("does not poison the sequence watermark when verification fails before commit", () => {
    const watermark = new FrameSequenceWatermark();
    expect(watermark.canAccept(10)).toBe(true);
    // A failed digest does not call commit, so a corrected delivery of the same sequence remains eligible.
    expect(watermark.canAccept(10)).toBe(true);
    expect(watermark.commit(10)).toBe(true);
    expect(watermark.canAccept(10)).toBe(false);
    watermark.reset();
    expect(watermark.canAccept(1)).toBe(true);
  });

  it("neutralizes control and bidi characters and relies on React text escaping", () => {
    const hostile = `<script>alert(1)</script>\u0000\u202e`;
    const safe = displayText(hostile);
    expect(safe).not.toContain("\u0000");
    expect(safe).not.toContain("\u202e");
    const markup = renderToStaticMarkup(createElement("span", null, safe));
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("renders explicit accessible takeover controls without enabling input from an unpainted frame", () => {
    const inertBridge: WorkspaceApi = {
      open: async (_onState: (record: FrontendStateRecord) => void, _onFrame: (record: ArrayBuffer) => void) => undefined,
      select: async () => selected,
      clearSelection: async () => undefined,
      currentState: async () => publicState(),
      acknowledgeFrame: async () => undefined,
      takeControl: async () => ({ controlState: "human" }),
      returnControl: async () => ({ controlState: "agent" }),
      input: async (events) => ({ kind: "inputAck", inputBatchSequence: 1, acceptedEventCount: events.length, coalescedPointerMoveCount: 0, awaitingNewFrame: false }),
      windowAction: async () => undefined,
    };
    const initialState = reduceWorkspaceRecord(
      reduceWorkspaceRecord(
        reduceWorkspaceRecord(initialWorkspaceViewState, { kind: "status", status: { connection: "ready", browserd: "ready" } }),
        { kind: "snapshot", snapshot },
      ),
      { kind: "selection", selected },
    );
    const markup = renderToStaticMarkup(createElement(App, { bridge: inertBridge, initialState }));
    expect(markup).toContain('aria-label="Active agents and browser sessions"');
    expect(markup).toContain('aria-label="Live read-only browser screenshot"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("Agent B");
    expect(markup).toContain("Agent control");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("Take control");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("dangerouslySetInnerHTML");

    const preparingSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      sessions: [{ ...sessionA, captureReadiness: "warming", tabs: [{ ...firstTab(sessionA), captureReadiness: "warming" }] }, sessionB],
    };
    const preparingState = reduceWorkspaceRecord(
      reduceWorkspaceRecord(initialWorkspaceViewState, { kind: "status", status: { connection: "ready", browserd: "ready" } }),
      { kind: "snapshot", snapshot: preparingSnapshot },
    );
    const preparingSelected = reduceWorkspaceRecord(preparingState, { kind: "selection", selected });
    const preparingMarkup = renderToStaticMarkup(createElement(App, { bridge: inertBridge, initialState: preparingSelected }));
    expect(preparingMarkup).toContain("Browser view is preparing.");

    const reconnecting = reduceWorkspaceRecord(initialState, { kind: "current", state: { ...initialState.publicState, connection: "reconnecting" } });
    const reconnectingMarkup = renderToStaticMarkup(createElement(App, { bridge: inertBridge, initialState: reconnecting }));
    expect(reconnectingMarkup).toContain("Reconnecting to the local workspace");
    expect(reconnectingMarkup).not.toContain("Agent B");
  });
});
