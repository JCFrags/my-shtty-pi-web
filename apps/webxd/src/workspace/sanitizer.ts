import { createHmac } from "node:crypto";
import type { WorkspaceSnapshot as BrowserWorkspaceSnapshot, WorkspaceFrameEvent } from "../../../../packages/browser-protocol/src/index.js";
import type { WorkspaceFrameHeader, WorkspaceSnapshot } from "../../../../packages/workspace-protocol/src/index.js";

const OPERATION_KINDS = new Set([
  "session.create", "session.close", "tab.create", "tab.focus", "tab.close", "observe.screenshot", "observe.domFallback",
  "action.coordinate", "action.domFallback", "navigate", "input.text", "input.key", "frames.subscribe", "frames.unsubscribe",
]);

export function sanitizeWorkspaceSnapshot(snapshot: BrowserWorkspaceSnapshot, browserdRuntimeInstanceId: string, browserdState: "ready" | "replaced" = "ready"): WorkspaceSnapshot {
  return {
    workspaceRevision: snapshot.workspaceRevision,
    browserdRuntimeInstanceId,
    generatedAt: validTimestamp(snapshot.generatedAt),
    browserdState,
    sessions: snapshot.sessions.slice(0, 256).map((session) => ({
      browserSessionId: session.browserSessionId,
      agentLabel: agentLabel(session.agentSessionId, browserdRuntimeInstanceId),
      actorDisplayId: session.actorDisplayId,
      pathId: "agentcursor/chrome",
      state: session.state,
      controlState: session.controlState,
      controlEpoch: session.controlEpoch,
      controlTransfer: session.controlTransfer,
      ...(session.selectedHumanControlTabId === undefined ? {} : { selectedHumanControlTabId: session.selectedHumanControlTabId }),
      leaseExpiry: session.leaseExpiry,
      captureReadiness: session.captureReadiness,
      resource: session.resource === undefined ? { state: "normal", reason: "none" } : { state: session.resource.state, reason: session.resource.reason },
      personaDisplayId: personaDisplayId(session.personaId, browserdRuntimeInstanceId),
      cursor: session.controlState === "agent" ? {
        x: session.cursor.x,
        y: session.cursor.y,
        visible: session.cursor.visible,
        pathSequence: session.cursor.pathSequence,
        sampleSequence: session.cursor.sampleSequence,
      } : { x: 0, y: 0, visible: false, pathSequence: 0, sampleSequence: 0 },
      tabs: session.tabs.slice(0, 16).map((tab) => ({ ...tab, url: safeText(tab.url, 8192), title: safeText(tab.title, 512) })),
      ...(session.activeOperation !== undefined && OPERATION_KINDS.has(session.activeOperation.kind) ? { activeOperation: { ...session.activeOperation, kind: session.activeOperation.kind as "session.create" } } : {}),
      ...(session.lastActivityAt === undefined ? {} : { lastActivityAt: validTimestamp(session.lastActivityAt) }),
    })),
  };
}

export function unavailableWorkspaceSnapshot(state: "unavailable" | "replaced", revision = 0): WorkspaceSnapshot {
  return { workspaceRevision: revision, generatedAt: new Date().toISOString(), browserdState: state, sessions: [] };
}

export function workspaceFrameHeader(event: WorkspaceFrameEvent, selectionId: string, receivedAtMs = Date.now()): WorkspaceFrameHeader {
  const transitMs = Math.max(0, Math.min(60_000, event.publishedMonotonicMs - event.capturedMonotonicMs));
  return {
    protocolVersion: "workspace.v2",
    kind: "frame",
    selectionId,
    subscriptionId: event.subscriptionId,
    browserdRuntimeInstanceId: event.runtimeInstanceId,
    browserSessionId: event.browserSessionId,
    tabId: event.tabId,
    controlEpoch: event.controlEpoch,
    frameSequence: event.frameSequence,
    documentGeneration: event.documentGeneration,
    viewportGeneration: event.viewportGeneration,
    capturedAt: new Date(receivedAtMs - transitMs).toISOString(),
    publishedAt: new Date(receivedAtMs).toISOString(),
    mediaType: event.mediaType,
    byteLength: event.byteLength,
    sha256: event.sha256,
    imagePixelWidth: event.imagePixelWidth,
    imagePixelHeight: event.imagePixelHeight,
    cssViewportWidth: event.cssViewportWidth,
    cssViewportHeight: event.cssViewportHeight,
    devicePixelRatio: event.devicePixelRatio,
  };
}

function agentLabel(agentSessionId: string, runtimeSalt: string): string {
  return `Pi agent ${displayHandle("agent", agentSessionId, runtimeSalt)}`;
}
function personaDisplayId(personaId: string, runtimeSalt: string): string {
  return `persona-${displayHandle("persona", personaId, runtimeSalt)}`;
}
function displayHandle(kind: "agent" | "persona", value: string, runtimeSalt: string): string {
  return createHmac("sha256", runtimeSalt).update(kind).update("\0").update(value).digest("hex").slice(0, 12);
}
function safeText(value: string, max: number): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const directional = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return control || directional ? "�" : character;
  }).join("").slice(0, max);
}
function validTimestamp(value: string): string { return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString(); }
