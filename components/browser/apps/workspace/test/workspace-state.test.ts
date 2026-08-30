import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App";
import type {
  FrameMetadata,
  FrontendStateRecord,
  PublicWorkspaceState,
  WorkspaceApi,
  WorkspaceSession,
  WorkspaceSnapshot,
} from "../src/bridge";
import {
  displayText,
  findSelected,
  FrameSequenceWatermark,
  frameRejectionReason,
  initialWorkspaceViewState,
  reduceWorkspaceRecord,
} from "../src/workspaceState";

const sessionA = makeSession("session:a", "actor_AAAAAAAAA", "Agent <script>alert(1)</script>", "tab:a");
const sessionB = makeSession("session:b", "actor_BBBBBBBBB", "Agent B", "tab:b");
const snapshot: WorkspaceSnapshot = {
  workspaceRevision: 7,
  browserdRuntimeInstanceId: "runtime_AAAAAAAA",
  generatedAt: "2026-08-30T00:00:00.000Z",
  browserdState: "ready",
  sessions: [sessionA, sessionB],
};
const selected = { selectionId: "selection_AAAAAA", browserSessionId: "session:a", tabId: "tab:a" };

function makeSession(browserSessionId: string, actorDisplayId: string, agentLabel: string, tabId: string): WorkspaceSession {
  return {
    browserSessionId,
    actorDisplayId,
    agentLabel,
    pathId: "agentcursor/chrome",
    state: "ready",
    controlState: "agent",
    personaDisplayId: "persona_AAAAAAAA",
    cursor: { x: 12, y: 34, visible: true, pathSequence: 5, sampleSequence: 8 },
    tabs: [{
      tabId,
      title: `<img src=x onerror=alert(1)>\u202e`,
      url: "http://fixture.local/test?value=<script>",
      state: "ready",
      documentGeneration: 3,
      viewportGeneration: 4,
      frameSequence: 9,
    }],
    lastActivityAt: "2026-08-30T00:00:00.000Z",
  };
}

function metadata(overrides: Partial<FrameMetadata> = {}): FrameMetadata {
  return {
    deliveryId: 1,
    selectionId: selected.selectionId,
    subscriptionId: "subscription_AAA",
    browserdRuntimeInstanceId: "runtime_AAAAAAAA",
    browserSessionId: selected.browserSessionId,
    tabId: selected.tabId,
    frameSequence: 10,
    documentGeneration: 3,
    viewportGeneration: 4,
    capturedAt: "2026-08-30T00:00:00.000Z",
    publishedAt: "2026-08-30T00:00:00.001Z",
    receivedAt: "2026-08-30T00:00:00.002Z",
    mediaType: "image/png",
    byteLength: 8,
    sha256: "a".repeat(64),
    width: 10,
    height: 10,
    ...overrides,
  };
}

function publicState(overrides: Partial<PublicWorkspaceState> = {}): PublicWorkspaceState {
  return { connection: "ready", snapshot, selected, droppedBeforeFrontend: 0, inflightFrame: false, ...overrides };
}

describe("workspace state", () => {
  it("reduces multi-agent snapshots, selections, reconnects, and removal", () => {
    let state = reduceWorkspaceRecord(initialWorkspaceViewState, { kind: "snapshot", snapshot });
    expect(state.publicState.snapshot?.sessions).toHaveLength(2);
    state = reduceWorkspaceRecord(state, { kind: "selection", selected });
    expect(findSelected(state.publicState.snapshot?.sessions, state.publicState.selected)?.session.actorDisplayId).toBe(sessionA.actorDisplayId);
    state = reduceWorkspaceRecord(state, { kind: "current", state: { ...state.publicState, connection: "reconnecting" } });
    expect(state.status.connection).toBe("reconnecting");
    state = reduceWorkspaceRecord(state, { kind: "snapshot", snapshot: { ...snapshot, workspaceRevision: 8, sessions: [sessionB] } });
    expect(findSelected(state.publicState.snapshot?.sessions, state.publicState.selected)).toBeUndefined();
    state = reduceWorkspaceRecord(state, { kind: "selectionCleared" });
    expect(state.publicState.selected).toBeUndefined();
  });

  it("rejects frames from another runtime, tab, generation, or former sequence", () => {
    expect(frameRejectionReason(metadata(), publicState(), 9)).toBeUndefined();
    expect(frameRejectionReason(metadata({ browserdRuntimeInstanceId: "runtime_BBBBBBBB" }), publicState(), 9)).toBe("runtime");
    expect(frameRejectionReason(metadata({ tabId: "tab:b" }), publicState(), 9)).toBe("selection");
    expect(frameRejectionReason(metadata({ documentGeneration: 2 }), publicState(), 9)).toBe("document-generation");
    expect(frameRejectionReason(metadata({ viewportGeneration: 3 }), publicState(), 9)).toBe("viewport-generation");
    expect(frameRejectionReason(metadata({ frameSequence: 9 }), publicState(), 9)).toBe("sequence");
    expect(frameRejectionReason(metadata({ width: 32_768, height: 32_768 }), publicState(), 9)).toBe("dimensions");
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

  it("renders native keyboard controls and labelled read-only regions without a browser input surface", () => {
    const inertBridge: WorkspaceApi = {
      open: async (_onState: (record: FrontendStateRecord) => void, _onFrame: (record: ArrayBuffer) => void) => undefined,
      select: async () => selected,
      clearSelection: async () => undefined,
      currentState: async () => publicState(),
      acknowledgeFrame: async () => undefined,
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
    expect(markup).toContain("Viewing agent control");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("Take control");
    expect(markup).not.toContain("dangerouslySetInnerHTML");

    const reconnecting = reduceWorkspaceRecord(initialState, { kind: "current", state: { ...initialState.publicState, connection: "reconnecting" } });
    const reconnectingMarkup = renderToStaticMarkup(createElement(App, { bridge: inertBridge, initialState: reconnecting }));
    expect(reconnectingMarkup).toContain("Reconnecting to the local workspace");
    expect(reconnectingMarkup).not.toContain("Agent B");
  });
});
