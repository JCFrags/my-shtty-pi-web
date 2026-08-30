import { Type, type TSchema } from "typebox";

export const WORKSPACE_PROTOCOL_VERSION = "workspace.v1" as const;
export const MAX_WORKSPACE_HEADER_BYTES = 64 * 1024;
export const MAX_WORKSPACE_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_RECORD_BYTES = 8 + MAX_WORKSPACE_HEADER_BYTES + MAX_WORKSPACE_PAYLOAD_BYTES;

const strict = { additionalProperties: false } as const;
const idPattern = "^[A-Za-z][A-Za-z0-9._:-]{0,127}$";
const opaquePattern = "^[A-Za-z0-9_-]{16,128}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$";
export const WorkspaceIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: idPattern });
export const WorkspaceOpaqueIdSchema = Type.String({ minLength: 16, maxLength: 128, pattern: opaquePattern });
export const WorkspaceTimestampSchema = Type.String({ minLength: 20, maxLength: 24, pattern: timestampPattern });
export const WorkspaceSha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const boundedText = (maxLength: number) => Type.String({ maxLength });

const cursor = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 100_000 }),
  y: Type.Number({ minimum: 0, maximum: 100_000 }),
  visible: Type.Boolean(),
  pathSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  sampleSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

const operation = Type.Object({
  operationId: WorkspaceIdSchema,
  kind: Type.Union([
    Type.Literal("session.create"), Type.Literal("session.close"), Type.Literal("tab.create"),
    Type.Literal("tab.focus"), Type.Literal("tab.close"), Type.Literal("observe.screenshot"),
    Type.Literal("observe.domFallback"), Type.Literal("action.coordinate"), Type.Literal("action.domFallback"),
    Type.Literal("navigate"), Type.Literal("input.text"), Type.Literal("input.key"), Type.Literal("frames.subscribe"),
    Type.Literal("frames.unsubscribe"),
  ]),
  state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("cancelling"), Type.Literal("terminal")]),
  dispatchState: Type.Union([Type.Literal("not-dispatched"), Type.Literal("partially-dispatched"), Type.Literal("dispatched")]),
  startedAt: Type.Optional(WorkspaceTimestampSchema),
  cancellable: Type.Boolean(),
}, strict);

export const WorkspaceTabSchema = Type.Object({
  tabId: WorkspaceIdSchema,
  url: boundedText(8192),
  title: boundedText(512),
  state: Type.Union([Type.Literal("attaching"), Type.Literal("ready"), Type.Literal("crashed"), Type.Literal("closed")]),
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

export const WorkspaceSessionSchema = Type.Object({
  browserSessionId: WorkspaceIdSchema,
  agentLabel: boundedText(96),
  actorDisplayId: WorkspaceOpaqueIdSchema,
  pathId: Type.Literal("agentcursor/chrome"),
  state: Type.Union([Type.Literal("starting"), Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("closed")]),
  controlState: Type.Literal("agent"),
  personaDisplayId: Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" }),
  cursor,
  tabs: Type.Array(WorkspaceTabSchema, { maxItems: 16 }),
  activeOperation: Type.Optional(operation),
  lastActivityAt: Type.Optional(WorkspaceTimestampSchema),
}, strict);

export const WorkspaceSnapshotSchema = Type.Object({
  workspaceRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  browserdRuntimeInstanceId: Type.Optional(WorkspaceOpaqueIdSchema),
  generatedAt: WorkspaceTimestampSchema,
  browserdState: Type.Union([Type.Literal("ready"), Type.Literal("unavailable"), Type.Literal("replaced")]),
  sessions: Type.Array(WorkspaceSessionSchema, { maxItems: 256 }),
}, strict);

const requestBase = {
  protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION),
  requestId: WorkspaceIdSchema,
};
function command<K extends string, P extends Record<string, TSchema>>(kind: K, payload: P) {
  return Type.Object({ ...requestBase, kind: Type.Literal(kind), ...payload }, strict);
}

export const WorkspaceBindSchema = Type.Object({
  ...requestBase,
  kind: Type.Literal("bind"),
  bindingSecret: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$" }),
}, strict);

export const WorkspaceClientCommandSchema = Type.Union([
  command("snapshot.get", {}),
  command("snapshot.subscribe", {}),
  command("frame.select", { browserSessionId: WorkspaceIdSchema, tabId: WorkspaceIdSchema, selectionId: WorkspaceOpaqueIdSchema }),
  command("frame.clear", {}),
  command("ping", {}),
  command("close", {}),
]);

export const WorkspaceStatusSchema = Type.Object({
  connection: Type.Union([Type.Literal("connecting"), Type.Literal("ready"), Type.Literal("reconnecting"), Type.Literal("unavailable"), Type.Literal("closed")]),
  browserd: Type.Union([Type.Literal("ready"), Type.Literal("unavailable"), Type.Literal("replaced")]),
  message: Type.Optional(boundedText(256)),
}, strict);

export const WorkspaceFrameHeaderSchema = Type.Object({
  protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION),
  kind: Type.Literal("frame"),
  selectionId: WorkspaceOpaqueIdSchema,
  subscriptionId: WorkspaceOpaqueIdSchema,
  browserdRuntimeInstanceId: WorkspaceOpaqueIdSchema,
  browserSessionId: WorkspaceIdSchema,
  tabId: WorkspaceIdSchema,
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  capturedAt: WorkspaceTimestampSchema,
  publishedAt: WorkspaceTimestampSchema,
  mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
  byteLength: Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_PAYLOAD_BYTES }),
  sha256: WorkspaceSha256Schema,
  width: Type.Integer({ minimum: 1, maximum: 32_768 }),
  height: Type.Integer({ minimum: 1, maximum: 32_768 }),
}, strict);

const workspaceError = Type.Object({
  code: Type.Union([Type.Literal("INVALID_REQUEST"), Type.Literal("AUTH_FAILED"), Type.Literal("NOT_FOUND"), Type.Literal("CONFLICT"), Type.Literal("LIMIT_EXCEEDED"), Type.Literal("UNAVAILABLE"), Type.Literal("INTERNAL_ERROR")]),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  retryable: Type.Boolean(),
}, strict);

export const WorkspaceServerHeaderSchema = Type.Union([
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("bound"), requestId: WorkspaceIdSchema, webxdRuntimeInstanceId: WorkspaceOpaqueIdSchema }, strict),
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("response"), requestId: WorkspaceIdSchema, ok: Type.Literal(true), result: Type.Union([
    Type.Object({ kind: Type.Literal("ack") }, strict),
    Type.Object({ kind: Type.Literal("pong"), generatedAt: WorkspaceTimestampSchema }, strict),
    Type.Object({ kind: Type.Literal("selection"), selectionId: WorkspaceOpaqueIdSchema, browserSessionId: WorkspaceIdSchema, tabId: WorkspaceIdSchema }, strict),
    Type.Object({ kind: Type.Literal("snapshot"), snapshot: WorkspaceSnapshotSchema }, strict),
  ]) }, strict),
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("response"), requestId: WorkspaceIdSchema, ok: Type.Literal(false), error: workspaceError }, strict),
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("snapshot"), snapshot: WorkspaceSnapshotSchema }, strict),
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("status"), status: WorkspaceStatusSchema }, strict),
  WorkspaceFrameHeaderSchema,
]);

export const WorkspaceProtocolSchemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://pi-web.local/schema/workspace-protocol.schema.json",
  title: "Pi Web private workspace protocol",
  anyOf: [WorkspaceBindSchema, WorkspaceClientCommandSchema, WorkspaceServerHeaderSchema],
} as const;
