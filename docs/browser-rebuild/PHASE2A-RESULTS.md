# Phase 2A results

## Outcome

Phase 2A connects the screenshot-first browser runtime to trusted webxd, WebX SDK API major 3, and the native Pi extension behind one immutable startup switch.

The new route is `agentcursor/chrome`. It passed deterministic tests and the complete native Pi to headed Fedora Chromium route. Production-default routing remains disabled. `WEBX_BROWSER_BACKEND` still defaults to `legacy`. The legacy stack remains installed and selectable.

This phase does not implement Tauri. It does not satisfy the unresolved ADR-012 Chrome memory plateau gate.

## Scope and branch

- Branch: `rebuild/screenshot-first-browser`
- Required Phase 2A parent: `687a4cdf1d9240c4ccb024cb161caff7578616ae`
- Browser tested: Fedora Chromium `151.0.7922.173`
- Google Chrome: not installed and not tested
- New public path: `agentcursor/chrome`
- Public API: `3.0.0`, major `3`
- Public browser protocol: `3.0.0`
- Private browserd protocol: `browser.v1`

## Gate 0 findings and corrections

Gate 0 completed before webxd and Pi route integration.

| Area | Starting finding | Correction | Deterministic evidence |
|---|---|---|---|
| Lifecycle ownership | Descriptor and profile stale recovery used filesystem check-then-unlink races. | Added process-held abstract AF_UNIX ownership sockets derived from UID, canonical root, and owner-only persistent key. Service and profile cleanup use separate locks. Unsupported platforms fail closed. | Competing child processes, owner kill, immediate and simultaneous successors, delayed former release, cleanup races, unsupported platform, and leak checks. |
| Surviving Chrome profile | A dead browserd marker could allow deletion before exact Chrome settlement. | Verify manifest, runtime and launch identity, PID start ticks, executable, and exact profile argument. Use bounded TERM then KILL. Preserve unverifiable profiles. | Exact child, reused PID, wrong executable or command line or start ticks, starting grace, retained unverifiable root, exact settlement, and no unrelated signal. |
| Artifact admission | Digest work occurred outside atomic quota admission. | Copy and digest first, then re-prune, recheck every quota, pin bound, count, and byte limit in one serialized commit section without another await. | Hundreds of concurrent same-session, same-owner, and cross-owner puts; digest failure; cancellation; exact observed limits; fair non-eviction. |
| Terminal targets | Closed and crashed targets could accumulate in the authoritative map. | Emit one complete immutable terminal event, remove all authoritative mappings, and retain no unbounded terminal history. | Thousands of close and crash cycles, popup cycles, complete cleanup identity, baseline maps, and closed-target rejection. |
| Frame capture settlement | A late screenshot could insert or emit after unsubscribe, epoch change, or close. | Each schedule owns generation, abort controller, in-flight promise, consumers, and closed state. Every close path aborts and settles capture, then checks generation before insert, pin, sequence, emit, or rearm. | Barriers after capture and artifact insertion for final unsubscribe, connection close, epoch change, tab close, session close, and scheduler close. |
| Retryable cleanup | Partial cleanup failure could make later close a no-op or leave a discoverable dead endpoint. | Added shared close attempts and residual retry. Session, Chrome host, runtime, and server attempt every cleanup stage and aggregate failures. Descriptor, socket, and ownership release run in final cleanup. | Failure at every stage, concurrent close, repeated close, runtime rejection, resource removal, replacement preservation, one-shot server, and new-instance restart. |
| Capacity, resources, and health | Global session capacity, transactional subscription rollback, result-resource validation, screenshot layout cancellation, and health truth were incomplete. | Added global capacity, transactional insertion, resource revalidation, AbortSignal propagation, and executable, display, profile, egress, closing, and capacity health checks. | Gate 0 runtime and server suites cover every added bound and health state. |

Gate 0 commits:

- `ef213fc fix(browser-core): use kernel-owned lifecycle locks`
- `77d14e6 fix(browser-runtime): settle captures and terminal cleanup`
- `a58a572 test(browserd): close the Phase 2A Gate 0`

## Public contract and Pi image delivery

`packages/sdk` now exposes explicit browser sessions and tabs, screenshot observations, DOM fallback observations, coordinate spaces, and only implemented actions. It does not expose CDP target IDs or private runtime state.

`browser_observe` defaults to screenshot. Webxd reads the browserd artifact in bounded chunks. It verifies canonical base64, complete byte count, media type, and SHA-256. The facade moves bytes through `artifactPayload`. Pi presentation emits exactly:

- one bounded text content item with untrusted metadata;
- one real image content item;
- no image base64 in text or compact details.

The live result returned PNG images for both actors. `docs/browser-rebuild/evidence/phase2a-live-results.json` records their actual byte counts and media types.

## Coordinate proof

The native Pi schema defaults coordinate actions to `imagePixels`. Browserd resolves the cited real observation and converts with the exact recorded image and CSS viewport dimensions. It validates source bounds and applies the same rule to both drag endpoints.

The headed route used DPR 2. The CSS button center was `[190,126]`. Pi clicked image pixel `[380,252]`. The correct isolated target changed to `alpha count 1`. The other actor independently changed its own target to `beta count 1`.

Deterministic tests also cover DPR 1, DPR 1.25, DPR 2, fractional dimensions, edge and out-of-bounds points, stale observations, drag conversion, decoded image dimensions, and target hit.

## Backend switch and actor authority

`WEBX_BROWSER_BACKEND` is read once when webxd starts:

- unset or `legacy`: old production adapter and only the legacy path;
- `agentcursor`: new browserd client and only `agentcursor/chrome`.

There is no request field for backend selection. There is no fallback or cross-backend retry.

AgentCursor mode securely validates the fixed descriptor, private runtime directory, PID start identity, unique socket, modes, and protocol. It keeps one bounded persistent browserd connection per `AuthorityActor`. Binding uses the authenticated principal and Pi agent session exactly once. Pi never receives the descriptor, binding secret, broker signing secret, socket, CDP endpoint, profile path, or proxy configuration.

The live route bound two actors and proved distinct browser session IDs, Chrome PIDs, temporary profiles, personas, and tabs. Cross-owner session, tab, observation, handle, operation, and artifact access use non-enumerating failures.

## Explicit DOM fallback and tabs

DOM fallback runs only after `browser_observe` with `mode: dom`. It returns bounded document-scoped opaque handles. Pointer-based DOM actions use the same sampled session motor. The live route typed `alpha isolated`, advanced the human path sequence, and showed no value in actor B.

The live route created, listed, focused, and closed an explicit second tab. No request uses active-window or active-tab authority.

## Navigation and egress

Webxd validates and resolves every explicit initial URL, navigation, and URL-bearing new tab. It rejects local, private, reserved, link-local, and mixed answers. It then signs a 15-second authorization bound to runtime instance, actor, stable operation ID, normalized URL, egress binding, expiration, and nonce. Browserd verifies the complete binding before dispatch.

Production Chrome requires the reviewed loopback forward proxy. Chrome has no implicit loopback bypass and has QUIC and non-proxied WebRTC UDP disabled. The proxy rejects local names, credentials, non-public and mixed DNS answers, and pins each connection to a validated IP. Redirect, click, form, script, and popup requests therefore receive the same connection-bound destination check. Session creation fails closed when the new backend has no healthy egress route.

Browserd also closes committed file and unsupported external-protocol targets. HTTP(S), `about:blank`, and bounded Chromium error state are allowed because the network proxy is the private-destination boundary.

The opt-in headed test uses source-level loopback-only fixture authority. Production cannot enable that fixture policy.

### Security review disposition

Two independent reviews reported three candidate blockers. Two reproductions showed that the target registry can retain a syntactically valid private HTTP(S) URL. This is expected at the target-monitor layer: the required monitor permits HTTP(S), while the connection-bound proxy denies the private connection before it reaches the destination. The registry is not a DNS or socket authority. Secure proxy tests reproduce private literal and mixed-answer denial plus validated-IP pinning.

The third reproduction created a blank session through the legacy rollback adapter without new egress readiness. Phase 2A keeps the legacy production stack unchanged by directive. The fail-closed session rule applies to the new `agentcursor` route, whose `createSession` always calls `assertReady`, including an `about:blank` start. No request can cross from the legacy backend to AgentCursor.

No reproduced acceptance blocker remains in the new route. ADR-014 records the layer boundary and the residual same-UID trust assumption.

## Restart and service independence

Webxd detects `runtimeInstanceId` replacement, closes old actor connections, and rejects old sessions with explicit instance-replaced or non-enumerating unavailable state. It never recreates or remaps an old session. The agent must open a new session.

The headed route stopped browserd, rejected the old session, and opened a new session after replacement. Search succeeded while browserd was absent. Browser capability became unavailable without disabling search, read, content, cache, or artifacts.

## Cancellation, retry, and cleanup

Cancellation removes only the caller waiter and sends `operation.cancel` for admitted work. The live path-cancellation case settled with zero held buttons and keys. Deterministic tests cover screenshot cancellation and partial-dispatch truth.

The WebX idempotency key supplies stable browserd mutation identity. Exact retry causes one side effect. Each wire attempt uses a new request ID. Screenshot bytes do not enter the general 15-minute WebX idempotency cache.

The live route removed all session profiles, the browserd descriptor, and the webxd socket. Browserd shutdown closes actor connections and bounded subscriptions. Warm actions did not launch Node, MCP, CLI, or browser processes.

## Verification commands and counts

Normal graphical-browser-free checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:browser-core
pnpm --filter @webx/browserd test:adversarial
pnpm --filter @webx/browserd test:gate0
components/browser/.venv/bin/python -m pytest -q components/browser/tests/reader/test_secure_egress_proxy.py
git diff --check
```

Recorded counts:

- repository tests: 353 passed;
- browser protocol: 8 passed;
- browser runtime: 103 passed;
- browserd normal: 7 passed;
- browserd adversarial groups: 12 plus 83 passed;
- Gate 0 groups: 16 plus 75 passed;
- webxd: 110 passed;
- SDK: 14 passed;
- native Pi extension: 19 passed;
- secure egress proxy: 7 passed.

Opt-in headed checks:

```bash
pnpm --filter @webx/webxd test:live-agentcursor
pnpm --filter @webx/webxd test:routed-soak
```

The routed-soak script fixes duration at 1,800 seconds and sample interval at 15 seconds.

## Routed soak

The uninterrupted routed soak used two actors and two browser sessions. It repeatedly exercised native Pi screenshot observation, image-pixel motor actions, explicit DOM fallback, tab churn, exact retries, forced browserd connection loss and reconnect, transient actor pool eviction, artifact reads, search, read, and final cleanup.

The authoritative complete result is `docs/browser-rebuild/evidence/phase2a-routed-soak-results.json`. The live file also embeds the same `routedSoak` object.

The harness hosts webxd and browserd in one Node test process. Its heap value is therefore a truthful combined harness value, not separate daemon heap. Each Chrome process-tree PSS and private dirty value is measured separately from `/proc/*/smaps_rollup`.

The soak asserted two sessions and two baseline tabs at every sample, no artifact count above 256, no operation count above 2,048, zero held input at completion, full requested duration, and enough 15-second samples.

Recorded summary:

| Metric | Result |
|---|---|
| Duration | 1,801.842 seconds requested 1,800 |
| Workload | 355 iterations; 1,774 timed Pi/WebX requests |
| Samples | 121 at 15-second interval |
| Pi/WebX request latency | median 129.742 ms; p95 5,259.285 ms; max 5,331.397 ms |
| Screenshot route latency | median 65.515 ms; p95 211.411 ms; max 1,885.785 ms |
| Browserd screenshot dispatch | median 60.849 ms; p95 207.047 ms |
| Browserd artifact read | median 0.076 ms; p95 0.186 ms; max 0.524 ms |
| Human path route | median 5,214.985 ms; p95 5,272.468 ms |
| Explicit DOM fallback | median 8.079 ms; p95 9.729 ms |
| Periodic search/read | median 0.326 ms; p95 0.565 ms |
| Combined webxd/browserd harness heap | 25,930,208 to 39,216,104 bytes; range 24,112,768 to 40,805,848 |
| Chrome A tree PSS | 442,068 to 439,810 KiB; range 428,356 to 442,068 |
| Chrome A private dirty | 222,748 to 227,528 KiB; range 215,188 to 229,264 |
| Chrome B tree PSS | 405,816 to 408,594 KiB; range 390,162 to 409,968 |
| Chrome B private dirty | 193,836 to 200,440 KiB; range 181,684 to 201,832 |
| Chrome process count | 12 to 12 for each tree |
| Browserd actor connections | range 2 to 4; ended 3 |
| Sessions and baseline tabs | exactly 2 and 2 at every sample |
| Operation records | range 20 to 624; ended 618; below 2,048 |
| Artifacts | range 4 to 138 and 89,593 to 3,240,220 bytes; below 256 entries |
| Dropped frames | 0 |
| Profile bytes during work | 8,738,276 to 17,333,687; all session profiles removed during final cleanup |
| Churn and recovery | 29 tab cycles; 35 exact retry calls; 1 forced reconnect; transient actor idle eviction exercised |

These values show that the bounded stores and routed workload stayed inside their Phase 2A limits. They do not prove a longer Chrome or Node memory plateau.

## Remaining gaps and recommendation

Phase 2A does not resolve the prior two-hour Chrome PSS plateau concern. Do not use the 30-minute routed soak to claim a plateau. ADR-012 still blocks production-default routing.

Google Chrome was not installed. Current headed evidence covers Fedora Chromium only. Tauri workspace, user takeover, production packaging and service supervision, fractional desktop scaling, multiple monitors, and cross-origin out-of-process iframe DOM fallback remain later work.

Recommended next work:

1. Keep production default on `legacy`.
2. Proceed to Phase 3 for the local Tauri screenshot workspace and explicit human takeover only after this branch is reviewed.
3. In parallel, design and test bounded Chrome session recycling or collect stronger representative plateau evidence for ADR-012.
4. Package and supervise the secure egress proxy before any staged AgentCursor service deployment.
