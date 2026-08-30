# Browser rebuild implementation plan

Each phase has one acceptance gate. Keep the old browser production path until the stated deletion gate passes. Do not add a permanent dual-backend abstraction.

## Phase 0 — architecture validation and technical spike

**Goal:** prove two isolated headed browsers, explicit CDP targets, screenshot-first observations, a visible human-style cursor, explicit DOM fallback, a repeated-frame viewer, and cleanup.

**Files/modules:** `spikes/screenshot-first-browser/`; `docs/browser-rebuild/`.

**Tasks:**

- Port pinned AgentCursor path and persona modules with license.
- Implement Chrome lifecycle, persistent CDP transport, explicit driver, observation guard, overlay, fixture, viewer, and measurements.
- Launch two sessions and reject cross-session target use.

**Tests:** `pnpm --filter @webx/screenshot-first-browser-spike verify`.

**Acceptance gate:** the complete proof exits zero and all requested documents exist.

**Deletions enabled:** none. Phase 0 is evidence only.

**Rollback:** remove the spike and documents. Production behavior is unchanged.

## Phase 1 — production browser runtime core

**Goal:** add a production-grade parallel runtime and a separate actor-bound Node daemon. Do not route production browser tools to it.

**Files/modules:** `packages/browser-protocol/`; `packages/browser-runtime/`; `apps/browserd/`; selected AgentCursor port and license; owner-scoped browser artifact integration.

**Tasks:**

- Generate strict executable protocol types and a deterministic JSON Schema from one TypeBox source.
- Run `browserd` as a separate persistent process from `webxd`.
- Bind each Unix-socket connection once to one principal and Pi agent session.
- Implement host/session/tab registries and full-address lookup.
- Add allowlisted Chrome launch policy, private temporary profiles, loopback endpoint checks, manifests, orphan cleanup, and close escalation.
- Implement one persistent browser CDP connection, explicit flattened target sessions, popup registration, page lifecycle, and target crash detection.
- Use one persistent persona, cursor, and serialized input lane per browser session. Keep document, viewport, observation, frame, overlay, and handle state per tab.
- Keep explicit PNG agent observations separate from bounded workspace frame scheduling.
- Add bounded artifacts, DOM handles, operation records, absolute deadlines, cancellation, post-path revalidation, and control epochs.
- Keep user takeover disabled while testing epoch changes internally.
- Default production navigation to deny unless a `NavigationAuthorization` is configured.

**Tests:** strict schema conformance; Unix transport binding, framing, modes, and cleanup; two actor-bound browser sessions; two tabs in one session; shared persona and serialization; cross-session concurrency and isolation; stale document, viewport, and scroll; explicit DOM fallback; intermediate cursor frames; cancellation and partial dispatch; target close and crash; Chrome exit and CDP disconnect; flag policy; profile modes; no warm process spawn; 30-minute PSS resource soak.

**Acceptance gate:** unit and live tests pass on configured Fedora Chromium. Google Chrome is tested only when it is already installed or explicitly configured. Two sessions and three tabs complete a genuine 30-minute run with bounded artifacts, operations, frames, handles, no leaked profiles, and recorded Linux PSS, CPU, event-loop, latency, and disk evidence.

**Deletions enabled:** none. The current Rust browserd, backends, browser protocol, Tauri workspace, and `webxd` adapter remain unchanged and unrouted.

**Rollback:** stop and remove the new parallel packages and daemon. Production behavior is unchanged.

### Phase 1.1 — pre-cutover adversarial hardening

**Status:** implementation, deterministic tests, Fedora Chromium live gate, and uninterrupted 30-minute soak passed on `rebuild/screenshot-first-browser`. Production remains unrouted.

**Completed work:** abort-safe CDP state; bounded pressed-input cleanup; one runtime profile manager; PID-start-safe profile and descriptor identity; connection- and epoch-scoped frame subscriptions; canonical operation fingerprints; typed sanitized errors; artifact provenance and fair quotas; pre/post screenshot consistency; lifecycle rollback and dispatch truth; adversarial live and resource gates; ADR-011 trust boundary.

**Evidence:** `PHASE1-1-RESULTS.md`, `evidence/phase1-1-live-results.json`, and `evidence/phase1-1-soak-results.json`.

**Handoff disposition:** the fresh Phase 1.2 independent audit superseded this gate. It reproduced blocking findings. Phase 1.2 corrected them and reran all acceptance gates.

### Phase 1.2 — independent-audit corrections

**Status:** complete on `rebuild/screenshot-first-browser`. The fresh independent audit reproduced blocking correctness findings. All corrections, deterministic tests, Fedora Chromium live verification, a fresh uninterrupted 30-minute soak, and a fresh uninterrupted two-hour soak passed. Production remains unrouted.

**Completed work:** exclusive nonce-bound browserd startup ownership and unique sockets; atomic ownership-safe profile locking and outer-root cleanup; transactional tab and popup publication; immutable screenshot and frame identity through artifact commit; post-guard cancellation and truthful drag release; typed bounded cancellable DOM fallback; retry resolution before resource lookup; connection-bound frame retry semantics; idempotent artifact rollback; session-before-owner quota order; per-process-tree resource evidence.

**Evidence:** `PHASE1-2-RESULTS.md`, `evidence/phase1-2-live-results.json`, `evidence/phase1-2-soak-results.json`, and `evidence/phase1-2-soak-2h-results.json`.

**Resource decision:** the two-hour run did not prove a PSS plateau. Phase 2 development can begin behind its reversible switch. Production-default routing requires either credible representative plateau evidence or a tested bounded Chrome session recycling and recovery policy. Do not change one-process-per-session isolation only to reduce PSS.

## Phase 2A — native Pi screenshot route behind one switch

**Status:** implementation and deterministic integration are complete on `rebuild/screenshot-first-browser`. The required 30-minute routed soak and final acceptance record close this development gate. Production-default routing remains disabled.

**Goal:** make the replacement runtime serve real native Pi browser tools while search and read remain independent.

**Files/modules:** `apps/webxd/src/browserd-client.ts`; `apps/webxd/src/agentcursor-browser-port.ts`; `apps/webxd/src/browser-backend-selection.ts`; `apps/webxd/src/authority.ts`; `apps/webxd/src/runtime.ts`; `apps/pi-webx/`; `packages/sdk/`; `packages/browser-protocol/`; `packages/browser-runtime/`; `apps/browserd/`.

**Completed work:**

- Corrected the Phase 2A Gate 0 lifecycle, capacity, capture, cleanup, health, and resource races before route integration.
- Added the secure trusted webxd browserd descriptor and persistent actor-bound Unix transport.
- Added immutable `WEBX_BROWSER_BACKEND=legacy|agentcursor`, with `legacy` as the default and no per-request fallback.
- Moved the public browser contract to major 3 and added the truthful `agentcursor/chrome` path.
- Added signed explicit navigation authorization and fail-closed proxy egress.
- Made Pi observation screenshot-first with one verified multimodal image and no base64 in model text or compact details.
- Added image-pixel coordinate conversion inside browserd against the exact cited observation.
- Added explicit bounded DOM fallback, explicit tabs, cancellation, actor isolation, and browserd restart truth.
- Added CI-safe route fixtures and an opt-in native Pi to headed Chromium route and routed soak.

**Tests:** protocol, runtime, browserd, Gate 0, browserd client, webxd authority and backend selection, SDK contract, Pi schema and presentation, two-actor native Pi headed route, and 30-minute integrated routed soak.

**Acceptance gate:** all Phase 2A deterministic and headed tests pass. Search and read stay healthy without browserd. Old sessions fail explicitly after browserd replacement. The branch contains the requested evidence and remains clean. This gate permits later staged development. It does not satisfy ADR-012 or enable production-default routing.

**Deletions enabled:** none in Phase 2A. Keep the legacy stack installed and selectable until a later release-candidate and resource gate authorizes deletion.

**Rollback:** start webxd with `WEBX_BROWSER_BACKEND=legacy`. Selection is immutable for the process. No request can switch or fall back to the other backend.

## Phase 2B — route usability, idempotency, and stream foundation

**Status:** complete on `rebuild/screenshot-first-browser`, as superseded and qualified by Phase 2B.1. The earlier post-review screenshot timeout led to session capture arbitration and a new final-code 30-minute gate. Production-default routing remains disabled.

**Goal:** close routed correctness and usability defects before Tauri work.

**Completed work:**

- Added separate bounded 60-second production screenshot and DOM leases with monotonic expiry and exact public `validUntil`.
- Corrected human motor replay to practical latency while preserving sampled persona behavior and post-path revalidation.
- Removed images from general WebX idempotency and removed full screenshot buffers from webxd session bindings.
- Added exact actor/session/tab/observation image GET and complete byte, digest, media, and dimension verification.
- Added persistent UTF-8 decoding, independent transport bounds, bounded cancellation/backpressure, and durable subscription teardown.
- Bound webxd actor identity and resource limits to each client socket while browserd-owned sessions survive disconnect.
- Rehydrated actor sessions after webxd restart, pinned descriptor-dependent work to one browserd runtime, and rejected old sessions after replacement.
- Propagated stable public operation IDs through all mutations and replaced internal time/random IDs with cryptographic IDs.
- Added functional branded proxy health, egress binding agreement, strict CONNECT parsing, IPv6 Host formatting, and browser-wide download denial.
- Added process-isolated browserd, webxd, Pi harness, deterministic page, and test-only proxy acceptance plus a 30-minute soak.

**Evidence:** `PHASE2B-RESULTS.md`, `ADR-015-OBSERVATION-LEASE-AND-MOTOR-TIMING.md`, `ADR-016-SCREENSHOT-TRANSFER-AND-IDEMPOTENCY.md`, and `evidence/phase2b-*-results.json`.

**Acceptance gate:** production-default delayed clicks work; stale state fails closed; motor p95 is below 2.5 seconds; image bytes in general idempotency and long-lived webxd buffers are zero; exact concurrent images, fragmented UTF-8, long-lived streams, binding cleanup, webxd rehydration, browserd replacement, stable close retry, proxy health, download denial, process isolation, and cleanup pass. Search/read stay healthy during browser outages.

**Deletions enabled:** none. Keep the legacy stack and immutable service switch.

**Rollback:** start webxd with the default `WEBX_BROWSER_BACKEND=legacy`. No request can select or fall back to AgentCursor.

### Phase 2B.1 — capture arbitration and final qualification

**Status:** complete on `rebuild/screenshot-first-browser`. Final runtime and harness code `79254d6b30267432e35bec67cdb053aba59f322f` passed deterministic gates, Fedora Chromium contention, the process-isolated route, and an uninterrupted 1,800-second soak from a clean externally pinned tree.

**Completed work:** barrier-driven overlap reproduction in both orderings; one coordinator per browser session for complete observation and frame transactions; bounded agent FIFO, coalesced frame intents, and bounded fairness; typed CDP command timeout identity; at most one safe read-only agent screenshot retry; frame timeout drop; bounded diagnostics; abort-aware close settlement; cleanup-final retryable webxd shutdown with replacement socket safety; pinned bounded qualification and automatic failure evidence.

**Evidence:** `PHASE2B1-RESULTS.md`, `ADR-017-SESSION-CAPTURE-ARBITRATION.md`, and `evidence/phase2b1-*-results.json`.

**Acceptance gate:** same-session maximum capture concurrency is one; cross-session concurrency occurs; no agent capture is silently replaced; timeout recovery is typed and bounded; failed attempts publish nothing; webxd cleanup is all-stage; contention, process, and uninterrupted 30-minute routes pass with zero unrecovered screenshot failures, general-cache image bytes, held input, or cleanup leaks.

**Deletions enabled:** none. Keep the legacy stack and immutable service switch.

**Handoff:** Phase 3 development may begin as a separate task under the existing trusted-workspace boundary. ADR-012 and later deployment gates still block production-default routing.

## Phase 3A — trusted read-only Tauri workspace

**Status:** complete on `rebuild/screenshot-first-browser`. Frozen production and harness code `7ae05ad6f747f42790d579ab168b9b7fba6f0214` passed the real Tauri graphical route and an externally pinned, clean-tree, uninterrupted 1,803.144-second soak.

**Goal:** replace the legacy workspace with a local multi-agent screenshot viewer while keeping cross-agent view authority separate from browser control.

**Delivered:** private `browser.v2` actor/workspace role separation; separate `workspace.v1` package; sanitized aggregate snapshots; exact connection-scoped frame subscriptions and ledgers; authenticated private webxd gateway; secure Rust descriptor client; raw Tauri-channel `ArrayBuffer` frames; bounded React canvas viewer; user-only show/hide/attach; single instance; actual Tauri evidence.

**Acceptance:** two agents and isolated Chromium sessions are listed and selectable; tabs update; virtual-cursor intermediate frames paint; webxd restart preserves visibility; browserd replacement invalidates old sessions; zero stale or cross-agent paints; bounded binary queues; full cleanup. See `PHASE3A-RESULTS.md` and ADR-018 through ADR-020.

**Boundary:** Phase 3A has no human takeover, Tauri browser input, cancellation, model-facing workspace tool, or direct Tauri-to-browserd connection. Production routing remains `legacy` by default.

**Deletions completed:** the old workspace RPC, descriptor frontend command, fixtures, model, viewport, human-input paths, base64 transport, and legacy tests listed in `PHASE3A-LEGACY-WORKSPACE-SURGERY.md`.

**Rollback:** do not launch the workspace and start webxd with the default `legacy` backend. The legacy browser runtime remains installed and selectable.

## Phase 3B — human-control authority

**Status:** deferred. Do not infer authorization from Phase 3A.

**Goal:** add safe user takeover and return only after separate controller-epoch, queued/running action settlement, interrupt, and agent-user-agent ABA design and qualification.

**Entry recommendation:** first reduce or explicitly accept the Phase 3A post-browser-replacement capture latency and stable switch-latency gap. Then perform a fresh security and graphical acceptance phase for input authority.

## Phase 4 — Fedora deployment, recovery, and performance

**Goal:** ship the runtime reliably on the supported Fedora desktop.

**Files/modules:** `install/profiles/browser.json`; `install/profiles/full.json`; installer/uninstaller; systemd user units; doctor; operations documents; CI.

**Tasks:**

- Package the pinned Node runtime, browser protocol, license, and Tauri app.
- Prefer Google Chrome and support configured Chromium.
- Validate graphical session, executable, runtime/socket/profile modes, loopback CDP, effective launch flags, and browser version.
- Add startup cleanup for verified orphan profiles.
- Add crash diagnostics without secrets.
- Tune selected and idle frame rates, image encoding, artifact limits, and memory limits from measurements.
- Test Wayland, X11, fractional scale, and two monitors for viewing. Do not claim OS pointer control.

**Tests:** clean Fedora install; upgrade; uninstall; staged cutover/rollback; reboot; Chrome crash; authority crash; no display; missing browser; full disk/profile failure; two-session CPU/memory soak; socket and profile permission tests.

**Acceptance gate:** staged install and rollback pass on Fedora. Two sessions meet reviewed resource limits. Doctor detects each required misconfiguration.

**Deletions enabled:** obsolete Rust toolchain and browser-only Cargo entries; old version pins, deployment profiles, and operations text.

**Rollback:** install the previous immutable candidate and restore its user units. Preserve no disposable browser profile as user data.

## Phase 5 — old stack deletion and repository simplification

**Goal:** remove the old browser implementation and make one architecture authoritative.

**Files/modules:** all paths marked “delete after replacement” in `REPO-SURGERY.md`; root workspace files; current docs.

**Tasks:**

- Confirm Phase 1–4 gates against the exact deletion commit parent.
- Remove old crates, adapters, PinchTab, duplicate protocols, old fixtures, stream viewer, and stale documents.
- Move retained reader/document services out of a misleading browser component directory if useful.
- Remove the temporary backend selection switch.
- Update README, install profiles, CI, and ownership documents.

**Tests:** full repository lint, type-check, unit, deterministic browser proof, native Pi end-to-end, Tauri contract, Fedora package smoke, and search/read regression.

**Acceptance gate:** one clean install has one browser runtime and no old executable, service, adapter, protocol, or undocumented fallback. All acceptance tests pass.

**Deletions enabled:** the full list in `REPO-SURGERY.md`. The Phase 0 spike can be archived to a tag or removed after its tests are represented in production.

**Rollback:** revert the focused deletion commit or deploy the prior immutable candidate. Do not reintroduce individual old modules piecemeal.

## Phase 6 — optional Linux OS pointer research

**Goal:** decide whether trusted OS-level input is worth its permissions and coordinate risk.

**Files/modules:** a separate experimental driver package. No change to default CDP input.

**Tasks:** compare Wayland portal/compositor options and X11 XTest; define explicit enablement; map browser CSS to global display coordinates; design user interrupt; test multi-monitor and fractional scale.

**Tests:** foreground-window mismatch, monitor transitions, scale changes, user movement during action, permission denial, and emergency stop.

**Acceptance gate:** an explicit product decision with security and usability evidence. This phase is optional.

**Deletions enabled:** none.

**Rollback:** remove the optional driver. CDP virtual mouse remains the supported default.
