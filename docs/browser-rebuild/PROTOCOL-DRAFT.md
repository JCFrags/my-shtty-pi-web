# Internal browser protocol

Status: Phase 1 executable internal contract. This is not the current public SDK contract.

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

A normal `session.create` transaction creates the Chrome host and first tab. There is no required public `host.start` step. Host state is an internal diagnostic.

`frames.subscribe` accepts `interest: "idle" | "selected"`. Active pointer actions temporarily override either rate with a burst rate.

## Session and tab records

A session descriptor contains its browser session ID, control epoch, state, persona ID, cursor state, and explicit tab descriptors. A tab descriptor contains its full address, URL, title, state, document generation, viewport generation, and latest frame sequence.

Tab focus changes presentation only. It does not set request authority.

## Screenshot observation

`observe.screenshot` accepts the full address and `delivery: "inline" | "artifact" | "auto"`.

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

The observation record does not retain another full screenshot buffer. It retains bounded binding metadata and an artifact reference.

## DOM fallback observation

`observe.domFallback` is a separate request. It returns a bounded list of nodes. Each node can contain an opaque handle, role, accessible name, value, selected state fields, CSS viewport bounds, document generation, and a bounded locator description.

A handle is bound to the exact actor, browser session, tab, target, and document generation. Navigation invalidates it. Same-document detach returns `HANDLE_STALE`. The runtime does not search a replacement document.

## Actions

`action.coordinate` cites an observation ID and one action:

- move or hover;
- left, right, or middle click;
- double-click;
- drag;
- vertical or horizontal wheel.

The server validates the observation before path replay. Immediately before mouse press, drag press, or wheel dispatch, it validates the control epoch, target, document generation, viewport generation, dimensions, DPR, scroll tolerance, deadline, cancellation, and coordinate bounds again. A change after movement settles as partially dispatched and does not send the irreversible event.

`action.domFallback` cites a DOM observation and handle. It supports click, double-click, hover, type or fill, and key press. Pointer actions use the session motor. They do not call page `click()`.

`navigate`, `input.text`, and `input.key` also use the exact tab address. Navigation requires the configured `NavigationAuthorization`. The production default denies it.

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

Duplicate mutation operation IDs do not execute twice. Cancellation is idempotent. Queued cancellation prevents dispatch. Running cancellation stops unsent samples and tries to release held input. Cancellation after an irreversible event does not claim rollback. Late CDP results cannot change a terminal status.

## Frame event

A workspace frame event contains:

- exact full address;
- document and viewport generations;
- increasing frame sequence;
- monotonic capture and publication times;
- media type, artifact ID, and digest;
- current session cursor state.

It does not contain an agent observation ID. A frame does not create a durable model observation. The server sends frame events on the same bound socket. Frame writes are droppable when the socket is slow.

## Artifact reads

`artifact.read` supplies an artifact ID, byte offset, and bounded maximum byte count. It returns one base64 chunk with total size, digest, and end-of-file state. Authorization uses the connection-bound actor. A caller cannot choose a file path.

## Responses and errors

A response has the request ID, optional operation ID, `ok`, and either a validated result or a sanitized error. Ownership failures do not reveal whether a foreign session, tab, target, observation, artifact, or operation exists.

The error enum includes request, authentication, deadline, ownership, session, tab, target, epoch, observation, document, viewport, coordinate, handle, operation, browser, CDP, artifact, navigation, limit, and capability failures. Ordinary errors exclude profile paths, CDP endpoints, cookies, headers, storage, and page secrets.

## Lifecycle behavior

Target close, target crash, Chrome exit, and CDP disconnect settle affected operations and stop frame capture. Operation records remain queryable. The runtime never chooses another browser or tab as a fallback.

Control-epoch increment cancels queued prior-epoch actions and stops running actions at the next cancellable boundary. An old action remains invalid after an agent-user-agent ABA sequence.
