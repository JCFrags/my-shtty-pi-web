import { Type, type TSchema } from "typebox";

export const PROTOCOL_VERSION = "browser.v2" as const;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_DEADLINE_FUTURE_MS = 5 * 60_000;

const strict = { additionalProperties: false } as const;
const idPattern = "^[A-Za-z][A-Za-z0-9._:-]{0,127}$";
const opaquePattern = "^[A-Za-z0-9_-]{16,128}$";
const deadlinePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$";
const httpUrlPattern = "^https?://[^\\s]{1,8184}$";

export const IdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: idPattern });
export const OpaqueIdSchema = Type.String({ minLength: 16, maxLength: 128, pattern: opaquePattern });
export const DeadlineSchema = Type.String({ minLength: 20, maxLength: 24, pattern: deadlinePattern });
export const HttpUrlSchema = Type.String({ minLength: 8, maxLength: 8192, pattern: httpUrlPattern });
export const PageUrlSchema = Type.String({ minLength: 8, maxLength: 8192, pattern: "^(?:https?://[^\\s]{1,8184}|about:blank|chrome-error://[^\\s]{1,8176})$" });
export const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
export const TimestampSchema = Type.String({ minLength: 20, maxLength: 24, pattern: deadlinePattern });
export const FiniteCoordinateSchema = Type.Number({ minimum: 0, maximum: 100_000 });

export const ActorIdentitySchema = Type.Object({
  principalId: IdSchema,
  agentSessionId: IdSchema,
}, strict);

export const TabAddressSchema = Type.Object({
  browserSessionId: IdSchema,
  tabId: IdSchema,
  targetId: OpaqueIdSchema,
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

export const GenerationSchema = Type.Object({
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

const point = Type.Object({ x: FiniteCoordinateSchema, y: FiniteCoordinateSchema }, strict);
const viewport = Type.Object({
  width: Type.Integer({ minimum: 1, maximum: 16_384 }),
  height: Type.Integer({ minimum: 1, maximum: 16_384 }),
  devicePixelRatio: Type.Number({ exclusiveMinimum: 0, maximum: 16 }),
}, strict);
const scroll = Type.Object({
  x: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
  y: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
}, strict);
const cursor = Type.Object({
  x: FiniteCoordinateSchema,
  y: FiniteCoordinateSchema,
  pathSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  sampleSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  personaId: OpaqueIdSchema,
  visible: Type.Boolean(),
}, strict);

const NavigationAuthorizationSchema = Type.String({ minLength: 64, maxLength: 4096, pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$" });
const CoordinateSpaceSchema = Type.Union([Type.Literal("imagePixels"), Type.Literal("cssViewport")]);

const coordinateAction = Type.Union([
  Type.Object({ kind: Type.Literal("move"), to: point }, strict),
  Type.Object({ kind: Type.Literal("hover"), to: point }, strict),
  Type.Object({ kind: Type.Literal("click"), at: point, button: Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")]) }, strict),
  Type.Object({ kind: Type.Literal("doubleClick"), at: point, button: Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")]) }, strict),
  Type.Object({ kind: Type.Literal("drag"), from: point, to: point }, strict),
  Type.Object({ kind: Type.Literal("wheel"), at: point, deltaX: Type.Number({ minimum: -100_000, maximum: 100_000 }), deltaY: Type.Number({ minimum: -100_000, maximum: 100_000 }) }, strict),
]);

const fallbackAction = Type.Union([
  Type.Object({ kind: Type.Literal("click"), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])) }, strict),
  Type.Object({ kind: Type.Literal("doubleClick"), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])) }, strict),
  Type.Object({ kind: Type.Literal("hover") }, strict),
  Type.Object({ kind: Type.Literal("type"), text: Type.String({ maxLength: 65_536 }), replace: Type.Optional(Type.Boolean()) }, strict),
  Type.Object({ kind: Type.Literal("press"), key: Type.String({ minLength: 1, maxLength: 64 }) }, strict),
]);

const requestBase = {
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  requestId: IdSchema,
  operationId: IdSchema,
  deadline: DeadlineSchema,
};

function request<K extends string, P extends Record<string, TSchema>>(kind: K, payload: P) {
  return Type.Object({ ...requestBase, kind: Type.Literal(kind), ...payload }, strict);
}

export const BindRequestSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("bind"),
  requestId: IdSchema,
  bindingSecret: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$" }),
  actor: ActorIdentitySchema,
}, strict);

export const WorkspaceBrokerBindRequestSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("workspace.bind"),
  requestId: IdSchema,
  workspaceBrokerSecret: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$" }),
}, strict);

export const BrowserRequestSchema = Type.Union([
  request("capabilities.get", {}),
  request("session.create", { initialUrl: Type.Optional(HttpUrlSchema), navigationAuthorization: Type.Optional(NavigationAuthorizationSchema) }),
  request("session.list", {}),
  request("session.close", { browserSessionId: IdSchema, controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  request("tab.create", { browserSessionId: IdSchema, controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), url: Type.Optional(HttpUrlSchema), navigationAuthorization: Type.Optional(NavigationAuthorizationSchema) }),
  request("tab.list", { browserSessionId: IdSchema, controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  request("tab.focus", { address: TabAddressSchema }),
  request("tab.close", { address: TabAddressSchema }),
  request("observe.screenshot", { address: TabAddressSchema, delivery: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("inline"), Type.Literal("artifact")])) }),
  request("observe.domFallback", { address: TabAddressSchema, maxNodes: Type.Integer({ minimum: 1, maximum: 200 }) }),
  request("action.coordinate", { address: TabAddressSchema, observationId: OpaqueIdSchema, coordinateSpace: Type.Optional(CoordinateSpaceSchema), action: coordinateAction, riskPolicy: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("newer-observation"), Type.Literal("local-region")])) }),
  request("action.domFallback", { address: TabAddressSchema, domObservationId: OpaqueIdSchema, handle: OpaqueIdSchema, action: fallbackAction }),
  request("navigate", { address: TabAddressSchema, url: HttpUrlSchema, navigationAuthorization: NavigationAuthorizationSchema, waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domContentLoaded")])) }),
  request("input.text", { address: TabAddressSchema, text: Type.String({ maxLength: 65_536 }), replace: Type.Optional(Type.Boolean()) }),
  request("input.key", { address: TabAddressSchema, key: Type.String({ minLength: 1, maxLength: 64 }) }),
  request("operation.status", { targetOperationId: IdSchema }),
  request("operation.cancel", { targetOperationId: IdSchema }),
  request("artifact.read", { artifactId: OpaqueIdSchema, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 * 1024 * 1024 })), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })) }),
  request("frames.subscribe", { address: TabAddressSchema, subscriptionId: OpaqueIdSchema, interest: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("selected")])) }),
  request("frames.unsubscribe", { address: TabAddressSchema, subscriptionId: OpaqueIdSchema }),
]);

export const WorkspaceBrokerRequestSchema = Type.Union([
  request("workspace.snapshot.get", {}),
  request("workspace.events.subscribe", {}),
  request("workspace.events.unsubscribe", {}),
  request("workspace.frames.subscribe", { browserSessionId: IdSchema, tabId: IdSchema, subscriptionId: OpaqueIdSchema, interest: Type.Union([Type.Literal("idle"), Type.Literal("selected")]) }),
  request("workspace.frames.unsubscribe", { browserSessionId: IdSchema, tabId: IdSchema, subscriptionId: OpaqueIdSchema }),
  request("workspace.frame.read", { browserSessionId: IdSchema, tabId: IdSchema, subscriptionId: OpaqueIdSchema, frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), artifactId: OpaqueIdSchema, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 })), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })) }),
  request("workspace.ping", {}),
]);

export const DispatchStateSchema = Type.Union([
  Type.Literal("not-dispatched"),
  Type.Literal("partially-dispatched"),
  Type.Literal("dispatched"),
]);
export const OperationStateSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("committed"),
  Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("expired"),
]);

export const ErrorCodeSchema = Type.Union([
  Type.Literal("INVALID_REQUEST"), Type.Literal("PROTOCOL_MISMATCH"), Type.Literal("AUTH_FAILED"),
  Type.Literal("ALREADY_BOUND"), Type.Literal("DEADLINE_EXCEEDED"), Type.Literal("OWNER_MISMATCH"),
  Type.Literal("SESSION_NOT_FOUND"), Type.Literal("TAB_NOT_FOUND"), Type.Literal("TARGET_MISMATCH"),
  Type.Literal("CONTROL_EPOCH_STALE"), Type.Literal("OBSERVATION_NOT_FOUND"), Type.Literal("OBSERVATION_STALE"),
  Type.Literal("DOCUMENT_CHANGED"), Type.Literal("VIEWPORT_CHANGED"), Type.Literal("COORDINATE_OUT_OF_BOUNDS"),
  Type.Literal("HANDLE_STALE"), Type.Literal("OPERATION_CONFLICT"), Type.Literal("OPERATION_CANCELLED"),
  Type.Literal("BROWSER_START_FAILED"), Type.Literal("BROWSER_EXITED"), Type.Literal("CDP_DISCONNECTED"),
  Type.Literal("TARGET_CRASHED"), Type.Literal("CDP_ERROR"), Type.Literal("ARTIFACT_FORBIDDEN"),
  Type.Literal("OPERATION_NOT_FOUND"), Type.Literal("ARTIFACT_NOT_FOUND"), Type.Literal("INTERNAL_ERROR"),
  Type.Literal("CAPABILITY_UNAVAILABLE"), Type.Literal("NAVIGATION_DENIED"), Type.Literal("LIMIT_EXCEEDED"),
]);

export const ProtocolErrorSchema = Type.Object({
  code: ErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 512 }),
  retryable: Type.Boolean(),
  details: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" }), Type.Union([Type.String({ maxLength: 256 }), Type.Number({ minimum: -1_000_000_000, maximum: 1_000_000_000 }), Type.Boolean()]), { maxProperties: 16 })),
}, strict);

export const OperationStatusSchema = Type.Object({
  kind: Type.Literal("operation"),
  operationId: IdSchema,
  state: OperationStateSchema,
  dispatchState: DispatchStateSchema,
  queuedAt: TimestampSchema,
  startedAt: Type.Optional(TimestampSchema),
  finishedAt: Type.Optional(TimestampSchema),
  error: Type.Optional(ProtocolErrorSchema),
}, strict);

export const TabDescriptorSchema = Type.Object({
  kind: Type.Literal("tab"),
  address: TabAddressSchema,
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  state: Type.Union([Type.Literal("attaching"), Type.Literal("ready"), Type.Literal("crashed"), Type.Literal("closed")]),
  url: PageUrlSchema,
  title: Type.String({ maxLength: 4096 }),
  frameSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

export const SessionDescriptorSchema = Type.Object({
  kind: Type.Literal("session"),
  browserSessionId: IdSchema,
  controlEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  state: Type.Union([Type.Literal("starting"), Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("closed")]),
  personaId: OpaqueIdSchema,
  cursor: cursor,
  tabs: Type.Array(TabDescriptorSchema, { maxItems: 16 }),
}, strict);

export const WorkspaceOperationSummarySchema = Type.Object({
  operationId: IdSchema,
  kind: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-zA-Z.]+$" }),
  state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("cancelling"), Type.Literal("terminal")]),
  dispatchState: DispatchStateSchema,
  startedAt: Type.Optional(TimestampSchema),
  cancellable: Type.Boolean(),
}, strict);

export const WorkspaceSessionSnapshotSchema = Type.Object({
  browserSessionId: IdSchema,
  agentSessionId: IdSchema,
  actorDisplayId: OpaqueIdSchema,
  pathId: Type.Literal("agentcursor/chrome"),
  state: Type.Union([Type.Literal("starting"), Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("closed")]),
  controlState: Type.Literal("agent"),
  personaId: OpaqueIdSchema,
  cursor,
  tabs: Type.Array(Type.Object({
    tabId: IdSchema,
    url: PageUrlSchema,
    title: Type.String({ maxLength: 512 }),
    state: Type.Union([Type.Literal("attaching"), Type.Literal("ready"), Type.Literal("crashed"), Type.Literal("closed")]),
    documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    frameSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, strict), { maxItems: 16 }),
  activeOperation: Type.Optional(WorkspaceOperationSummarySchema),
  lastActivityAt: Type.Optional(TimestampSchema),
}, strict);

export const WorkspaceSnapshotSchema = Type.Object({
  kind: Type.Literal("workspaceSnapshot"),
  workspaceRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  generatedAt: TimestampSchema,
  sessions: Type.Array(WorkspaceSessionSnapshotSchema, { maxItems: 256 }),
}, strict);

export const WorkspaceStateEventSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("workspace.state.changed"),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  eventKind: Type.Union([Type.Literal("session"), Type.Literal("tab"), Type.Literal("operation"), Type.Literal("control"), Type.Literal("runtime")]),
  browserSessionId: Type.Optional(IdSchema),
  tabId: Type.Optional(IdSchema),
}, strict);

export const WorkspaceFrameEventSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("workspace.frame.available"),
  runtimeInstanceId: OpaqueIdSchema,
  subscriptionId: OpaqueIdSchema,
  browserSessionId: IdSchema,
  tabId: IdSchema,
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  capturedMonotonicMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  publishedMonotonicMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
  byteLength: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }),
  artifactId: OpaqueIdSchema,
  sha256: Sha256Schema,
  width: Type.Integer({ minimum: 1, maximum: 32_768 }),
  height: Type.Integer({ minimum: 1, maximum: 32_768 }),
}, strict);

const imageDelivery = Type.Union([
  Type.Object({ kind: Type.Literal("inline"), base64: Type.String({ maxLength: 1_500_000 }) }, strict),
  Type.Object({ kind: Type.Literal("artifact"), artifactId: OpaqueIdSchema }, strict),
]);

export const ScreenshotObservationSchema = Type.Object({
  kind: Type.Literal("screenshotObservation"),
  observationId: OpaqueIdSchema,
  address: TabAddressSchema,
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  url: PageUrlSchema,
  title: Type.String({ maxLength: 4096 }),
  capturedAt: TimestampSchema,
  capturedMonotonicMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  validUntil: TimestampSchema,
  viewport,
  scroll,
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
  byteLength: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }),
  imagePixelWidth: Type.Integer({ minimum: 1, maximum: 32_768 }),
  imagePixelHeight: Type.Integer({ minimum: 1, maximum: 32_768 }),
  captureScale: Type.Number({ exclusiveMinimum: 0, maximum: 16 }),
  sha256: Sha256Schema,
  cursor,
  image: imageDelivery,
}, strict);

const domNode = Type.Object({
  handle: OpaqueIdSchema,
  role: Type.String({ minLength: 1, maxLength: 128 }),
  name: Type.String({ maxLength: 4096 }),
  value: Type.Optional(Type.String({ maxLength: 8192 })),
  state: Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" }), Type.Union([Type.String({ maxLength: 256 }), Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }), Type.Boolean()]), { maxProperties: 16 }),
  bounds: Type.Optional(Type.Object({ x: Type.Number({ minimum: -100_000, maximum: 100_000 }), y: Type.Number({ minimum: -100_000, maximum: 100_000 }), width: Type.Number({ minimum: 0, maximum: 100_000 }), height: Type.Number({ minimum: 0, maximum: 100_000 }) }, strict)),
  locatorDescription: Type.String({ maxLength: 1024 }),
}, strict);

export const DomObservationSchema = Type.Object({
  kind: Type.Literal("domObservation"),
  observationId: OpaqueIdSchema,
  address: TabAddressSchema,
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  observedAt: TimestampSchema,
  validUntil: TimestampSchema,
  truncated: Type.Boolean(),
  nodes: Type.Array(domNode, { maxItems: 200 }),
}, strict);

export const FrameEventSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("frame.available"),
  address: TabAddressSchema,
  documentGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  viewportGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  capturedMonotonicMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  publishedMonotonicMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  mediaType: Type.Literal("image/png"),
  byteLength: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
  artifactId: OpaqueIdSchema,
  sha256: Sha256Schema,
  viewport,
  url: PageUrlSchema,
  title: Type.String({ maxLength: 4096 }),
  cursor,
}, strict);

const capabilityResult = Type.Object({
  kind: Type.Literal("capabilities"),
  available: Type.Boolean(),
  headed: Type.Boolean(),
  screenshotFirst: Type.Literal(true),
  domFallback: Type.Literal(true),
  virtualMouse: Type.Literal(true),
  osMouse: Type.Literal(false),
  executableAvailable: Type.Boolean(),
  displayAvailable: Type.Boolean(),
  profileRootUsable: Type.Boolean(),
  egressConfigured: Type.Boolean(),
  egressBindingId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  runtimeState: Type.Union([Type.Literal("open"), Type.Literal("closing"), Type.Literal("cleanup-failed")]),
  sessionCapacity: Type.Object({ current: Type.Integer({ minimum: 0, maximum: 256 }), limit: Type.Integer({ minimum: 1, maximum: 256 }), available: Type.Integer({ minimum: 0, maximum: 256 }) }, strict),
}, strict);
const sessionsResult = Type.Object({ kind: Type.Literal("sessions"), sessions: Type.Array(SessionDescriptorSchema, { maxItems: 32 }) }, strict);
const tabsResult = Type.Object({ kind: Type.Literal("tabs"), tabs: Type.Array(TabDescriptorSchema, { maxItems: 16 }) }, strict);
const artifactResult = Type.Object({ kind: Type.Literal("artifact"), artifactId: OpaqueIdSchema, mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]), byteLength: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }), sha256: Sha256Schema, offset: Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }), totalBytes: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }), eof: Type.Boolean(), base64: Type.String({ maxLength: 1_500_000 }) }, strict);
const ackResult = Type.Object({ kind: Type.Literal("ack"), operationId: IdSchema }, strict);
const subscriptionResult = Type.Object({ kind: Type.Literal("subscription"), operationId: IdSchema, subscriptionId: OpaqueIdSchema, subscribed: Type.Boolean() }, strict);
const workspaceSubscriptionResult = Type.Object({ kind: Type.Literal("workspaceSubscription"), operationId: IdSchema, subscriptionId: OpaqueIdSchema, subscribed: Type.Boolean() }, strict);
const workspaceArtifactResult = Type.Object({ kind: Type.Literal("workspaceFrameArtifact"), artifactId: OpaqueIdSchema, browserSessionId: IdSchema, tabId: IdSchema, subscriptionId: OpaqueIdSchema, frameSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]), byteLength: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }), sha256: Sha256Schema, offset: Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }), totalBytes: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }), eof: Type.Boolean(), base64: Type.String({ maxLength: 1_500_000 }) }, strict);
const workspacePongResult = Type.Object({ kind: Type.Literal("workspacePong"), generatedAt: TimestampSchema }, strict);

export const ResultSchema = Type.Union([capabilityResult, SessionDescriptorSchema, sessionsResult, TabDescriptorSchema, tabsResult, ScreenshotObservationSchema, DomObservationSchema, OperationStatusSchema, artifactResult, ackResult, subscriptionResult]);
export const WorkspaceResultSchema = Type.Union([WorkspaceSnapshotSchema, workspaceSubscriptionResult, workspaceArtifactResult, workspacePongResult]);

export const BindResponseSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("bound"),
  requestId: IdSchema,
  actor: ActorIdentitySchema,
}, strict);

export const SuccessResponseSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("response"),
  requestId: IdSchema,
  operationId: IdSchema,
  ok: Type.Literal(true),
  result: ResultSchema,
}, strict);

export const ErrorResponseSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("response"),
  requestId: IdSchema,
  operationId: Type.Optional(IdSchema),
  ok: Type.Literal(false),
  error: ProtocolErrorSchema,
}, strict);

export const WorkspaceBoundResponseSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("workspace.bound"),
  requestId: IdSchema,
  runtimeInstanceId: OpaqueIdSchema,
}, strict);

export const WorkspaceSuccessResponseSchema = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal("response"),
  requestId: IdSchema,
  operationId: IdSchema,
  ok: Type.Literal(true),
  result: WorkspaceResultSchema,
}, strict);

export const ServerMessageSchema = Type.Union([BindResponseSchema, SuccessResponseSchema, WorkspaceBoundResponseSchema, WorkspaceSuccessResponseSchema, ErrorResponseSchema, FrameEventSchema, WorkspaceStateEventSchema, WorkspaceFrameEventSchema]);

export const ProtocolSchemaDocument = Type.Union(
  [BindRequestSchema, WorkspaceBrokerBindRequestSchema, BrowserRequestSchema, WorkspaceBrokerRequestSchema, ServerMessageSchema],
  { $id: "https://webx.local/schema/browser.v2" },
);
