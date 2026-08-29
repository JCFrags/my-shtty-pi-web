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

## Phase 2 — native Pi extension and authority cutover behind one switch

**Goal:** make the new runtime serve real native Pi browser tools while keeping search and read independent.

**Files/modules:** `apps/webxd/src/authority.ts`; `apps/webxd/src/runtime.ts`; `apps/webxd/src/browser-daemon-port.ts`; `apps/pi-webx/src/index.ts`; `apps/pi-webx/src/schemas.ts`; `apps/pi-webx/skills/webx/SKILL.md`; `packages/sdk/`.

**Tasks:**

- Connect `webxd` to the separate long-lived `browserd` Unix service. Do not import the full runtime into `webxd`.
- Add actor-specific trusted-service attestation and bind one `webxd` connection to one actor.
- Replace browser SDK types with full target-aware messages.
- Make screenshot observation the primary `browser_observe` response.
- Expose DOM fallback as an explicit observe mode or separate internal operation.
- Return operation IDs and support status/cancel.
- Pass authenticated Pi owner and lifecycle session context to every call.
- Add one temporary deployment switch that selects old or new runtime at service start. Do not select per operation.

**Tests:** native Pi tool schema tests; end-to-end Pi extension fixture flow; concurrent Pi sessions; wrong owner/session/target/epoch; old-observation rejection; deadline and cancellation; search/read health with Chrome absent; no MCP process; no per-action process.

**Acceptance gate:** the new route passes all browser acceptance tests and real Pi uses it by default in a staged installation. Search/read tests pass with browser disabled.

**Deletions enabled:** `components/browser/crates/browserd/`, `backend-core/`, `backend-agent-browser/`, `backend-pinchtab/`, old backend scripts and tests, and browser daemon port code after one release-candidate soak.

**Rollback:** switch service selection back to the old route and restore the prior package set. Do not keep runtime fallback inside a request.

## Phase 3 — production Tauri workspace and human control

**Goal:** replace the spike viewer with a local screenshot workspace and safe user takeover.

**Files/modules:** rewrite `components/browser/apps/workspace/` or move it to `apps/browser-workspace/`; browser frame subscription; control operations.

**Tasks:**

- Render only local UI and screenshot bytes.
- List and select full session/tab identities.
- Show connected state, URL, frame age/sequence, controller, and cursor.
- Add latest-frame backpressure and selected-session frame priority.
- Implement takeover/return as authority operations that increment control epoch.
- Cancel stale queued agent work and handle the agent-user-agent ABA case.
- Authenticate workspace transport without URL tokens.

**Tests:** session switch race; closed-session frame clearing; cross-agent frame read rejection; slow consumer; reconnect; takeover during queued and running actions; return; stale-epoch rejection; no remote page navigation in the Tauri webview.

**Acceptance gate:** a user can switch between two live sessions, see repeated cursor-bearing frames, take and return control, and never cause an old agent action to execute after an epoch change.

**Deletions enabled:** `components/browser/tools/stream-viewer/` and the old workspace model, viewport, RPC, and browser-specific Rust command code.

**Rollback:** restore the old workspace package. Runtime and Pi browser control remain usable without a workspace.

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
