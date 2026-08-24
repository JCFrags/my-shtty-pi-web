# Browser protocol 2

`schema/protocol.schema.json` is the authority for the browser protocol. The protocol version is `2.0.0`. A protocol 1 client is not compatible.

## Supported paths

A client must select one path when it creates a session:

- `agent-browser/chrome`
- `pinchtab/chrome`

The daemon does not choose a fallback. A failed path does not start the other path. A client must close the session before it creates a session on a different path.

The selected path, backend version, `chrome` provider, host ID, host generation, engine generation, session ID, and tab ID are immutable. PinchTab requests are checked before dispatch. Every PinchTab reply is checked again. A different provider or path fails with `wrong-path`.

## Authentication and ownership

The transport authenticates a principal. The transport adds `AuthenticatedPrincipal` to server context. A JSON-RPC request cannot supply or replace this principal.

Owned state has both `principalId` and `agentId`. Caller-supplied agent, session, tab, operation, artifact, transfer, and profile IDs are only selectors. They do not grant access. The daemon applies the principal filter in its storage query. It does not fetch global state and hide rows in the client.

All list, event, artifact CRUD, transfer, profile, operation, observation, action, and cleanup operations use the authenticated owner scope. A wrong principal or agent returns `wrong-owner` before backend dispatch.

## Address and stale-state checks

Each browser operation supplies `ProtocolAddress`. It includes the agent, session, tab, path, host generation, engine generation, and control epoch. The daemon compares all fields with durable state.

A mismatch returns one of these errors:

- `wrong-owner`
- `wrong-path`
- `stale-generation`
- `stale-control-epoch`
- `stale-visual`

The daemon does not repair a mismatch through a default tab, current session, provider change, restart, or fallback.

## Capability truth

Each session stores capability metadata for its exact path. Unsupported work returns structured `unsupported`. The error includes the immutable path identity and operation ID when one exists.

Touch is false for both supported paths. M0 did not prove touch. The action union has no touch variant.

## Actions

Protocol 2 supports navigation, mouse move/down/up/click/double-click/wheel/drag, key press/down/up, text input, fill, select, owned upload handles, download, history movement, reload, and bounded wait.

Coordinate actions use CSS viewport pixels with a top-left origin. The daemon rejects non-finite, negative, or out-of-range coordinates before backend dispatch. Coordinate actions also include a `VisualGuard`. It binds the action to the current viewport ID, viewport generation, screenshot SHA-256, and screenshot sequence.

Semantic refs are scoped to one observation. The agent-browser path emits refs such as `o7-e163`. A semantic action must use the complete ref from the latest observation. Navigation or a later observation makes an older ref stale. The adapter rejects stale and unscoped refs before dispatch.

An action result includes post-action semantic evidence. Backend dispatch alone is not success evidence.

## Operations and cancellation

Every observation and action is a durable operation. States are `queued`, `running`, `cancelling`, `succeeded`, `failed`, and `cancelled`. Terminal state and the sanitized structured error survive a client disconnect.

`operation.cancel` reaches the daemon-side backend operation. Dropping a request future is not cancellation. The result is `cancelled`, `already-terminal`, or `not-cancellable` and includes the final operation state.

## Artifacts and transfers

Artifacts are owner-scoped and content-addressed. Reads verify the stored bytes against SHA-256 before release. Artifact list, get, and delete use the authenticated principal in the storage query.

Uploads first enter an owner-only staging area. A committed typed `TransferHandle` names the digest, size, state, expiry, and owner. Browser actions accept transfer IDs, not host file paths. Downloads become owned artifacts. A backend file path is never a protocol transfer handle.

Public URL fetch is a separate service boundary. It must resolve and check every address, block local and private targets, limit redirects, and check the final peer address. The browser protocol does not treat an arbitrary URL as an upload.

## Human control

Human takeover and return increment `controlEpoch`. They also bind one owned tab, one viewport generation, and one scoped stream lease. An action with an old epoch fails before dispatch. Human control does not change ownership or path identity.

Status and failure values sent to the workspace are sanitized. Tokens, cookies, headers, profile paths, backend command lines, and raw backend output are not status fields.

## Lifecycle and recovery

Create, close, and cleanup transitions are durable. Session creation does not publish `ready` until the host, session, and first tab records commit. Close enters `closing`, blocks new work, cancels operations, revokes transfers and stream leases, closes tabs, closes the backend session, and records its terminal result.

Cleanup is protected and idempotent. Restart recovery checks durable state and the exact backend identity. It never adopts an unknown backend session. It either restores the same path and generations or fails closed and performs protected cleanup.

## Compatibility seam

The Rust and TypeScript packages retain temporary protocol 1 type names so the browser candidate can compile while dependent lanes rebase. Those names are not in the protocol 2 schema. New code must use `BrowserPathId`, `ProtocolAddress`, `BrowserActionV2`, `ProtocolObservation`, durable operation types, and typed transfer handles.
