# Phase 2B results

## Outcome

Phase 2B implements the routed-browser usability, retry, transport, restart, egress, and stream-foundation corrections found after Phase 2A. The native screenshot route passed deterministic tests and the complete process-isolated acceptance route. Its original post-review long-soak gap is now superseded by Phase 2B.1 capture arbitration and final-code qualification. See `PHASE2B1-RESULTS.md`.

Production-default routing remains disabled. `WEBX_BROWSER_BACKEND` is immutable at webxd startup and still defaults to `legacy`. The legacy browser stack remains installed and selectable. Phase 2B does not implement Tauri and does not resolve the ADR-012 Chrome memory plateau gate.

## Scope and provenance

- Branch: `rebuild/screenshot-first-browser`
- Required Phase 2B parent: `28366921a09f4a460cc1ee52d9c864e91e5651b8`
- Browser: Fedora Chromium `151.0.7922.173`
- Google Chrome: not installed and not tested
- Production screenshot observation default: 60,000 ms
- Accepted screenshot and DOM TTL range: 10,000 through 120,000 ms
- Process evidence: `evidence/phase2b-process-route-results.json`
- Soak evidence: `evidence/phase2b-routed-soak-results.json`
- Headed integration evidence: `evidence/phase2b-live-results.json`

## Finding disposition

Every test named below was added after the required parent. The test reproduces the parent behavior or missing guarantee and passes with the listed correction commit.

| Finding | Parent reproduction and failing test | Root cause | Correction | Passing evidence | Commit |
|---|---|---|---|---|---|
| Production screenshot lease was 3 seconds | A simulated 10 or 30 second reasoning delay made `ObservationStore.guard` return `OBSERVATION_STALE`; normal service had no production TTL input. `phase2b-runtime.test.ts` exercises the default, expiry, bounds, and separate DOM lifetime. | A test-only freshness override hid the production default. | Added bounded service configuration, 60-second screenshot and DOM defaults, monotonic expiry, and exact wall `validUntil`. Structural and post-path guards remain mandatory. | Runtime tests plus the process route's 10.004-second delayed click. | `0ff5b28` |
| Ordinary motor paths took about 5.2 seconds | Phase 2A soak recorded 5,214.985 ms median. Motor metrics and delayed-CDP tests exposed serialized input acknowledgements. The first Phase 2B long soak reproduced 5,229.488 ms p95 in one background session. | Every sampled CDP input acknowledgement was serialized; background Chrome scheduling could delay acknowledgements by about five seconds. | Pipeline bounded acknowledgements, instrument each stage, disable background throttling and occlusion for the dedicated test/runtime process, and enable CDP focus emulation on each tab. Human path samples, dwell, overlay, cancellation, and post-path revalidation remain. | Final soak motor replay median/p95 760.615/1,225.191 ms with median 16 samples. | `0ff5b28`, `ba571d9` |
| Screenshot bytes entered general WebX idempotency | A large POST frame/observation response increased the old general mutation cache. `authority.test.ts` checks policy statistics and zero image bytes. | All successful POST and DELETE responses shared one 15-minute cache. | Added route-aware `durable-mutation`, `ephemeral-observation`, `image-read`, and `none` policies. Only durable small mutations enter the general map. | Deterministic authority test and final soak `imageBytesRetained: 0`. | `c7ee5b9` |
| Webxd retained one latest full screenshot per session | Concurrent tab observations overwrote `latestScreenshot`; no exact observation lifetime existed. `agentcursor-browser-port.test.ts` retrieves independent observations. | `SessionBinding` stored a session-wide `Buffer`. | Removed the buffer. POST observe returns metadata; an exact actor/session/tab/observation image read verifies canonical base64, complete length, digest, media type, and decoded dimensions. Metadata is bounded and expires with the observation. | Three concurrent process-route observations had distinct IDs, digests, and exact byte counts; diagnostics report zero retained image bytes. | `c7ee5b9` |
| Cached observation retries could outlive resources | Parent WebX could return an old successful observation response after observation, artifact, handle, or document expiry. | Cache retention was independent of browserd resource validity. | Observation routes are uncached at WebX. Exact retry is resolved and revalidated by browserd operation/resource state. Image reads always read the exact live artifact. | Runtime and authority stale-resource tests return typed stale/not-found failures. | `c7ee5b9` |
| NDJSON decoding and cancellation were chunk-unsafe | Splitting `雪` and emoji bytes across chunks corrupted browserd responses/events or webxd requests. Cancellation could bypass admission bounds. | A decoder was created per chunk and frame, incomplete-byte, pending, and outbound accounting were not independent. | Each connection owns one fatal persistent `TextDecoder`; frame, incomplete UTF-8, pending, and outbound bytes have separate limits. Aborts are checked before write; admitted cancellation uses one bounded cancel request and socket drain/backpressure is bounded. | Every multibyte split boundary passes for responses, URLs, titles, typed errors, and webxd request JSON. | `c4b2191`, `aa028ef` |
| Frame subscriptions could be idle-evicted or leak remotely | A live stream exceeded idle timeout and was pruned; lost unsubscribe response removed local retry state first. | Pool activity considered pending requests only; unsubscribe was not a shared teardown state. | Exposed subscription count, update activity on frames, protect open/tearing-down subscriptions, share duplicate close, and retain local state until commit. If confirmation is lost, close the complete actor connection so browserd removes remote subscriptions. | Process stream survived 1.5 seconds with a 1-second idle timeout; unsubscribe-loss test sends once and settles with zero sockets/subscriptions. | `c4b2191` |
| Webxd actor bindings lived for the process | A client disconnect left its binding reusable and maps could grow without bounds. | Binding state was not owned by the issuing socket. | Bound connections, live bindings, bind time, request count, queued requests, and outbound bytes. Remove the binding on socket close and reject cross-client reuse or replacement. Browserd retains browser ownership. | Fragmentation, cross-client, timeout, flood, disconnect, and same-actor rebind tests pass. | `aa028ef` |
| Webxd restart lost session usability and runtime identity could race | A new `AgentCursorBrowserPort` listed browserd sessions but `owned()` rejected them; descriptor A could be stored for a request executed by B. | Local bindings were required and descriptor inspection was separate from request admission. | Actor-scoped `session.list` rehydrates bindings. `owned()` can list lazily. Pinned request APIs bind descriptor-dependent signing and execution to one runtime connection; replacement purges sessions and observation metadata and retains bounded replaced-ID tombstones. | Process restart preserved browserd runtime and session screenshot/action usability; browserd replacement rejected the old session and accepted a new one. | `70e98aa` |
| Public close retries changed operation identity | Lost close-tab or close-session responses generated a new browserd operation on HTTP retry. | Browser port methods generated internal IDs instead of accepting the stable WebX ID. | Propagate stable operation IDs through close tab, close session, focus, create, actions, and cancellation. Genuinely internal IDs use `randomBytes`. | Lost-response test observes one injected drop and transparent exact retry with one side effect; process soak completed 36 retry pairs. | `70e98aa` |
| Browser health checked configuration, not proxy function | A dead or arbitrary listener could leave browser capability advertised. | Capability health only inspected browserd's configured egress flag. | Add a bounded branded local HTTP probe requiring status 204, empty body, and `WebX-Egress-Proxy: secure-egress/1`; require webxd/browserd binding agreement. Session create still probes independently. | Healthy, absent, malformed, stalled, restarted, and binding-mismatch tests pass; process capability disappeared during proxy outage and recovered. | `45a6be9` |
| Downloads were unsupported only by API shape | A page could start a Chrome download even though no public download tool existed. CONNECT parsing and IPv6 Host formatting also had edge cases. | Chrome had no browser-wide deny policy. | Require `Browser.setDownloadBehavior` with `deny` and events, monitor and cancel download starts, and fail closed if denial cannot be installed or cancellation fails. No caller path is accepted. Tighten CONNECT authority form and bracket IPv6 Host literals. | Deterministic anchor, attachment, script, popup/event tests and the process route report one denied event and zero files. | `45a6be9` |
| Phase 2A ran webxd and browserd in one test process | A same-process harness could not prove restart, socket, binding, or heap isolation. | The live route directly constructed both runtimes. | Added distinct browserd, webxd, deterministic page/proxy fixture, and Pi harness processes. Test-only loopback authority and response-loss injection exist only in the opt-in worker. | Process IDs are distinct; all required restart/outage/retry/cleanup scenarios pass. | `8970362` |
| Subscribe admission could become remote without a local handle | An admitted `frames.subscribe` timeout removed local state while a late browserd commit could retain the remote subscription. | Failure cleanup assumed an unconfirmed subscribe had no remote effect. | Keep cleanup-failed state and close the complete actor connection whenever subscribe admission cannot be confirmed. Browserd disconnect cleanup removes all remote subscriptions. | A deterministic lost-subscribe-response test observes one subscribe, connection close, and zero pool connections. | final review correction |
| Error response could omit operation identity | A failed response with the right request ID but no operation ID was accepted for a pending mutation. | Operation matching checked only when the response supplied an ID. | Require every non-bind response operation ID to equal the pending operation, including typed failures; otherwise reject and close the connection. | Success mismatch and missing-ID failure tests both return `INTERNAL_ERROR` and close the socket. | final review correction |
| Bracketed IPv6 webxd proxy URL was rejected | `new URL("http://[::1]:8877").hostname` returns `[::1]`, while the destination authority accepts normalized `::1`. | Webxd main passed URL hostname syntax directly to the authority. | Centralize proxy URL parsing and normalize bracketed IPv6 before construction. | Deterministic configuration tests accept IPv4 and bracketed IPv6 and reject private or credentialed proxy URLs. | final review correction |
| Lost-close unit test did not count effects | The mock threw after its first call and only asserted one unique operation ID, so two distinct backend attempts could still pass. | The test modeled transport loss but not browserd operation deduplication. | Model committed operation IDs in the fake backend; exact retry returns the original completion without another side effect. Add exact focus retry and operation-ID assertion. | Close-tab and close-session each dispatch twice with one stable ID and exactly one side effect; create/focus cache once; conflict stays 409. | final review correction |

## Observation lease and motor timing

The screenshot lease defaults to 60 seconds because it must cover model inspection, reasoning, transport, queueing, and visible pointer travel. It is long enough for normal model latency but remains bounded. Monotonic time controls admission and expiry; the public result exposes the exact corresponding wall-clock `validUntil`. DOM lifetime is configured separately with `BROWSERD_DOM_OBSERVATION_TTL_MS`.

Time never replaces identity checks. Actor, session, tab, target, document generation, viewport generation, control epoch, CSS dimensions, DPR, scroll, source bounds, deadline, and cancellation remain checked. Irreversible input repeats the relevant guard after movement.

Motor timing changed from Phase 2A's 5,214.985 ms median route path to the final Phase 2B soak:

| Metric | Phase 2A | Phase 2B final |
|---|---:|---:|
| Motor/route median | 5,214.985 ms | 760.615 ms motor replay; 789.382 ms action route |
| Motor/route p95 | 5,272.468 ms | 1,225.191 ms motor replay; 1,232.572 ms action route |
| Maximum motor replay | not used as gate | 1,724.915 ms |
| Nominal path median/p95 | not separated | 541.775 / 732.930 ms |
| Samples per path | not separately recorded | median 16; minimum 9 |
| Post-path guard p95 | not separated | 0 ms; max 1.034 ms |

The path remains visibly sampled and retains one persistent persona, overshoot, curvature, jitter, dwell, off-center targeting, overlay updates, cancellation boundaries, and post-path revalidation. Longer paths remain bounded by the existing absolute operation deadline rather than being forced to one duration.

## Screenshot transfer and retry lifetimes

The public flow is now:

1. POST screenshot observation returns metadata only.
2. GET `/v1/browser/sessions/<session>/tabs/<tab>/observations/<observation>/image` retrieves that exact image.
3. Webxd verifies the full artifact and decoded dimensions.
4. The SDK facade immediately presents the bytes through its image payload.
5. No full image remains in `SessionBinding` or the general idempotency cache.

Relevant default lifetimes are separate:

- durable WebX mutation idempotency: 15 minutes, bounded by 1,024 entries and 16 MiB;
- browserd operation results: bounded operation registry retention;
- screenshot observations: 60 seconds by default, configurable 10–120 seconds;
- DOM observations and handles: 60 seconds by default, separately configurable 10–120 seconds;
- screenshot image artifacts: readable only while the observation and exact artifact remain valid;
- workspace frame artifacts: short-lived two-artifact pinned ring per tab.

An operation record does not revive an expired observation, artifact, DOM observation, handle, or changed document. Ephemeral observation and image-read routes bypass the general response cache.

## Process-isolated acceptance

`evidence/phase2b-process-route-results.json` records:

- distinct Pi harness, browserd, and webxd PIDs;
- 60,000 ms production TTL with no test override;
- 10,004.351 ms actual delay followed by a successful 556.577 ms click route;
- 16 visible motor samples and 513.664 ms replay;
- three exact concurrent observations with distinct IDs, digests, and byte counts;
- explicit DOM fallback;
- frame delivery beyond idle timeout and settled teardown;
- Pi disconnect/rebind;
- webxd restart with browserd runtime preservation and session rehydration;
- browserd replacement with old-session rejection and new-session success;
- functional proxy health loss and recovery;
- search/read success during browserd and proxy outage;
- download denial with no file;
- exact close retry after injected response loss;
- zero image bytes in general idempotency and webxd image retention;
- zero profiles, child processes, subscriptions, held input, artifacts, sockets, and descriptors after cleanup.

## 30-minute process soak and post-review status

The uninterrupted soak at `ba571d9` ran 1,800.594 seconds for a requested 1,800 seconds. It used two actors, two Chrome sessions, two tabs in one session, screenshot observations and exact image reads, delayed actions, DOM fallback, long-lived frame streams, reconnect, one webxd restart without browserd restart, tab churn, exact close retries, and search/read traffic.

| Metric | Result |
|---|---|
| Workload | 360 iterations; 720 screenshots; 703 actions; 240 DOM observations; 120 search/read calls |
| Samples | 121 at 15-second requested interval |
| Delayed actions | 15 attempts, 15 successes; model-delay median 10,001.547 ms |
| Screenshot plus image route | median 43.820 ms; p95 507.081 ms; max 1,551.623 ms |
| Action route | median 789.382 ms; p95 1,232.572 ms; max 1,733.117 ms |
| DOM fallback route | recorded in evidence |
| Motor replay | median 760.615 ms; p95 1,225.191 ms; max 1,724.915 ms |
| Motor nominal | median 541.775 ms; p95 732.930 ms |
| Webxd restart / Pi reconnect | 1 / 1 |
| Tab cycles / exact close retry pairs | 30 / 36 |
| General durable idempotency | 475 entries; 283,984 bytes |
| General image bytes | 0 |
| Final observation metadata | 22 entries; 21,130 bytes |
| Final subscriptions | 0 |
| Held input | zero buttons and keys in both sessions |
| Final cleanup | all session profiles, sockets, descriptor, processes, and artifacts removed |

The evidence separately records webxd heap, browserd heap, actor connections, operations, artifacts, profile bytes, and each Chrome process tree's PSS and private dirty memory. This 30-minute run does not establish a long-term Chrome plateau. ADR-012 remains unresolved.

Final review then produced `9edd31d`, which closes unconfirmed subscribe admission, missing error-response operation identity, bracketed IPv6 proxy configuration, weak lost-close side-effect assertions, and three lint findings. All deterministic gates and the complete no-soak process route pass on `9edd31d`. At the user's direction, the first replacement soak was shortened to 120 seconds. That attempt stopped on one retryable `CDP_ERROR` timeout from `Page.captureScreenshot` and produced no replacement evidence file. Cleanup left no process.

Phase 2B.1 started exactly from the pushed Phase 2B baseline `8504bd0f4d559cbeecf848ea729ecf5c970b030e`, reproduced same-session observation/frame overlap, and added one session capture coordinator, typed bounded screenshot recovery, cleanup-final webxd shutdown, and pinned qualification. Final runtime/harness SHA `79254d6b30267432e35bec67cdb053aba59f322f` passed a clean uninterrupted 1,800.578-second soak with same-session maximum concurrency 1, cross-session maximum 2, 720 agent and 2,974 workspace attempts, zero timeouts/retries/unrecovered failures, zero general-cache image bytes, and complete cleanup. The former strict final-code soak gap is closed. See `PHASE2B1-RESULTS.md` and ADR-017.

## Verification commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:browser-core
pnpm --filter @webx/browserd test:adversarial
pnpm --filter @webx/browserd test:gate0
components/browser/.venv/bin/python -m pytest -q components/browser/tests/reader/test_secure_egress_proxy.py
pnpm --filter @webx/webxd test:phase2b
pnpm --filter @webx/webxd test:live-phase2b
pnpm --filter @webx/webxd test:process-route
pnpm --filter @webx/webxd test:routed-soak-phase2b
git diff --check
```

The final gate results and independent adversarial review disposition are recorded below before push.

## Final deterministic gate results

The following commands pass on `9edd31d` plus documentation-only working-tree changes:

- `pnpm test`: repository workspaces pass; webxd 124, browser runtime 109, browser protocol 8, browserd 7, SDK 14, Pi extension 19, and the remaining repository suites pass.
- `pnpm typecheck`: every participating workspace passes.
- `pnpm lint`: zero errors.
- `pnpm test:browser-core`: protocol 8, runtime 109, browserd 7.
- browserd adversarial: 12 browserd plus 83 runtime tests.
- browserd Gate 0: 16 browserd plus 75 runtime tests.
- secure egress proxy: 16 Python tests.
- webxd Phase 2B: 124 tests.
- final process-isolated route: passed with complete cleanup.
- `git diff --check`: passed.

## Independent workstream review disposition

Seven bounded independent audits covered the required implementation workstreams. The primary agent reproduced and reconciled their findings:

| Audit finding | Disposition |
|---|---|
| Three lint errors | Accepted and corrected in `9edd31d`; lint and targeted runtime tests pass. |
| Unconfirmed subscribe admission can orphan remote state | Accepted and corrected by actor-connection close; deterministic test passes. |
| Error response can omit pending operation identity | Accepted and corrected; success and failed-response mismatch tests pass. |
| Bracketed IPv6 webxd proxy URL rejected | Accepted and corrected with shared URL parser and deterministic IPv4/IPv6 tests. |
| Lost-close unit test did not prove one side effect | Accepted and corrected with backend operation deduplication model, exact call/effect counts, and focus retry coverage. |
| Idempotency omitted egress route identity | Not reproduced as a cross-route replay: backend and destination authority are immutable for one webxd process; changing the route requires restart and creates a new in-memory idempotency map. Stable browserd operations remain runtime-bound where needed. |
| Browserd retains screenshot artifact bytes | Expected and required bounded artifact behavior, not a webxd buffer or general-cache leak. The prohibition is on general WebX idempotency and long-lived webxd `Buffer`s. Browserd owns exact artifacts until observation/artifact expiry. |
| Legacy `PersistentBrowserConnection` lacks new AgentCursor bounds | Outside the Phase 2B replacement transport. The directive requires the legacy rollback stack to remain unchanged and selectable. AgentCursor uses `BrowserdClientPool`, whose pending, outbound, cancellation, and subscription bounds pass. |
| Retry lifetime coverage absent | Not reproduced. `operation-retry.test.ts` covers expired screenshot/DOM observations and revoked artifacts while operation records remain; authority tests prove uncached observation retry. |
| Process audit reported another repository | Rejected as invalid evidence. The primary agent used the correct repository's process route and evidence; a replacement bounded audit confirms the final-code soak gate remains open. |

A fresh independent final reviewer found no reproduced blocking request mismatch or concrete in-scope safety failure in `9edd31d`. It confirmed the deterministic and final process route evidence for legacy default/no cutover, lease and motor behavior, exact transient images with zero general-cache/webxd retention, transport and subscriptions, bounded bindings, restart/replacement semantics, stable operations, proxy/download enforcement, and cleanup. It independently reached the same acceptance decision: Phase 3 must not start under the strict original gate because no uninterrupted 30-minute soak exists after the final corrections.

## Commits

- `0ff5b28 fix(browser-runtime): align observation lease and motor timing`
- `c7ee5b9 fix(webxd): retrieve exact observation images without cache`
- `c4b2191 fix(webxd): harden browserd transport and subscriptions`
- `aa028ef fix(webxd): bind actors to bounded client lifetimes`
- `70e98aa fix(webxd): rehydrate sessions and preserve mutation IDs`
- `45a6be9 fix(browser-egress): probe proxy and deny downloads`
- `8970362 test(browser-route): add process-isolated Phase 2B acceptance`
- `ba571d9 fix(browser-runtime): keep background session motor responsive`
- `9edd31d fix(webxd): settle final Phase 2B review findings`

## Remaining gaps and Phase 3 recommendation

Phase 2B does not resolve ADR-012, test Google Chrome, package services, implement user takeover, or add the Tauri workspace. Fractional desktop scaling, multiple monitors, fullscreen/PDF/top-layer overlay cases, and cross-origin out-of-process iframe DOM fallback remain later work.

Phase 2B.1 now supplies the fresh uninterrupted final-code 30-minute process soak. Phase 3 development may start as a separate task for the trusted local screenshot workspace above webxd/browserd authority. It must not connect Tauri directly to browserd, expose model-facing frame subscriptions, or change the production backend default. Production-default AgentCursor routing must remain disabled until ADR-012 and later deployment gates are satisfied.
