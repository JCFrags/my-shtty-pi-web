import { WORKSPACE_PROTOCOL_VERSION } from "./schema.js";

export const validWorkspaceBindFixture = {
  protocolVersion: WORKSPACE_PROTOCOL_VERSION,
  kind: "bind",
  requestId: "request:bind:workspace",
  bindingSecret: "w".repeat(43),
} as const;

export const validWorkspaceSnapshotFixture = {
  workspaceRevision: 7,
  browserdRuntimeInstanceId: "runtime_workspace_0001",
  generatedAt: "2026-08-30T12:00:00.000Z",
  browserdState: "ready",
  sessions: [{
    browserSessionId: "session:workspace:1",
    agentLabel: "agent-7e21c0",
    actorDisplayId: "actor_display_0001",
    pathId: "agentcursor/chrome",
    state: "ready",
    controlState: "agent",
    controlEpoch: 4,
    captureReadiness: "ready",
    personaDisplayId: "persona-01",
    cursor: { x: 24, y: 32, visible: true, pathSequence: 3, sampleSequence: 9 },
    tabs: [{ tabId: "tab:workspace:1", url: "http://fixture.invalid/agent-a", title: "Agent A", state: "ready", captureReadiness: "ready", documentGeneration: 1, viewportGeneration: 1, frameSequence: 4 }],
    lastActivityAt: "2026-08-30T12:00:00.000Z",
  }],
} as const;

export const validWorkspaceFrameHeaderFixture = {
  protocolVersion: WORKSPACE_PROTOCOL_VERSION,
  kind: "frame",
  selectionId: "selection_000001",
  subscriptionId: "subscription_0001",
  browserdRuntimeInstanceId: "runtime_workspace_0001",
  browserSessionId: "session:workspace:1",
  tabId: "tab:workspace:1",
  controlEpoch: 4,
  frameSequence: 4,
  documentGeneration: 1,
  viewportGeneration: 1,
  capturedAt: "2026-08-30T12:00:00.000Z",
  publishedAt: "2026-08-30T12:00:00.010Z",
  mediaType: "image/png",
  byteLength: 4,
  sha256: "a".repeat(64),
  width: 2,
  height: 2,
} as const;

export const invalidWorkspaceFixtures: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "bind extra field", value: { ...validWorkspaceBindFixture, actor: { principalId: "owner" } } },
  { name: "arbitrary command", value: { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "workspace.input", requestId: "request:input" } },
  { name: "arbitrary path", value: { protocolVersion: WORKSPACE_PROTOCOL_VERSION, kind: "frame.select", requestId: "request:select", selectionId: "selection_000001", browserSessionId: "session:1", tabId: "tab:1", socketPath: "/tmp/unsafe" } },
  { name: "unbounded title", value: { ...validWorkspaceSnapshotFixture, sessions: [{ ...validWorkspaceSnapshotFixture.sessions[0], tabs: [{ ...validWorkspaceSnapshotFixture.sessions[0].tabs[0], title: "x".repeat(513) }] }] } },
];
