# Browser rebuild decisions

These decisions apply to the replacement browser runtime. They supersede conflicting Phase 0 draft text.

## ADR-001: Raw CDP plus selective AgentCursor core

**Decision:** Use one persistent browser-level Chrome DevTools Protocol connection per browser session. Selectively port AgentCursor path and persona source from version `0.3.0`, commit `b23c633c66fd240f836f5edd1034f6fcf678e237`.

**Reason:** CDP gives explicit target lifecycle, input, screenshot, and accessibility control. AgentCursor supplies useful human-style path and persona behavior without imposing its transport.

**Consequence:** This repository owns target mapping, overlay behavior, cancellation, and Chrome compatibility tests. The MIT license and exact upstream record stay beside the port.

## ADR-002: Separate browserd process

**Decision:** Run `apps/browserd` as a separate persistent Node process. `webxd` will use a private Unix protocol and must not import the full browser runtime.

**Reason:** Chrome and CDP failure must not disable healthy search, read, cache, or content services.

**Consequence:** Phase 1 implements and tests the transport but does not connect production `webxd` or Pi tools.

## ADR-003: One Chrome process per browser session

**Decision:** Give each browser session one headed Chrome or Chromium process and one runtime-created disposable profile.

**Reason:** A process boundary gives clear session isolation and failure ownership.

**Consequence:** Linux process-tree PSS, not summed RSS, is the primary memory metric. A weaker shared-context model requires a later explicit decision based on evidence.

## ADR-004: One motor per browser session

**Decision:** Store one persona, cursor position, path sequence, pressed-input state, and serialized input lane per browser session.

**Reason:** One simulated person must remain consistent while it moves between tabs.

**Consequence:** Pointer work across tabs in one session serializes. Different browser sessions can act concurrently. Document, viewport, observation, frame, overlay, and handle state remain per tab.

## ADR-005: Screenshot-first perception

**Decision:** Make an explicit lossless screenshot observation the primary agent perception primitive. Keep DOM or accessibility observation explicit and separate.

**Reason:** The product acts through visual grounding. Automatic DOM extraction would change the behavior model and increase data volume.

**Consequence:** Coordinate actions cite an observation ID and revalidate it immediately before irreversible dispatch.

## ADR-006: Separate agent observations and workspace frames

**Decision:** Keep agent observations and live workspace frames as different bounded products.

**Reason:** Agent observations need durable grounding metadata. Workspace frames need low-latency replacement and can drop intermediate images.

**Consequence:** Frame scheduling does not create model observations. The runtime stores only bounded observation metadata and owner-scoped artifact references.

## ADR-007: Connection-bound actor identity

**Decision:** Bind each browserd connection once to one principal and Pi agent session after validating the protocol version and per-start descriptor secret.

**Reason:** Ordinary requests must not select an owner or switch identity.

**Consequence:** Request schemas omit actor selectors. Status, cancellation, sessions, tabs, observations, frames, artifacts, and handles are actor-scoped. The Phase 1 secret proves same-user descriptor access, not actor-specific identity against a hostile same-user process. Phase 2 must add trusted-service attestation if that threat is in scope.

## ADR-008: No MCP or Chrome extension

**Decision:** Do not add AgentCursor MCP, its extension, stock extension transport, macOS driver, or full package.

**Reason:** They add process, packaging, and active-tab surfaces. Phase 0 and Phase 1 evidence shows that raw CDP covers the required browser capabilities.

**Consequence:** Reconsider an extension only after a deterministic test proves one named required capability cannot use CDP or a narrow preload script.

## ADR-009: No arbitrary evaluation API

**Decision:** Do not expose general JavaScript evaluation in protocol, service, Pi-facing API, or production exports.

**Reason:** Arbitrary evaluation expands authority and makes policy, privacy, and auditing harder.

**Consequence:** Runtime internals can use narrow fixed CDP operations. Live fixtures can use a private source-level adapter that request handling cannot enable.

## ADR-010: Temporary profiles in Phase 1

**Decision:** Support runtime-created disposable profiles only. Do not accept a host path or share a profile.

**Reason:** This gives deterministic ownership and cleanup while persistence policy is still undefined.

**Consequence:** Profile deletion requires an owned manifest under the configured root and a settled exact process. Persistent owner-scoped profiles remain a later design.

## ADR-011: Trust webxd, not arbitrary same-user clients

**Decision:** In production, `browserd` accepts only trusted `webxd` as its client. `webxd` authenticates and scopes the Pi connection before it supplies actor identity. The Pi extension and model requests do not receive the descriptor or binding secret.

**Reason:** Owner-only Unix permissions and a random descriptor secret isolate Unix users. They cannot isolate hostile processes that already run under the same Unix user ID.

**Consequence:** Direct browserd access is an administrator and developer capability. Hostile same-UID code remains outside the protection boundary unless a later separate-user or sandbox design is adopted. See `ADR-011-BROWSERD-TRUST-BOUNDARY.md`.

## ADR-012: Require plateau or bounded Chrome recycling before default routing

**Decision:** Phase 2 development can proceed behind one reversible service switch after Phase 1.2 correctness gates pass. Production-default browser routing requires either credible representative plateau evidence or a tested bounded Chrome session recycling and recovery policy.

**Reason:** The Phase 1.2 two-hour run kept browserd, artifacts, operations, process counts, and one Chrome session nearly flat in late windows, but total PSS did not plateau. Most final-hour growth was in the other Chrome process tree.

**Consequence:** Do not weaken one-process-per-session isolation to improve the metric. A recycling design must preserve explicit session identity, operation dispatch truth, cleanup, and visible recovery. Resource limits remain a production gate, not a Phase 2 development blocker.

**Phase 4A status:** Commit `02b6c78` supplies the tested hard containment mechanism defined by ADR-027. Exact installed candidate `30d76dc` passed representative acceptance, one typed hard-limit closure, and the user-approved fixed 300-second soak. It fences and explicitly closes only the affected session; it never recycles or remaps that session ID. ADR-012 is resolved for canary use only. AgentCursor remains non-default, and Phase 4B requires a separate default-cutover decision.

## ADR-013: Public screenshot-first contract

**Decision:** Move the bundled SDK, webxd, and native Pi extension together to public API major 3. Use `agentcursor/chrome` for the new route. Make screenshot observation the default, deliver one real Pi image item, use the real browserd observation ID, default coordinates to image pixels, and keep DOM fallback explicit.

**Reason:** The old semantic and workspace browser shapes are not compatible with explicit screenshot grounding. The model points into image pixels, which can differ from CSS viewport pixels.

**Consequence:** Browserd converts coordinates from the exact cited observation. Base64 stays out of model text and compact details. Unsupported workspace, debug, upload, download, selector, and arbitrary-evaluation operations are not advertised. See `ADR-013-PUBLIC-SCREENSHOT-CONTRACT.md`.

## ADR-014: Signed navigation plus connection-bound egress

**Decision:** Keep destination policy in trusted webxd. Sign each explicit browser URL authorization for one runtime, actor, operation, normalized URL, egress binding, expiration, and nonce. Require production Chrome to use the reviewed loopback forward proxy, which validates and pins each public destination connection.

**Reason:** Explicit URL checks cannot constrain redirects, clicks, forms, scripts, or popups. A broker token alone cannot constrain page-driven network connections.

**Consequence:** Session creation fails closed without healthy egress. Redirects and page-driven navigation remain on the proxy path. Browserd quarantines unexpected committed protocols as defense in depth. Test-only loopback fixture policy cannot be enabled in production. See `ADR-014-BROWSER-EGRESS-BOUNDARY.md`.

## ADR-015: Production observation lease and motor timing

**Decision:** Configure screenshot and DOM observation lifetimes separately. Both default to 60 seconds and accept only 10–120 seconds. Use monotonic expiry and expose exact wall `validUntil`. Keep all structural and post-path checks. Keep visible human paths while pipelining bounded CDP input acknowledgements and enabling per-tab focus emulation.

**Reason:** A 3-second production lease could not cover model reasoning plus Phase 2A's 5.2-second route. Serialized background CDP acknowledgements, not the path generator, caused the long delay.

**Consequence:** Ordinary movement targets 400–1,500 ms median and at most 2,500 ms p95 without teleporting or deleting persona behavior. See `ADR-015-OBSERVATION-LEASE-AND-MOTOR-TIMING.md`.

## ADR-016: Exact screenshot transfer and route-aware idempotency

**Decision:** POST screenshot observation returns metadata only. A separate authenticated GET retrieves one exact actor/session/tab/observation image. Webxd retains bounded metadata and no long-lived full screenshot buffer. Only durable small mutations enter general idempotency; ephemeral observations and image reads do not.

**Reason:** The Phase 2A all-POST policy could retain image base64 for 15 minutes, and a session-wide latest image could be overwritten by concurrent observations or outlive its artifact.

**Consequence:** General idempotency reports zero retained image bytes. Exact image retrieval validates canonical base64, total bytes, digest, media type, and dimensions. Cached public responses cannot revive expired observations, artifacts, handles, or documents. See `ADR-016-SCREENSHOT-TRANSFER-AND-IDEMPOTENCY.md`.

## ADR-017: Session capture arbitration and bounded screenshot recovery

**Decision:** Construct one `SessionCaptureCoordinator` per browser session. Route complete agent-observation and workspace-frame screenshot transactions through it. Allow at most one safe read-only retry for an exact typed `Page.captureScreenshot` timeout. Make webxd shutdown cleanup-final and replacement-socket-safe.

**Reason:** Phase 2B allowed explicit observations and workspace frames to overlap against one session compositor. Generic timeout errors could not support exact recovery, and fail-fast webxd shutdown could skip socket cleanup.

**Consequence:** Same-session capture concurrency is one while separate browser sessions retain concurrency. Agent FIFO is bounded to eight, frame intent is coalesced per tab, and bounded fairness admits a pending frame after at most four agent captures. Failed attempts publish nothing. See `ADR-017-SESSION-CAPTURE-ARBITRATION.md`.

## Phase 1.1, Phase 1.2, Phase 2A, Phase 2B, and Phase 2B.1 confirmations

Phase 1.1 confirms that frame subscriptions are connection-, actor-, full-address-, epoch-, and subscription-ID-scoped. Operation IDs use canonical semantic fingerprints. Artifacts use actor, session, tab, purpose, media type, size, digest, and lifetime provenance. Screenshot metadata is checked before and after capture. Descriptor and profile ownership use runtime instance identity plus PID start identity.

Phase 1.2 confirms exclusive nonce-bound browserd startup ownership, unique instance sockets, atomic profile locks, outer-root cleanup, transactional target publication, immutable capture identity through artifact commit, typed bounded DOM fallback, retry lookup before resource lookup, connection-bound frame retry semantics, idempotent artifact rollback, and session-before-owner quota order. Same-origin iframe DOM fallback is supported. Cross-origin out-of-process iframe fallback is not supported.

Phase 2A Gate 0 replaces stale filesystem ownership recovery with kernel-owned abstract AF_UNIX lifetime locks. It also makes artifact admission atomic, bounds terminal target history, settles in-flight captures, makes cleanup retryable, adds global capacity, validates operation-result resources, and reports truthful health. The routed integration binds trusted webxd actors, delivers verified screenshots as Pi image items, converts image pixels inside browserd, and rejects old sessions after daemon replacement.

Phase 2B adds production observation leases, practical motor timing, exact image GETs, route-aware idempotency, persistent UTF-8 transport, bounded subscription and client lifecycles, webxd restart rehydration, pinned runtime identity, stable public mutation IDs, functional branded egress health, explicit download denial, and process-isolated acceptance.

Phase 2B.1 confirms barrier-reproduced same-session overlap, one session capture coordinator, typed bounded screenshot recovery, non-cooperative close settlement, cleanup-final webxd shutdown, clean externally pinned evidence, 1,001-transaction Fedora Chromium contention, and a final-code uninterrupted 1,800-second soak. Production-default routing remains disabled and ADR-012 remains unresolved.

## ADR-018 through ADR-020: Phase 3A trusted read-only workspace

**Decision:** Add a distinct browserd workspace-broker role used only by trusted webxd, expose a separate authenticated `workspace.v1` Unix gateway to Tauri Rust, and deliver screenshot bytes to React as bounded Tauri-channel `ArrayBuffer` records. Qualify cross-agent viewing before adding any human control.

**Reason:** Aggregate viewing crosses actor boundaries and needs its own narrow authority. Descriptor discovery and secrets must remain outside JavaScript. Binary frames need latest-only backpressure without base64 or global events. Human input adds controller-epoch and action-settlement risks that are independent of viewing.

**Consequence:** Phase 3A is read-only. Tauri has no direct browserd connection; JavaScript has no socket, descriptor, secret, fetch, or WebSocket. Former-selection frames cannot paint after the measured switch barrier. Human takeover is a separate Phase 3B decision, production routing still defaults to `legacy`, and ADR-012 remains unresolved. See `ADR-018-TRUSTED-WORKSPACE-AUTHORITY.md`, `ADR-019-BINARY-TAURI-FRAME-DELIVERY.md`, and `ADR-020-READ-ONLY-BEFORE-TAKEOVER.md`.

## ADR-021 through ADR-023: Phase 3B private human control

**Decision:** Keep browserd as the sole mutation authority. Add compare-and-swap control epochs, connection-bound expiring leases, agent exclusion, one session input lane, and exact delivered-and-painted-frame admission. Keep raw leases in browserd and trusted webxd; keep only the private epoch, input target, frame binding, and sequence required for bounded requests in Tauri Rust. Give return, hide, close, emergency return, and shutdown an independent bounded lifecycle lane. Expose takeover and return only as fixed user launcher actions.

**Reason:** Workspace selection and received frames do not prove authority or what the user saw. Model work, stale desktop instances, reconnects, response loss, and input cleanup must all fail closed across an agent-user-agent ABA sequence. Return cannot depend on an ordinary queue that may be full or waiting for a fresh frame.

**Consequence:** Private protocols are `browser.v3` and `workspace.v2`; public WebX remains `3.0.0`. React receives no raw lease, epoch, internal identity, secret, descriptor, socket path, or retained input. Human control is absent from model tools. Tauri still connects only to webxd. Production routing remains `legacy` by default and the legacy runtime remains selectable. Phase 4A later resolves ADR-012 only for bounded canary use. See `ADR-021-BROWSERD-HUMAN-CONTROL-AUTHORITY.md`, `ADR-022-PAINTED-FRAME-PRIVATE-INPUT.md`, `ADR-023-FAIL-SAFE-RETURN-AND-USER-ENTRY.md`, and `PHASE3B-RESULTS.md`.

## ADR-024 through ADR-026: Phase 4A trust and deployment

**Decision:** Use independent ephemeral keyed semantic fingerprints for human-input retries; run one canonical webxd with distinct candidate proxy/browserd user services and on-demand Tauri; publish complete immutable releases selected by one atomic current/previous pointer with verified rollback.

**Consequence:** Human input is not retained, browser outages do not disable search/read, services never use checkout code, and candidate uninstall preserves legacy roots. See ADR-024 through ADR-026.

## ADR-027: Browser resource supervision

**Decision:** Supervise every Chrome process tree and disposable profile from browserd. Use process-start identity, PSS, private dirty, process and renderer counts, and symlink-safe profile bytes. Warn at soft limits. At a hard or global limit, fence new authority, settle operations and human control within bounded deadlines, close only the affected session, and require the actor to open a new session.

**Reason:** Earlier long evidence did not prove a Chrome plateau. Production containment must be deterministic without weakening one-process-per-session isolation or hiding browser loss behind an old session ID.

**Consequence:** Candidate defaults are 1,024/1,280 MiB per-session soft/hard PSS, 4,096 MiB global Chrome PSS, 512/1,024 MiB profile soft/hard, a 5-second sample interval, a 30-second drain budget, and a 15-second emergency close wait. Cleanup uses an isolated POSIX process session plus exact PID-start identities. Uncertain cleanup retains the profile. Private status is bounded and sanitized. Exact installed acceptance and the user-shortened fixed soak complete the Phase 4A canary gate; they do not authorize a default switch. See `ADR-027-BROWSER-RESOURCE-SUPERVISION.md` and `PHASE4A-RESULTS.md`.

## ADR-028: AgentCursor canary selection

**Decision:** Keep `legacy` as the repository and installed default. Enable AgentCursor only through the immutable controller as one process-level selection. Never permit request-level selection, fallback, or session remapping.

**Consequence:** Phase 4A qualification supports an explicit canary while preserving the legacy runtime and deterministic rollback. Any default cutover requires a separate Phase 4B decision. See `ADR-028-AGENTCURSOR-CANARY-SELECTION.md`.
