# Internal browser protocol draft

Status: Phase 0 draft. This is not the current public SDK contract.

## Envelope and identity

All requests use a private same-user transport. Every operation on an existing tab, including reads, carries the full browser address. Pre-creation and list requests carry the most specific owner and browser-session scope that exists. The authority never fills a missing target from focus or recent state.

```ts
type BrowserAddress = {
  ownerId: string;             // authenticated Pi agent owner
  agentSessionId: string;      // Pi lifecycle session
  browserSessionId: string;    // isolated Chrome host/session
  tabId: string;               // stable authority ID
  targetId: string;            // current CDP target ID
  controlEpoch: number;        // increases at takeover/return/recovery
};

type BaseRequest<T> = {
  protocolVersion: "browser.v1";
  requestId: string;
  operationId: string;
  deadline: string;            // absolute RFC 3339 UTC time
  body: T;
};

type ScopedRequest<T> = BaseRequest<T> & {
  ownerId: string;
  agentSessionId: string;
};

type BrowserSessionAddress = {
  ownerId: string;
  agentSessionId: string;
  browserSessionId: string;
  controlEpoch: number;
};

type BrowserSessionEnvelope<T> = BaseRequest<T> & {
  address: BrowserSessionAddress;
};

type RequestEnvelope<T> = BaseRequest<T> & {
  address: BrowserAddress;
};

type Generation = {
  documentGeneration: number;  // increases on top-document replacement
  viewportGeneration: number;  // increases on CSS viewport or DPR change
};
```

Host-level and session-create requests omit only IDs that do not exist yet. They still carry authenticated `ownerId`, `agentSessionId`, `requestId`, `operationId`, and `deadline`. Browser-session requests also carry `browserSessionId` and `controlEpoch`. Any operation on an existing tab carries the full address.

## Capabilities

Request:

```json
{"protocolVersion":"browser.v1","requestId":"req-cap-1","operationId":"op-cap-1","deadline":"2026-08-29T01:01:00.000Z","ownerId":"owner-1","agentSessionId":"pi-1","body":{"type":"capabilities.get"}}
```

Response:

```json
{
  "type":"capabilities",
  "protocolVersion":"browser.v1",
  "browser":{"available":true,"headed":true,"screenshotFirst":true,"domFallback":true},
  "executables":[{"path":"/usr/bin/chromium-browser","product":"Fedora Chromium","version":"151.0.7922.173"}],
  "input":{"virtualMouse":true,"osMouse":false,"move":true,"click":true,"doubleClick":true,"drag":true,"wheel":true,"hover":true,"text":true,"key":true},
  "screenshot":{"mediaTypes":["image/png"],"maxInlineBytes":1048576,"maxFps":2},
  "limits":{"sessionsPerOwner":4,"tabsPerSession":8,"operationsPerTab":1},
  "workspace":{"available":true,"takeover":true}
}
```

## Host lifecycle

```ts
type HostStart = ScopedRequest<{
  type: "host.start";
  executableId?: string;
}>;

type HostStop = ScopedRequest<{
  type: "host.stop";
  browserSessionId: string;
  controlEpoch: number;
  reason: "owner-close" | "shutdown" | "recovery";
}>;

type HostStatus = {
  type: "host.status";
  ownerId: string;
  agentSessionId: string;
  browserSessionId: string;
  browserHostId: string;
  controlEpoch: number;
  state: "starting" | "ready" | "disconnected" | "exited" | "stopping";
  processId?: number;
  executable: string;
  productVersion?: string;
  cdpConnected: boolean;
  profileKind: "isolated-disposable";
  startedAt: string;
  exit?: { code?: number; signal?: string; at: string };
};
```

`host.start` creates one private profile and one headed Chrome process. It never accepts arbitrary Chrome flags through the protocol.

## Browser session operations

```ts
type SessionCreate = ScopedRequest<{
  type: "session.create";
  initialUrl?: string;
}>;

type SessionClose = ScopedRequest<{
  type: "session.close";
  browserSessionId: string;
  controlEpoch: number;
}>;

type SessionList = ScopedRequest<{
  type: "session.list";
}>;

type SessionDescriptor = {
  ownerId: string;
  agentSessionId: string;
  browserSessionId: string;
  browserHostId: string;
  controlEpoch: number;
  controller: "agent" | "user" | "none";
  state: "starting" | "ready" | "degraded" | "closed";
  tabs: TabDescriptor[];
};
```

A normal owner can list only its sessions. The workspace uses a separate user-authorized list scope and receives redacted data.

## Tab operations

```ts
type TabCreate = BrowserSessionEnvelope<{ type: "tab.create"; url?: string }>;
type TabList = BrowserSessionEnvelope<{ type: "tab.list" }>;
type TabFocus = RequestEnvelope<{ type: "tab.focus" }>;
type TabClose = RequestEnvelope<{ type: "tab.close" }>;

type TabDescriptor = BrowserAddress & Generation & {
  url: string;
  title: string;
  state: "attaching" | "ready" | "crashed" | "closed";
  frameSequence: number;
  cursor: { x: number; y: number; personaSeedId: string };
};
```

`tab.create` and `tab.list` use the exact browser-session address because no tab target exists for creation and no single tab is authoritative for listing. The create response supplies the new full browser address, including tab and CDP target IDs. `tab.focus` changes Chrome presentation only. It does not set a default protocol target.

## Screenshot observation

Request:

```ts
type ScreenshotObserve = RequestEnvelope<{
  type: "observe.screenshot";
  format?: "png";
  delivery?: "inline" | "artifact" | "auto";
}>;
```

Response:

```ts
type ScreenshotObservation = BrowserAddress & Generation & {
  type: "observation.screenshot";
  observationId: string;
  operationId: string;
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  scroll: { x: number; y: number };
  frameSequence: number;
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
  image: { kind: "inline"; base64: string } | { kind: "artifact"; artifactId: string };
  cursor: { x: number; y: number; visible: boolean; pathSequence: number };
  validUntil: string;
};
```

Frame sequence increases for every completed capture. Observation IDs are random and never reused. An observation is a binding record, not a durable locator.

## DOM or accessibility fallback

```ts
type DomObserve = RequestEnvelope<{
  type: "observe.domFallback";
  mode: "accessibility" | "interactive-dom";
  maxNodes: number;
}>;

type DomFallbackObservation = BrowserAddress & Generation & {
  type: "observation.domFallback";
  observationId: string;
  operationId: string;
  observedAt: string;
  truncated: boolean;
  nodes: Array<{
    handle: string;            // documentGeneration + opaque node identity
    role: string;
    name: string;
    value?: string;
    state: Record<string, string | number | boolean>;
    bounds?: { x: number; y: number; width: number; height: number };
    locatorDescription: string;
  }>;
};
```

The runtime does not return this data with screenshot observation. A handle is valid only for the exact browser, tab, target, and document generation. Top-document replacement invalidates all handles. DOM mutation can also detach a handle before generation changes. The driver must detect detach and return `HANDLE_STALE`.

## Coordinate actions

```ts
type CoordinateAction = RequestEnvelope<{
  type: "action.coordinate";
  observationId: string;
  action:
    | { kind: "move" | "hover"; x: number; y: number }
    | { kind: "click" | "doubleClick"; x: number; y: number; button?: "left" | "middle" | "right" }
    | { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; button?: "left" }
    | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number };
}>;
```

Validation order is deadline, authenticated owner, address registry, control epoch/controller, operation uniqueness, observation ownership, target, document generation, viewport generation, freshness, viewport/scale/scroll check, and coordinate bounds. There is no fallback to a current tab or another observation.

Action result:

```json
{
  "type":"action.result",
  "operationId":"op-42",
  "state":"committed",
  "address":{"ownerId":"owner-1","agentSessionId":"pi-1","browserSessionId":"bs-1","tabId":"tab-1","targetId":"target-A","controlEpoch":7},
  "cursor":{"x":410,"y":260,"pathSequence":19},
  "timing":{"intentionalPathMs":532,"pathWallMs":548,"completionAfterPathMs":172,"totalMs":720},
  "completedAt":"2026-08-29T01:00:00.000Z"
}
```

## Semantic fallback actions

```ts
type SemanticAction = RequestEnvelope<{
  type: "action.domFallback";
  domObservationId: string;
  handle: string;
  action:
    | { kind: "click" | "doubleClick" | "hover" }
    | { kind: "type"; text: string; replace?: boolean }
    | { kind: "press"; key: string };
}>;
```

This operation is explicitly a fallback. The authority resolves the handle in the exact document. It must not rerun a broad locator against a replacement document after stale-handle failure.

## Navigation and keyboard

```ts
type Navigation = RequestEnvelope<{
  type: "navigate";
  url: string;
  waitUntil: "load" | "domContentLoaded";
}>;

type TextInput = RequestEnvelope<{
  type: "input.text";
  text: string;
  replace?: boolean;
}>;

type KeyPress = RequestEnvelope<{
  type: "input.key";
  key: string;
}>;
```

Navigation increments document generation when the top frame commits, clears observations and handles, restores the overlay, and emits lifecycle events. Text and key input address the explicit target and its current focused element. A coordinate or semantic focus action should precede text when focus matters.

## Operation status and cancellation

```ts
type OperationStatusRequest = RequestEnvelope<{
  type: "operation.status";
  targetOperationId: string;
}>;

type OperationStatus = {
  type: "operation.status";
  operationId: string;
  state: "queued" | "running" | "committed" | "failed" | "cancelled" | "expired";
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  dispatchState: "not-dispatched" | "partially-dispatched" | "dispatched";
  error?: BrowserError;
};

type OperationCancel = RequestEnvelope<{
  type: "operation.cancel";
  targetOperationId: string;
  cancellationId: string;
}>;
```

Cancellation is idempotent. Before dispatch it prevents side effects. During a mouse path it stops unsent samples and releases a held button when CDP is connected. After a click or navigation command is dispatched, it suppresses later steps and results but cannot promise rollback. Status reports partial dispatch. Deadline expiry uses the same cancellation path.

## Frame events

```ts
type FrameEvent = BrowserAddress & Generation & {
  type: "frame.available";
  observationId: string;
  frameSequence: number;
  capturedAt: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  scroll: { x: number; y: number };
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
  artifactId: string;
  cursor: { x: number; y: number; pathSequence: number };
};
```

Subscriptions declare allowed owner/session IDs in the authenticated handshake. The server keeps only the latest pending frame per tab per consumer. A consumer can acknowledge a sequence. A slow consumer skips intermediate frames. URLs contain no control credentials.

## Browser and tab lifecycle events

```ts
type LifecycleEvent =
  | { type: "browser.starting" | "browser.ready"; ownerId: string; agentSessionId: string; browserSessionId: string; controlEpoch: number; at: string }
  | { type: "browser.disconnected" | "browser.exited"; ownerId: string; agentSessionId: string; browserSessionId: string; controlEpoch: number; at: string; reason: string }
  | { type: "tab.created" | "tab.attached" | "tab.closed" | "tab.crashed"; address: BrowserAddress; at: string; reason?: string }
  | { type: "document.committed"; address: BrowserAddress; documentGeneration: number; url: string; at: string }
  | { type: "viewport.changed"; address: BrowserAddress; viewportGeneration: number; viewport: { width: number; height: number; devicePixelRatio: number }; at: string }
  | { type: "control.changed"; ownerId: string; agentSessionId: string; browserSessionId: string; oldEpoch: number; controlEpoch: number; controller: "agent" | "user" | "none"; at: string };
```

Events contain exact identity at event time. Consumers discard events that do not match their selected full address and current control epoch.

## Errors

```ts
type BrowserError = {
  type: "error";
  operationId?: string;
  code:
    | "INVALID_REQUEST"
    | "DEADLINE_EXCEEDED"
    | "OWNER_MISMATCH"
    | "SESSION_NOT_FOUND"
    | "TAB_NOT_FOUND"
    | "TARGET_MISMATCH"
    | "CONTROL_EPOCH_STALE"
    | "CONTROL_HELD_BY_USER"
    | "OBSERVATION_NOT_FOUND"
    | "OBSERVATION_STALE"
    | "DOCUMENT_CHANGED"
    | "VIEWPORT_CHANGED"
    | "COORDINATE_OUT_OF_BOUNDS"
    | "HANDLE_STALE"
    | "OPERATION_CONFLICT"
    | "OPERATION_CANCELLED"
    | "BROWSER_START_FAILED"
    | "BROWSER_EXITED"
    | "CDP_DISCONNECTED"
    | "TARGET_CRASHED"
    | "CDP_ERROR"
    | "ARTIFACT_FORBIDDEN"
    | "CAPABILITY_UNAVAILABLE";
  message: string;
  retryable: boolean;
  address?: Partial<BrowserAddress>;
  details?: Record<string, string | number | boolean>;
};
```

Errors do not include profile paths, CDP WebSocket URLs, raw page secrets, cookies, headers, or another owner’s IDs. An ownership failure must look the same whether the foreign target exists or not.
