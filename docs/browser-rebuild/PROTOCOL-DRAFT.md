# Internal browser protocol

Status: Phase 2A executable internal contract. This is the private browserd protocol, not public WebX API major 3.

The authoritative source is `packages/browser-protocol/src/schema.ts`. The deterministic machine-readable artifact is `packages/browser-protocol/schema/browser-protocol.schema.json`. Conformance fixtures and parser tests are in `packages/browser-protocol/tests/`.

## Framing and version

`browserd` uses bounded newline-delimited JSON on an owner-only Unix socket. Every record has `protocolVersion: "browser.v1"`. Request and response objects reject unknown fields. IDs, strings, URLs, numbers, lists, screenshots, and frame sizes have explicit bounds.

Mutation and observation requests contain:

```ts
{
  protocolVersion: "browser.v1";
  kind: string;
  requestId: string;
  operationId: string;
  deadline: string; // absolute RFC 3339 timestamp
}
```

The parser rejects expired deadlines and deadlines too far in the future. URLs are bounded HTTP or HTTPS URLs. Error codes are a finite enum. Errors use sanitized messages and bounded primitive details.

## Connection binding

The first client record is:

```ts
{
  protocolVersion: "browser.v1";
  kind: "bind";
  requestId: string;
  bindingSecret: string;
  actor: {
    principalId: string;
    agentSessionId: string;
  };
}
```

The server validates the per-start secret and returns `kind: "bound"`. The connection can bind only once. An ordinary request has no principal or agent-session field. It cannot select or replace identity.

The descriptor secret proves access to the same-user descriptor. The intended client is trusted `webxd`. It does not isolate hostile processes that already run as the same Unix user.

## Addresses and generations

A tab request uses:

```ts
type TabAddress = {
  browserSessionId: string;
  tabId: string;
  targetId: string;
  controlEpoch: number;
};

type Generation = {
  documentGeneration: number;
  viewportGeneration: number;
};
```

The server resolves the address under the connection-bound actor. It never fills an address from Chrome focus, OS focus, workspace selection, an active tab, or a recent request.

Session create and list need no tab address. Session close, tab create, and tab list use `browserSessionId` plus `controlEpoch`. Operation status and cancel use only `targetOperationId` because their records survive tab and browser failure.

## Requests

The executable request union includes:

- `capabilities.get`
- `session.create`, `session.close`, `session.list`
- `tab.create`, `tab.list`, `tab.focus`, `tab.close`
- `observe.screenshot`
- `observe.domFallback`
- `action.coordinate`
- `action.domFallback`
- `navigate`
- `input.text`, `input.key`
- `operation.status`, `operation.cancel`
- `artifact.read`
- `frames.subscribe`, `frames.unsubscribe`

A normal `session.create` transaction creates the Chrome host and first tab. There is no required public `host.start` step. Host state is an internal diagnostic. Production session creation requires configured healthy egress. An optional initial URL carries a short-lived signed `NavigationAuthorization`.

`frames.subscribe` requires a bounded opaque `subscriptionId` and accepts `interest: "idle" | "selected"`. `frames.unsubscribe` requires the same ID and full address. The ID is bound to one connection, actor, address, epoch, and interest. An identical duplicate is idempotent. Reuse for another address or interest returns `OPERATION_CONFLICT`. Unsubscribing an unknown ID is idempotent and returns `subscribed: false`. Active pointer actions temporarily override either rate with a burst rate.

## Session and tab records

A session descriptor contains its browser session ID, control epoch, state, persona ID, cursor state, and explicit tab descriptors. A tab descriptor contains its full address, URL, title, state, document generation, viewport generation, and latest frame sequence.

Tab focus changes presentation only. It does not set request authority.

## Screenshot observation

`observe.screenshot` accepts the full address and `delivery: "inline" | "artifact" | "auto"`. Production WebX requests artifact delivery and reconstructs bounded chunks outside browserd.

Its result contains:

- observation ID and exact address;
- URL and title;
- wall-clock and monotonic capture time;
- CSS viewport, DPR, and scroll;
- document and viewport generations;
- increasing frame sequence;
- PNG media type, byte length, and SHA-256;
- bounded inline bytes or an owner-scoped artifact ID;
- cursor position, visibility, path sequence, and persona ID;
- validity timestamp.

The runtime compares target, CDP session, document generation, viewport generation, control epoch, CSS dimensions, DPR, and scroll before and after capture. It retries one inconsistent capture when the deadline permits. The immutable captured identity remains bound through digest and artifact insertion. The runtime resolves the exact tab again immediately before commit. It returns `DOCUMENT_CHANGED`, `VIEWPORT_CHANGED`, or `CONTROL_EPOCH_STALE` on a commit-time mismatch and idempotently revokes any new artifact. `capturedMonotonicMs` records completed capture.

The observation record does not retain another full screenshot buffer. It retains bounded binding metadata and an artifact reference.

## DOM fallback observation

`observe.domFallback` is a separate request. It returns a bounded list of nodes. The store has explicit observation, total-handle, and per-observation-handle limits with deterministic pruning. Each node can contain an opaque handle, role, accessible name, value, selected state fields, top-level CSS viewport bounds, document generation, and a bounded locator description.

A handle is bound to the exact actor, browser session, tab, target, and document generation. Navigation, expiry, detach, target movement, or document mismatch returns `HANDLE_STALE`. AX-tree, resolve, and box-model work accepts the operation cancellation signal. The runtime does not search a replacement document. Same-origin child frame AX trees are supported. Cross-origin out-of-process iframe fallback is unsupported in Phase 1.2 because that target is outside the tab DOM authority.

## Actions

`action.coordinate` cites an observation ID, declares `imagePixels` or `cssViewport`, and contains one action. Browserd resolves the exact observation before it converts image pixels to CSS viewport coordinates. It does not infer dimensions from DPR.

Supported coordinate actions are:

- move or hover;
- left, right, or middle click;
- double-click;
- drag;
- vertical or horizontal wheel.

The server validates the observation before path replay. Immediately before mouse press, drag press, or wheel dispatch, it validates the control epoch, target, document generation, viewport generation, dimensions, DPR, scroll tolerance, deadline, cancellation, and coordinate bounds again. A change after movement settles as partially dispatched and does not send the irreversible event.

`action.domFallback` cites a DOM observation and handle. It supports click, double-click, hover, type or fill, and key press. Pointer actions use the session motor. They do not call page `click()`.

`navigate`, `input.text`, and `input.key` also use the exact tab address. Initial URLs, explicit navigation, and URL-bearing new tabs require a signed authorization bound to runtime instance, actor, operation ID, normalized URL, egress binding, expiration, and nonce. Browserd verifies it before dispatch. The production default denies navigation and session creation without configured healthy egress.

## Operation records

Status and cancellation are actor-scoped by operation ID:

```ts
type OperationState =
  | "queued"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "expired";

type DispatchState =
  | "not-dispatched"
  | "partially-dispatched"
  | "dispatched";
```

The status record has queue, start, and finish times, terminal result or sanitized error, and dispatch state. It may retain former session and tab IDs for internal correlation. The status request does not require a live tab address.

The operation record stores a bounded SHA-256 fingerprint of canonical mutation semantics. It includes request kind, identity, control epoch, action body, and relevant options. It excludes `requestId` and `deadline`. The runtime checks existing actor, operation ID, and fingerprint state before current session or tab lookup. An exact retry therefore returns or waits for the original queued, running, or terminal operation even after the resource was closed, rolled back, or crashed. A different fingerprint returns `OPERATION_CONFLICT` before lookup and causes no second side effect. Frame subscribe and unsubscribe fingerprints include the internal browserd connection identity. A reconnect cannot recover another connection's subscription success. Cancellation is idempotent. Queued cancellation prevents dispatch. Running cancellation stops unsent samples and tries to release held input with an independent bounded cleanup budget. Cancellation after an irreversible event does not claim rollback. Late CDP results cannot change a terminal status.

## Frame event

A workspace frame event contains:

- exact current full address;
- current URL and title;
- document and viewport generations;
- CSS width and height plus DPR;
- increasing frame sequence;
- completed-capture and publication monotonic times;
- media type, byte length, artifact ID, and digest;
- current session cursor state.

It does not contain an agent observation ID. A frame does not create a durable model observation. The server sends frame events on the same bound socket. Frame writes are droppable when the socket is slow.

## Artifact reads

`artifact.read` supplies an artifact ID, byte offset, and bounded maximum byte count. It returns one base64 chunk with the actual stored media type, total size, digest, and end-of-file state. Phase 2A supports bounded PNG and verified JPEG fallback. The public Pi image remains at or below 4 MiB and is never truncated. Each record is scoped by actor, browser session, optional tab, and purpose (`agent-observation` or `workspace-frame`). Authorization uses the connection-bound actor. A caller cannot choose a file path.

## Responses and errors

A response has the request ID, optional operation ID, `ok`, and either a validated result or a sanitized error. Runtime and transport failures use a typed `BrowserProtocolError` with a finite code, safe message, retry flag, and bounded safe details. Unknown failures become `INTERNAL_ERROR`; they are not inferred from message text. CDP disconnect is `CDP_DISCONNECTED`, target crash is `TARGET_CRASHED`, missing operation is `OPERATION_NOT_FOUND`, and missing or foreign artifact is `ARTIFACT_NOT_FOUND`. Ownership failures do not reveal whether a foreign session, tab, target, observation, artifact, or operation exists.

The error enum includes request, authentication, deadline, ownership, session, tab, target, epoch, observation, document, viewport, coordinate, handle, operation, browser, CDP, artifact, navigation, limit, and capability failures. Ordinary errors exclude profile paths, CDP endpoints, cookies, headers, storage, and page secrets.

## Lifecycle behavior

Tab and popup registration are transactions. Capacity is checked before target creation. A tab is not visible to list or action lookup until attachment, required domain enablement, and identity initialization finish. A later overlay, cancellation, authorization, or initial navigation failure closes and unregisters the new target. Failed attachment and popup work leaves no authoritative mapping.

Target close, target crash, Chrome exit, and CDP disconnect settle affected operations and stop frame capture. Operation records remain queryable. The runtime never chooses another browser or tab as a fallback.

Control-epoch increment cancels queued prior-epoch actions and stops running actions at the next cancellable boundary. An old action remains invalid after an agent-user-agent ABA sequence.

## Public WebX boundary

Trusted webxd parses every browserd response and event through the private protocol parser. It securely discovers the current descriptor, binds one persistent connection per authenticated actor, and generates a new request ID for each wire attempt. The WebX idempotency key supplies the stable mutation operation ID.

The public browser contract is version `3.0.0`. It removes CDP target IDs and private transport details. Public tabs use `tabId`; webxd restores the internal full address from actor-owned session state and confirms ownership with browserd.

A daemon runtime-instance change closes old connections. Old sessions are not recreated. New actor connections can bind to the replacement for new work. Search and read do not use this transport.
