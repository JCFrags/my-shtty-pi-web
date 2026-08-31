import { Type, type TSchema } from "typebox";

export const WORKSPACE_PROTOCOL_VERSION = "workspace.v2" as const;
export const MAX_WORKSPACE_HEADER_BYTES = 64 * 1024;
export const MAX_WORKSPACE_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_RECORD_BYTES = 8 + MAX_WORKSPACE_HEADER_BYTES + MAX_WORKSPACE_PAYLOAD_BYTES;
export const MAX_WORKSPACE_INPUT_EVENTS = 32;
export const MAX_WORKSPACE_INPUT_BATCH_BYTES = 64 * 1024;
export const MAX_WORKSPACE_INPUT_TEXT_BYTES = 4 * 1024;

const strict = { additionalProperties: false } as const;
const idPattern = "^[A-Za-z][A-Za-z0-9._:-]{0,127}$";
const opaquePattern = "^[A-Za-z0-9_-]{16,128}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$";
export const WorkspaceIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: idPattern });
export const WorkspaceOpaqueIdSchema = Type.String({ minLength: 16, maxLength: 128, pattern: opaquePattern });
export const WorkspaceTimestampSchema = Type.String({ minLength: 20, maxLength: 24, pattern: timestampPattern });
export const WorkspaceSha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const boundedText = (maxLength: number) => Type.String({ maxLength });
export const WorkspaceCaptureReadinessSchema = Type.Union([Type.Literal("starting"), Type.Literal("warming"), Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("unavailable")]);
export const WorkspaceControlStateSchema = Type.Union([
  Type.Literal("agent"), Type.Literal("takeover-pending"), Type.Literal("human"),
  Type.Literal("human-disconnected"), Type.Literal("return-pending"),
]);
export const WorkspaceControlTransferSchema = Type.Union([
  Type.Literal("none"), Type.Literal("taking-control"), Type.Literal("returning-control"),
]);
export const WorkspaceLeaseExpirySchema = Type.Union([
  Type.Literal("none"), Type.Literal("healthy"), Type.Literal("expiring"), Type.Literal("grace"),
]);

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
  captureReadiness: WorkspaceCaptureReadinessSchema,
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
  controlState: WorkspaceControlStateSchema,
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  controlTransfer: WorkspaceControlTransferSchema,
  selectedHumanControlTabId: Type.Optional(WorkspaceIdSchema),
  leaseExpiry: WorkspaceLeaseExpirySchema,
  captureReadiness: WorkspaceCaptureReadinessSchema,
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

export const WorkspacePaintedFrameBindingSchema = Type.Object({
  selectionId: WorkspaceOpaqueIdSchema,
  browserdRuntimeInstanceId: WorkspaceOpaqueIdSchema,
  browserSessionId: WorkspaceIdSchema,
  tabId: WorkspaceIdSchema,
  subscriptionId: WorkspaceOpaqueIdSchema,
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  imagePixelWidth: Type.Integer({ minimum: 1, maximum: 32_768 }),
  imagePixelHeight: Type.Integer({ minimum: 1, maximum: 32_768 }),
  cssViewportWidth: Type.Number({ exclusiveMinimum: 0, maximum: 32_768 }),
  cssViewportHeight: Type.Number({ exclusiveMinimum: 0, maximum: 32_768 }),
  devicePixelRatio: Type.Number({ exclusiveMinimum: 0, maximum: 16 }),
  paintedAt: WorkspaceTimestampSchema,
}, strict);

const workspaceHumanPoint = Type.Object({
  imageX: Type.Number({ minimum: 0, maximum: 32_768 }),
  imageY: Type.Number({ minimum: 0, maximum: 32_768 }),
}, strict);
const workspaceHumanButton = Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")]);
export const WorkspaceHumanInputEventSchema = Type.Union([
  Type.Object({ kind: Type.Literal("pointerMove"), point: workspaceHumanPoint }, strict),
  Type.Object({ kind: Type.Literal("pointerDown"), point: workspaceHumanPoint, button: workspaceHumanButton, clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })) }, strict),
  Type.Object({ kind: Type.Literal("pointerUp"), point: workspaceHumanPoint, button: workspaceHumanButton, clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })) }, strict),
  Type.Object({ kind: Type.Literal("wheel"), point: workspaceHumanPoint, deltaX: Type.Number({ minimum: -100_000, maximum: 100_000 }), deltaY: Type.Number({ minimum: -100_000, maximum: 100_000 }) }, strict),
  Type.Object({ kind: Type.Literal("keyDown"), key: Type.String({ minLength: 1, maxLength: 64 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), repeat: Type.Optional(Type.Boolean()) }, strict),
  Type.Object({ kind: Type.Literal("keyUp"), key: Type.String({ minLength: 1, maxLength: 64 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, strict),
  Type.Object({ kind: Type.Literal("text"), text: Type.String({ minLength: 1, maxLength: MAX_WORKSPACE_INPUT_TEXT_BYTES }) }, strict),
]);

export const WorkspaceClientCommandSchema = Type.Union([
  command("snapshot.get", {}),
  command("snapshot.subscribe", {}),
  command("frame.select", { browserSessionId: WorkspaceIdSchema, tabId: WorkspaceIdSchema, selectionId: WorkspaceOpaqueIdSchema }),
  command("frame.clear", {}),
  command("control.acquire", {
    browserSessionId: WorkspaceIdSchema,
    tabId: WorkspaceIdSchema,
    expectedControlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    frame: WorkspacePaintedFrameBindingSchema,
  }),
  command("control.heartbeat", {
    browserSessionId: WorkspaceIdSchema,
    controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  command("control.release", {
    browserSessionId: WorkspaceIdSchema,
    controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  command("control.status", { browserSessionId: WorkspaceIdSchema }),
  command("input.batch", {
    browserSessionId: WorkspaceIdSchema,
    tabId: WorkspaceIdSchema,
    controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    inputBatchSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    inputTargetGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    frame: WorkspacePaintedFrameBindingSchema,
    events: Type.Array(WorkspaceHumanInputEventSchema, { minItems: 1, maxItems: MAX_WORKSPACE_INPUT_EVENTS }),
  }),
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
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  capturedAt: WorkspaceTimestampSchema,
  publishedAt: WorkspaceTimestampSchema,
  mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
  byteLength: Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_PAYLOAD_BYTES }),
  sha256: WorkspaceSha256Schema,
  imagePixelWidth: Type.Integer({ minimum: 1, maximum: 32_768 }),
  imagePixelHeight: Type.Integer({ minimum: 1, maximum: 32_768 }),
  cssViewportWidth: Type.Number({ exclusiveMinimum: 0, maximum: 32_768 }),
  cssViewportHeight: Type.Number({ exclusiveMinimum: 0, maximum: 32_768 }),
  devicePixelRatio: Type.Number({ exclusiveMinimum: 0, maximum: 16 }),
}, strict);

export const WorkspaceErrorCodeSchema = Type.Union([
  Type.Literal("INVALID_REQUEST"), Type.Literal("AUTH_FAILED"), Type.Literal("NOT_FOUND"),
  Type.Literal("CONFLICT"), Type.Literal("LIMIT_EXCEEDED"), Type.Literal("UNAVAILABLE"),
  Type.Literal("INTERNAL_ERROR"), Type.Literal("CONTROL_NOT_READY"),
  Type.Literal("CONTROL_TRANSFER_PENDING"), Type.Literal("CONTROL_HELD_BY_HUMAN"),
  Type.Literal("CONTROL_LEASE_REQUIRED"), Type.Literal("CONTROL_LEASE_EXPIRED"),
  Type.Literal("CONTROL_LEASE_CONFLICT"), Type.Literal("INPUT_SEQUENCE_STALE"),
  Type.Literal("INPUT_FRAME_STALE"), Type.Literal("INPUT_RATE_LIMITED"),
  Type.Literal("INPUT_UNSUPPORTED"),
]);
const workspaceError = Type.Object({
  code: WorkspaceErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 256 }),
  retryable: Type.Boolean(),
}, strict);

export const WorkspaceControlStatusResultSchema = Type.Object({
  kind: Type.Literal("controlStatus"),
  browserSessionId: WorkspaceIdSchema,
  controlState: WorkspaceControlStateSchema,
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  controlTransfer: WorkspaceControlTransferSchema,
  selectedHumanControlTabId: Type.Optional(WorkspaceIdSchema),
  captureReadiness: WorkspaceCaptureReadinessSchema,
  leaseExpiry: WorkspaceLeaseExpirySchema,
}, strict);
export const WorkspaceControlAcquiredResultSchema = Type.Object({
  kind: Type.Literal("controlAcquired"),
  browserSessionId: WorkspaceIdSchema,
  selectedHumanControlTabId: WorkspaceIdSchema,
  controlState: Type.Literal("human"),
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  controlTransfer: Type.Literal("none"),
  captureReadiness: Type.Literal("ready"),
  leaseExpiry: Type.Literal("healthy"),
  leaseExpiresInMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
  inputTargetGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);
export const WorkspaceControlHeartbeatResultSchema = Type.Object({
  kind: Type.Literal("controlHeartbeat"),
  browserSessionId: WorkspaceIdSchema,
  selectedHumanControlTabId: WorkspaceIdSchema,
  controlState: Type.Literal("human"),
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  leaseExpiry: Type.Union([Type.Literal("healthy"), Type.Literal("expiring")]),
  leaseExpiresInMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
}, strict);
export const WorkspaceControlReleasedResultSchema = Type.Object({
  kind: Type.Literal("controlReleased"),
  browserSessionId: WorkspaceIdSchema,
  controlState: Type.Literal("agent"),
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  controlTransfer: Type.Literal("none"),
  leaseExpiry: Type.Literal("none"),
}, strict);
export const WorkspaceInputAckSchema = Type.Object({
  kind: Type.Literal("inputAck"),
  inputBatchSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  acceptedEventCount: Type.Integer({ minimum: 0, maximum: MAX_WORKSPACE_INPUT_EVENTS }),
  coalescedPointerMoveCount: Type.Integer({ minimum: 0, maximum: MAX_WORKSPACE_INPUT_EVENTS }),
  awaitingNewFrame: Type.Boolean(),
}, strict);

export const WorkspaceServerHeaderSchema = Type.Union([
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("bound"), requestId: WorkspaceIdSchema, webxdRuntimeInstanceId: WorkspaceOpaqueIdSchema }, strict),
  Type.Object({ protocolVersion: Type.Literal(WORKSPACE_PROTOCOL_VERSION), kind: Type.Literal("response"), requestId: WorkspaceIdSchema, ok: Type.Literal(true), result: Type.Union([
    Type.Object({ kind: Type.Literal("ack") }, strict),
    Type.Object({ kind: Type.Literal("pong"), generatedAt: WorkspaceTimestampSchema }, strict),
    Type.Object({ kind: Type.Literal("selection"), selectionId: WorkspaceOpaqueIdSchema, browserSessionId: WorkspaceIdSchema, tabId: WorkspaceIdSchema }, strict),
    Type.Object({ kind: Type.Literal("snapshot"), snapshot: WorkspaceSnapshotSchema }, strict),
    WorkspaceControlStatusResultSchema,
    WorkspaceControlAcquiredResultSchema,
    WorkspaceControlHeartbeatResultSchema,
    WorkspaceControlReleasedResultSchema,
    WorkspaceInputAckSchema,
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
