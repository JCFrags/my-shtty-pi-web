# Phase 1.2 independent-audit correction results

## Verdict

Phase 1.2 passes all correctness, repository, Fedora Chromium live, 30-minute soak, and two-hour soak gates. The replacement runtime remains isolated on `rebuild/screenshot-first-browser`. It is not merged or routed to production.

The work started at `127a91e917360e29b2d5f144803bac56e65372d3`. It changes only the parallel browser protocol, runtime, daemon, tests, and rebuild documents. It does not integrate `webxd`, Pi schemas, the SDK, installer, Tauri, MCP, the AgentCursor extension, or public JavaScript evaluation.

The two-hour run does **not** prove a memory plateau. Total PSS rose from 880,401 to 982,683 KiB. Its full-run, final-hour, and final-30-minute regression slopes were +41,613, +61,198, and +29,914 KiB/hour. Browserd, artifacts, operations, process counts, and the second Chrome session were stable in the final hour. Most late growth was in the first Chrome session. Phase 2 development can begin behind the planned reversible service switch. Production-default routing still requires either credible plateau evidence or a bounded Chrome session recycling and recovery policy.

## Branch and commits

- Branch: `rebuild/screenshot-first-browser`
- Required starting SHA: `127a91e917360e29b2d5f144803bac56e65372d3`
- `7d257e8` — `fix(browserd): make startup ownership instance-safe`
- `cdbc6d9` — `fix(browser-runtime): make profile lifecycle ownership-safe`
- `d8b8524` — `fix(browser-runtime): make target registration transactional`
- `38b4d89` — `fix(browser-runtime): bind captures through artifact commit`
- `55ce8c5` — `fix(browser-runtime): preserve cancellation and release truth`
- `453e967` — `fix(browser-runtime): type and bound DOM fallback`
- `0bfbabe` — `fix(browser-runtime): resolve retries before resources`
- `9c831bb` — `fix(browser-runtime): verify iframe DOM and bounded wheel dispatch`
- `1813e76` — `test(browserd): add Phase 1.2 live and resource gates`
- `01e8d26` — `test(browser-runtime): cover Phase 1.2 rollback edges`
- Documentation and evidence: the commit that contains this file.

## Exact verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser-core
pnpm --filter @webx/browserd test:adversarial
pnpm --filter @webx/browserd test:live -- --output=../../docs/browser-rebuild/evidence/phase1-2-live-results.json
pnpm --filter @webx/browserd test:soak -- --duration-seconds=1800 --sample-seconds=15 --output=../../docs/browser-rebuild/evidence/phase1-2-soak-results.json
pnpm --filter @webx/browserd test:soak -- --duration-seconds=7200 --sample-seconds=30 --output=../../docs/browser-rebuild/evidence/phase1-2-soak-2h-results.json
```

All commands passed after the final correction. Browser-core passed 8 protocol, 83 runtime, and 7 browserd tests. The final dedicated adversarial command passed 12 browserd cases and 66 focused browser-runtime cases. The full repository lint, typecheck, and test commands also passed.

## Finding dispositions

Each finding was reproduced with a deterministic test against the starting implementation before its correction. Controlled child processes, fake CDP barriers, or fake WebSocket fixtures replace timing-only evidence where the race boundary matters.

| Finding | Reproduction and root cause | Correction | Passing test and commit |
|---|---|---|---|
| A. Exclusive browserd startup ownership | Two server objects could inspect the same fixed descriptor and unlink the same socket before either held exclusive ownership. Stop cleanup did not prove that it still owned shared paths. | Acquire one atomic nonce-bearing owner lock before shared-path work. Use a runtime-instance socket name. Verify descriptor, socket, lock nonce, PID, and process-start identity during cleanup. Share same-object startup promises. Bound connections and unbound-client time. Require `XDG_RUNTIME_DIR` in production. | `apps/browserd/tests/adversarial.test.ts` races two real child processes, pauses descriptor publication, tests same-object start, stop during start, PID reuse, corrupt descriptor recovery, replacement cleanup, connection limit, bind timeout, and leak-free stop. `7d257e8`, `01e8d26`. |
| B. Ownership-safe profile locking and shutdown | The lock directory existed before its marker. Another manager could remove that live markerless lock. A stale release callback could delete a successor lock. Runtime shutdown left its outer runtime root. | Acquire a complete owner record with an atomic hard-link no-replace step. Include a random nonce. Verify the current nonce before release. Apply a grace period to malformed locks. Track active leases. Add `ProfileManager.close()` and call it from `BrowserRuntime.close()`. | `profile-manager.test.ts` uses two real child processes, a paused live owner, former-owner release after successor replacement, malformed young and old locks, active-lease rejection, dead-root cleanup, and exact outer-root removal. `cdbc6d9`, `01e8d26`. |
| C. Transactional tab and popup registration | Target maps were published before domain enablement. Overlay, cancellation, or initial navigation failure after registration could leave an owned target and selectable tab. Popup failure could leave a partial mapping. | Check tab capacity at authoritative admission. Attach and enable required domains before publication. Track attach and auto-session state for rollback. Make session-level creation own rollback after overlay, cancellation, authorization, navigation, or initialization failure. | `lifecycle-targets.test.ts` covers cancellation after target creation, attach and enablement failure, popup failure, close failure during rollback, authoritative tab capacity, clean mappings, and accurate close dispatch. Focused runtime tests cover session-level navigation and rollback. `d8b8524`, `01e8d26`. |
| D. Capture commit generation binding | Pre/post layout checks ended before hashing and artifact insertion. Navigation or viewport change during asynchronous commit could publish old pixels with current generations. | Return immutable target, CDP session, document, viewport, and epoch identity from capture. Revalidate it after digest and artifact insertion and immediately before observation or frame publication. Revoke a rejected artifact idempotently. Do not increment a rejected frame sequence. | `artifacts-frames-observations.test.ts` changes navigation during commit, epoch and tab state during artifact insertion, and frame identity before publication. It proves no record, event, sequence increment, or artifact leak. `38b4d89`. |
| E. Post-guard cancellation and release truth | Wheel did not checkpoint after its awaited guard and did not pass the operation signal to CDP. Drag swallowed release failure and could commit while a button remained possibly held. | Check cancellation after each awaited post-path guard and immediately before dispatch. Pass the operation signal and a bounded timeout to wheel and text CDP sends. Fail drag on release failure. Keep held truth until release succeeds or CDP is terminal. Attempt one bounded release retry. Check navigation cancellation after authorization. | `adversarial-runtime.test.ts` blocks the wheel guard for cancellation and deadline, cancels after guard resolution, injects release timeout/error, verifies failed terminal status and held truth, and proves retry cleanup. `55ce8c5`, `9c831bb`. |
| F. Typed, bounded DOM fallback | Stale, detached, expired, and moved handles used plain `Error`. Observation retention had no count limit. AX and box-model CDP work ignored cancellation. Scrolled and iframe coordinates were unproven. | Use `HANDLE_STALE` for expired, detached, moved, and document-changed handles. Bound observations, total handles, and handles per observation with deterministic pruning. Propagate `AbortSignal`. Convert quads to top-level CSS viewport coordinates. Traverse same-origin child frame accessibility trees. | `dom-fallback.test.ts` proves typed staleness, pruning, AX and box cancellation, scroll coordinates, and iframe quads. The live gate clicks after vertical and horizontal scroll and in a same-origin iframe. Browserd returns exact `HANDLE_STALE`. `453e967`, `9c831bb`. |
| G. Retry semantics before resource lookup | Exact `session.close` and `tab.close` retries resolved deleted resources before finding their existing operation. Actor-only frame fingerprints could return a disconnected connection's prior subscribe success. | Add `OperationRegistry.lookup()` and run exact-match or conflict resolution before session or tab lookup. Include internal `connectionId` in subscribe and unsubscribe semantics. A reconnect with the same operation ID conflicts and cannot inherit stale success. | `operation-retry.test.ts` covers close after deletion, failed create after rollback, target-crash failure, conflict before lookup, same-connection retry, and reconnect conflict with no second side effect. The live gate confirms both close retries and reconnect `OPERATION_CONFLICT`. `0bfbabe`. |
| H. Idempotent artifact rollback and quota order | Observation or frame rollback could mask the original error after concurrent tab/session cleanup. Owner quota ran before session quota, so one noisy session could evict another session owned by the same actor. Frame pins did not have one explicit terminal release operation. | Add idempotent `revokeIfOwned()`, `pinFrameArtifact()`, and `releaseFrameRing()`. Apply session quota before owner quota. Release frame rings on terminal tab/session cleanup and keep the documented recent ring readable after publication. | `artifacts-frames-observations.test.ts` proves concurrent rollback, session-before-owner pressure, cross-owner safety, ring readability, replacement, and terminal release. `38b4d89`. |
| I. Profile-manager root cleanup | Session profile cleanup removed leases but normal runtime shutdown did not remove the owned marker and empty `runtime_<id>` root. The soak counted only session directories. | Track leases and close the manager only after sessions settle. Remove only the manager's empty, identity-matching runtime root. Count both session profile directories and runtime-instance roots in soak cleanup. | `profile-manager.test.ts`, server cleanup tests, and both accepted soaks end with zero session profiles and zero runtime roots. `cdbc6d9`, `1813e76`. |
| J. Resource plateau investigation | Phase 1.1 had only a 30-minute positive slope and could not support a plateau claim. Its aggregate metrics did not isolate browserd, each Chrome tree, renderers, profile disk, artifacts, or operations. | Record per-process-tree PSS/private dirty, renderer and process counts, browserd memory, profile bytes, artifact and operation bounds, and full/final-hour/final-30-minute slopes. Run fresh uninterrupted 30-minute and two-hour mixed workloads. | Both evidence files pass lifecycle and cleanup gates. The two-hour evidence locates late growth in Chrome session A and explicitly rejects a plateau claim. `1813e76` and evidence commit. |

## Scope clarifications

- Same-origin iframe DOM fallback is supported and verified.
- Cross-origin out-of-process iframe DOM fallback remains unsupported in Phase 1.2. Such targets are not part of the tab's DOM authority. The runtime fails closed and does not adopt or rediscover them broadly.
- Hostile same-UID isolation is not claimed. ADR-011 still requires trusted `webxd` to be the only production browserd client.
- One Chromium process tree per browser session remains the isolation model. No process-sharing change was made to reduce PSS.

## Fedora Chromium live evidence

Evidence: `docs/browser-rebuild/evidence/phase1-2-live-results.json`.

- Browser: Chromium `151.0.7922.173`, Fedora 44 build.
- Four concurrent live profile launches: passed.
- Startup ownership and descriptor ready-state publication: passed.
- Frame isolation: 10 subscribed frames; zero on the same-actor unsubscribed connection; zero for another actor; duplicate count one.
- Exact operation retry after deletion: session close and tab close passed.
- Subscription retry after reconnect: exact `OPERATION_CONFLICT`.
- DOM fallback: vertical and horizontal scroll passed; same-origin iframe passed; stale handle returned `HANDLE_STALE` through browserd.
- Input cleanup: zero held buttons and keys.
- Animated screenshot consistency: passed.
- Startup: 600.00 ms.
- Human path: 908.21 ms.
- Parallel actions: 1,057.71 ms.
- Same-session serialized actions: 6,344.98 ms.
- Measured process-tree PSS / private dirty: 599,190 / 288,060 KiB.

## Uninterrupted 30-minute soak

Evidence: `docs/browser-rebuild/evidence/phase1-2-soak-results.json`.

The run lasted 1,800.116 seconds and produced 121 samples. It used two actors, two browser sessions, three steady tabs, three frame subscriptions, 15 reconnects, 15 duplicate subscription calls, four epoch invalidations, ten operation retries, 363 artifact reads, and eight tab create/close cycles.

| Measurement | Result |
|---|---:|
| Screenshot latency median / p95 / max | 32.32 / 189.34 / 759.15 ms |
| DOM fallback latency median / p95 | 6.10 / 7.04 ms |
| Path latency median / p95 | 814.02 / 1,099.93 ms |
| Frame publication median / p95 | 0.189 / 0.285 ms |
| Frame delivery median / p95 | 0.148 / 0.316 ms |
| CPU median / p95 | 5.27% / 7.22% of one core |
| PSS start / end / min / max | 875,122 / 966,427 / 855,576 / 966,841 KiB |
| Private dirty start / end / min / max | 509,976 / 588,940 / 490,216 / 589,012 KiB |
| browserd PSS start / end / max | 86,568 / 90,991 / 92,018 KiB |
| browserd heap start / end / max | 19.09 / 19.21 / 22.03 MB |
| Artifacts count / bytes max | 193 / 2,068,134 |
| Operations max | 241 |
| Delivered / dropped replaceable frames | 3,709 / 672 |
| Process / renderer counts | Constant for both Chrome trees |

The 30-minute regression slopes remain positive. They are not used as plateau evidence. Cleanup ended with zero profiles, runtime roots, artifacts, operations, subscriptions, held input, and browser processes. The descriptor and unique socket were removed.

## Uninterrupted two-hour resource soak

Evidence: `docs/browser-rebuild/evidence/phase1-2-soak-2h-results.json`.

The run lasted 7,200.199 seconds and produced 241 samples. It used 60 reconnects, 60 duplicate subscriptions, 16 epoch invalidations, 40 operation retries, 963 artifact reads, and 32 tab create/close cycles. Chrome process counts stayed at 13 and 12. Renderer counts stayed at four and three.

| Measurement | Full run | Final hour | Final 30 minutes |
|---|---:|---:|---:|
| Total PSS slope | +41,613 KiB/h | +61,198 KiB/h | +29,914 KiB/h |
| Total private-dirty slope | +39,625 KiB/h | +53,483 KiB/h | +18,621 KiB/h |
| browserd PSS slope | +1,576 KiB/h | +347 KiB/h | +715 KiB/h |
| browserd heap slope | +0.80 MB/h | -0.07 MB/h | -0.68 MB/h |
| Chrome session A PSS slope | +37,176 KiB/h | +60,438 KiB/h | +28,924 KiB/h |
| Chrome session B PSS slope | +2,936 KiB/h | +426 KiB/h | +316 KiB/h |
| Renderer A PSS slope | +11,249 KiB/h | +8,023 KiB/h | +28,243 KiB/h |
| Renderer B PSS slope | +3,513 KiB/h | +610 KiB/h | +471 KiB/h |
| Profile bytes slope | +668,958 B/h | +300,568 B/h | +347,891 B/h |
| Artifact bytes slope | +62,832 B/h | -15,029 B/h | -33,544 B/h |
| Operation count slope | +28.14/h | -0.26/h | -1.04/h |

Additional two-hour bounds:

- Total PSS: 868,923–984,470 KiB; start/end 880,401/982,683 KiB.
- Total private dirty: 496,016–605,300 KiB; start/end 507,696/604,308 KiB.
- browserd PSS: 84,837–93,109 KiB; start/end 84,837/89,459 KiB.
- Chrome session A PSS: 406,681–512,722 KiB; start/end 410,173/510,745 KiB.
- Chrome session B PSS: 372,245–383,709 KiB; start/end 381,279/382,479 KiB.
- Artifacts stayed at or below 192 entries and 2,055,014 bytes.
- Operations stayed at or below 239 and were flat in late windows.
- No explicit garbage collection was observable. Tab cycles and natural runtime collection were recorded.

The evidence excludes browserd, artifact retention, operation retention, process-count growth, and the second Chrome session as the main source of late growth. Chrome session A accounts for nearly all final-hour PSS slope. Its renderer subset accounts for only part of that hour, while the final-30-minute renderer slope is larger. The run therefore points to Chrome browser/cache/renderer lifecycle rather than an unbounded Node store. It does not prove a stable plateau.

Cleanup ended with zero profiles, runtime roots, artifacts, operations, subscriptions, held input, and browser processes. The descriptor and unique socket were removed.

## Production-route audit and remaining gaps

- No model or production browser route changed.
- The current production browser stack remains present and selected.
- No public arbitrary JavaScript evaluation was added.
- No sandbox, web-security, certificate, or site-isolation protection was weakened.
- No browser or system package was installed.
- Google Chrome remains unavailable and untested.
- Cross-origin OOPIF DOM fallback remains unsupported.
- Fractional scaling, multiple monitors, fullscreen, PDF, and top-layer visual precedence remain future gates.
- Production `webxd`, Pi extension, SDK, installer, and Tauri integration remain future work.
- Production-default resource policy is not complete because the two-hour PSS evidence is not a plateau.

## Phase 2 recommendation

The independent-audit correctness findings are corrected and all required gates pass. Phase 2 development may begin behind the documented reversible service switch, with trusted `webxd` as the only browserd client. Do not enable production-default routing until Phase 2 route isolation tests pass and either:

1. a longer representative run shows a credible Chrome plateau; or
2. the production design adds and verifies a bounded Chrome session recycling and recovery policy that preserves explicit session identity and operation truth.
