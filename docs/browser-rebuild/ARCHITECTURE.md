# Screenshot-first browser architecture

## Recommendation

Use TypeScript for the Pi extension, web authority, browser protocol, browser runtime, and CDP driver. Keep browser control in a separate long-lived Node service named `browserd`. Keep Tauri as a local screenshot workspace. Do not put Chrome lifecycle or CDP state inside `webxd`.

The intended process boundary is:

```mermaid
flowchart LR
  Agent[Pi agent] -->|native Pi tools| Ext[apps/pi-webx]
  Ext --> Webxd[webxd\nsearch, read, URL authority]
  Webxd -->|private actor-bound Unix socket| Browserd[browserd\noperations and browser runtime]
  Browserd -->|explicit browser CDP| ChromeA[headed Chrome A\ntemporary profile A]
  Browserd -->|explicit browser CDP| ChromeB[headed Chrome B\ntemporary profile B]
  Browserd --> Artifacts[owner-scoped artifacts]
  Workspace[Tauri local workspace] -->|future authenticated frame bridge| Browserd
  Artifacts --> Workspace
```

Phase 1 adds `packages/browser-protocol`, `packages/browser-runtime`, and `apps/browserd` in parallel with the current production stack. It does not connect `webxd`, the Pi tools, or the current workspace to the new runtime.

## Process responsibilities

### Pi native extension

The extension supplies model-facing tools. It uses `webxd` as the policy boundary. It will not connect directly to CDP or select an active tab.

### webxd

`webxd` remains healthy when Chrome or `browserd` fails. It owns public navigation policy and attestation. It also owns search, direct read, cache, content, and destination policy. In a later phase, it will authenticate to `browserd` and bind each connection to one principal and Pi agent session.

### browserd

`browserd` is a separate persistent Node process. It owns:

- the private Unix socket and per-start descriptor;
- connection-bound actor identity;
- browser session, tab, and target registries;
- one Chrome host and temporary profile per browser session;
- one browser-level CDP connection per Chrome host;
- operation lanes, deadlines, cancellation, and control epochs;
- virtual-mouse motors;
- screenshot observations, workspace frames, DOM handles, and artifacts;
- failure settlement and deterministic cleanup.

A browser or CDP failure cannot crash healthy `webxd` search and read work.

### Chrome host

Each browser session gets one headed Chrome or Chromium process. Each process gets a new private `0700` profile. `DevToolsActivePort` supplies a race-free loopback endpoint. The runtime keeps one browser-level CDP WebSocket and attaches each page through an explicit flattened CDP session.

The runtime does not accept a profile path or arbitrary Chrome flags from a request. It rejects flags that disable the sandbox, web security, certificate checking, or site isolation.

### Tauri workspace

The future Tauri workspace renders local UI and screenshot bytes only. It must not embed arbitrary remote sites. Workspace selection is presentation state. It does not grant browser authority or create an implicit active tab.

## Actor and authority model

A new socket connection first supplies the per-start binding secret and one actor identity:

```text
ActorIdentity
  principalId
  agentSessionId
```

The connection binds once. It cannot bind again. Ordinary requests contain no principal or agent-session fields. They cannot replace the actor identity. Browser session lookup compares the bound actor to the session owner. Ownership failures use a not-found result and do not reveal whether another actor's object exists.

The binding secret authenticates access to the owner-only descriptor. Production trusts `webxd` as the only browserd client. `webxd` authenticates and scopes each Pi connection before it supplies actor identity. The Pi extension and model requests do not receive the descriptor or binding secret. Direct browserd access is an administrator and developer capability. The same-user boundary does not defend against hostile code that already runs as the same Unix user. See `ADR-011-BROWSERD-TRUST-BOUNDARY.md`.

All tab work uses this full address:

```text
browserSessionId
  tabId
  targetId
  controlEpoch
```

The registry verifies the full parent-child relation. Chrome focus, workspace selection, OS focus, and the last used tab never supply authority.

## Session, tab, and motor model

One browser session owns:

- one Chrome process;
- one disposable profile;
- one browser CDP connection;
- one persistent AgentCursor persona;
- one persistent cursor position and button state;
- one serialized pointer and keyboard lane.

A browser session can own many explicit tabs. Each tab owns its target ID, flattened CDP session, top-frame ID, document generation, viewport generation, observation records, DOM handles, overlay state, and latest frame.

Pointer actions on two tabs in one browser session serialize through the same motor. Actions in different browser sessions can run concurrently. When the motor moves to another tab, the runtime first restores the session cursor overlay at its current position.

## Target lifecycle

The registry creates and adopts only targets that belong to its exact browser session. It closes or hides the browser bootstrap page. A popup is registered only when its opener is an owned tab. Unknown targets are not adopted.

Target registration is transactional. The runtime checks the per-session tab limit before target creation. It does not publish the tab or target mapping until attachment, required domain enablement, and identity setup succeed. Session-level creation then owns rollback if overlay installation, cancellation, authorization, or initial navigation fails. Rollback closes or detaches the target where possible and removes target, auto-session, observation, handle, frame, and listener state. A failed target or popup is not selectable and does not consume tab capacity.

A target close or crash invalidates its observations, DOM handles, and frame schedule. It also settles affected operations. Renderer replacement, prerender activation, or an unproven target swap fails closed. There is no active-tab or last-tab fallback.

## Two screenshot products

### Agent screenshot observation

An agent observation exists only after an explicit `observe.screenshot` request. It uses lossless PNG in Phase 1. Its bounded metadata includes the exact actor-owned address, URL, title, wall and monotonic capture time, viewport, DPR, scroll, document and viewport generations, frame sequence, digest, cursor state, and validity time.

Capture is a bounded consistency transaction. The runtime reads layout and scroll before and after PNG capture and confirms the same target, CDP session, document generation, viewport generation, control epoch, CSS dimensions, DPR, and scroll tolerance. It retries once when safe. The captured identity remains immutable through digest and artifact insertion. The runtime resolves the exact tab again immediately before publication. A commit-time mismatch returns `DOCUMENT_CHANGED`, `VIEWPORT_CHANGED`, or `CONTROL_EPOCH_STALE`, revokes any new artifact idempotently, and retains no observation. The completed capture time defines freshness.

The image is stored as an owner-scoped artifact unless it is below the reviewed inline limit. Observation metadata stores an artifact ID and digest. It does not retain another full image buffer.

### Workspace live frame

A workspace frame is a separate, short-lived product. A bounded scheduler keeps at most one capture in flight per tab and a two-artifact pinned frame ring per tab. An idle subscription uses a low rate. A selected subscription uses a higher rate. An active pointer action temporarily uses a burst rate. Slow clients drop replaceable frames.

Each frame subscription has a bounded opaque ID. It belongs to one browserd connection, actor, full tab address, control epoch, and interest level. An identical duplicate is idempotent. Conflicting ID reuse fails. Disconnect, epoch change, tab close, and session close remove the subscription and stop an unused schedule. A frame is sent only to a connection that owns a matching live subscription.

A workspace frame does not create an agent observation. Frame bytes use owner-scoped artifacts in Phase 1. A later Tauri bridge can use a more direct bounded byte channel after review.

## Screenshot-bound input

A coordinate action cites an observation ID. Admission checks the exact actor-owned address, document generation, viewport generation, freshness, CSS viewport, DPR, scroll tolerance, coordinate bounds, control epoch, deadline, and cancellation state.

Movement alone is not commitment. Immediately before a press, drag press, or wheel dispatch, the runtime repeats the checks. If the page changes after movement, the operation settles as partially dispatched and does not send the irreversible event. The normal policy does not require equal screenshot bytes because animation can change the image. Higher-risk policy can require a newer observation or local region evidence.

## Virtual mouse

The runtime selectively ports AgentCursor `0.3.0` path and persona code from commit `b23c633c66fd240f836f5edd1034f6fcf678e237`. It does not use AgentCursor MCP, extension, stock transport, macOS driver, or full package.

The motor sends sampled CDP input to the exact flattened target session. It supports move, hover, click, double-click, drag, vertical and horizontal wheel, text, and keys. Cancellation stops unsent samples. Cleanup releases recorded buttons and keys when CDP remains available.

A closed-shadow-root overlay has `pointer-events: none`. The runtime installs it for every top-level document and verifies it before input and capture. Mutation tests confirm reinjection while a modal dialog exists. An in-page overlay can still be occluded by browser fullscreen UI, PDF or internal viewers, and top-layer content; the test proves survival, not visual precedence over every top layer. CDP input and the overlay are a virtual page mouse. They are not Linux OS input and do not imply bot-detection immunity.

## DOM fallback

DOM or accessibility inspection is explicit. It does not run for every screenshot. The runtime has explicit limits for observations, total handles, and handles per observation. It prunes expired or excess observations and all related handles deterministically. The public handle is opaque and maps to an internal backend node for one actor, session, tab, target, and document generation.

Navigation, expiry, detach, target movement, or document mismatch returns `HANDLE_STALE`. The runtime does not search a replacement document. AX-tree and box-model CDP work accepts the operation cancellation signal. Bounds use top-level CSS viewport coordinates. Vertical and horizontal scroll and same-origin iframe coordinates have deterministic and live coverage. Same-origin child frame accessibility trees are included. Cross-origin out-of-process iframes remain unsupported because those targets are outside the tab DOM authority. Pointer-based fallback actions still use the session motor and its human-style path.

## Operations and control epoch

Operation status is actor-scoped by operation ID. The record does not depend on a live tab address. Status and cancellation remain queryable after tab close, target crash, Chrome exit, or CDP disconnect.

States are `queued`, `running`, `committed`, `failed`, `cancelled`, and `expired`. Dispatch state is separate: `not-dispatched`, `partially-dispatched`, or `dispatched`. Cancellation after a click or navigation dispatch does not claim rollback.

Each absolute deadline is converted to a monotonic budget at admission. Expired queue entries do not dispatch. Each actor-scoped mutation stores a bounded SHA-256 fingerprint of its canonical semantic request. The fingerprint includes kind, identity, epoch, action, and relevant options. It excludes request ID and deadline. The runtime checks an existing operation before resolving the current session or tab. An exact operation-ID retry can therefore return its original result after close, rollback, or target failure. Changed semantics return `OPERATION_CONFLICT` before resource lookup and do not execute. Connection-scoped frame mutations include the internal connection identity. A reconnect cannot inherit a disconnected connection's successful subscription. Status, cancellation, count, and retention are bounded.

A control takeover increments the session epoch. It cancels queued old-epoch work and stops running work at the next cancellable boundary. A later epoch cannot make an old action valid again. Phase 1 tests this mechanism but does not expose user takeover.

## Transport and artifacts

`browserd` listens only on a Unix-domain socket in a `0700` runtime directory. The descriptor and socket use mode `0600`. The descriptor contains a random per-start secret. The protocol uses bounded newline-delimited JSON. Request and response frames have size limits. A disconnect cancels its pending requests. Events share the same authenticated connection and use droppable backpressure.

Artifacts have random IDs, private storage, owner-scoped reads, SHA-256 integrity, item and total byte limits, entry limits, expiry, and pruning. Each record carries actor owner, browser session, optional tab, purpose, actual media type, size, digest, and creation and expiry times. Owner and session quotas apply before the global bound so ordinary pressure cannot evict another actor's artifacts. A bounded frame ring keeps recent published frames readable. Tab and session termination revoke their scoped artifacts. Callers cannot choose a storage path. Profile paths, CDP URLs, cookies, headers, storage, and page secrets do not appear in ordinary errors.

## Recovery and cleanup

Session creation is transactional. Failure closes CDP, stops Chrome, and removes the owned profile. Normal shutdown sends `Browser.close`, then uses TERM and KILL only if needed. The runtime waits for process settlement before profile deletion.

One runtime-owned profile manager allocates under a unique runtime-instance root. Allocation transitions from allocating to starting to running under an atomic cross-process lock where required. Lock acquisition publishes a complete nonce-bearing owner record through an atomic no-replace primitive. Release verifies the current nonce, PID, and process-start identity. Young malformed state receives a bounded grace period. Manifests bind runtime ID, launch ID, PID, and process-start ticks. Startup orphan cleanup runs once and removes only a verified dead runtime-owned root. Profile deletion verifies the real owned directory, marker, runtime identity, launch identity, and process identity. Symlinks, foreign directories, live owners, and paths outside the root are rejected. The manager tracks active leases and refuses close while one remains. Normal runtime shutdown closes the manager and removes only its own empty marker and runtime-instance root.

Before inspecting or changing shared service paths, browserd acquires an atomic nonce-bearing startup ownership lock. Each runtime instance uses a unique socket name. The fixed descriptor points to that socket and is written atomically only after the socket is listening and verified as `0600`. It includes protocol version, runtime instance ID, PID, process-start ticks, socket path, binding secret, and start time. Startup uses PID plus start ticks to distinguish a live owner from PID reuse. Cleanup removes the descriptor, unique socket, or owner lock only when their exact instance and nonce still match. Failed startup and idempotent shutdown cannot remove replacement resources. Connections and unbound-client bind time are bounded.

Chrome exit or CDP disconnect stops frames and settles all session operations. A target failure affects only that target. The runtime never falls back to another browser.

## Navigation policy

Public navigation authority remains in `webxd`. `browserd` has a narrow `NavigationAuthorization` interface. Production defaults to deny when no authorizer is configured. Phase 1 live tests use an authorizer that permits only their deterministic loopback fixture.

## Fedora deployment and resources

The executable comes only from reviewed service configuration. Prefer Google Chrome when it is already installed. Support configured Fedora Chromium. Do not install a browser as a runtime side effect.

Linux resource evidence uses `/proc/<pid>/smaps_rollup` PSS as the primary memory metric. Summed RSS can double-count shared pages and is not the production decision metric. Keep one Chrome process per browser session until PSS evidence and a separate architecture decision justify a change.

The Phase 1.2 two-hour mixed run did not prove a memory plateau. Total PSS slopes were +41,613 KiB/hour over the full run, +61,198 KiB/hour in the final hour, and +29,914 KiB/hour in the final 30 minutes. Browserd, bounded stores, process counts, and one Chrome session were nearly flat late in the run. Most final-hour growth was in the other Chrome tree. Phase 2 development can proceed behind its reversible switch, but production-default routing requires either credible longer plateau evidence or a tested bounded Chrome session recycling and recovery policy.
