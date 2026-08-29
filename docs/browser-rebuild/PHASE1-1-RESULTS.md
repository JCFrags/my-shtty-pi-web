# Phase 1.1 adversarial hardening results

## Verdict

Phase 1.1 passes the deterministic, repository, Fedora Chromium live, and uninterrupted 30-minute soak gates. The replacement runtime remains on `rebuild/screenshot-first-browser`. It is not merged or routed to production.

The work started at `21ecde62f229c778b052b92bc3f467b98007e0f4`. It changes only the parallel browser protocol, runtime, daemon, tests, and rebuild documents. It does not integrate `webxd`, Pi schemas, the SDK, installer, Tauri, MCP, the AgentCursor extension, or public JavaScript evaluation.

A final independent reviewer was requested again after all gates passed. The broker returned `AGENT_DISCONNECTED`. Earlier workstream requests returned `AGENT_DISCONNECTED` or `PERMISSION_DENIED`. The primary agent therefore completed an acceptance-focused local audit and records the orchestration limitation. Phase 2 routing should wait for one fresh independent review if the reviewer service becomes available before handoff.

## Branch and commits

- Branch: `rebuild/screenshot-first-browser`
- Required starting SHA: `21ecde62f229c778b052b92bc3f467b98007e0f4`
- `ee639ad` — `test(browser-runtime): reproduce pre-cutover adversarial races`
- `8837eaa` — `fix(browser-runtime): guarantee abort-safe input dispatch cleanup`
- `fbfa042` — `fix(browser-runtime): isolate profile and descriptor lifecycles`
- `6474c3a` — `fix(browser-runtime): scope frame subscriptions to epochs`
- `fa3bea1` — `fix(browser-runtime): preserve artifact provenance and capture consistency`
- `382b649` — `fix(browser-runtime): fingerprint mutations and preserve dispatch truth`
- `19b26d1` — `fix(browserd): route subscriptions and typed failures safely`
- `dda69d4` — `chore(browser-runtime): satisfy hardening quality gates`
- `e6dc863` — `fix(browser-runtime): copy artifact bytes and settle terminal input`
- `d99a581` — `test(browserd): prove Phase 1.1 live isolation`
- `b948471` — `test(browserd): exercise adversarial soak lifecycle`
- `7619054` — `fix(browser-runtime): preserve expected tab-close settlement`
- Documentation and evidence: the commit that contains this file.

## Exact verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser-core
pnpm --filter @webx/browserd test:adversarial
pnpm --filter @webx/browserd test:live -- --output=../../docs/browser-rebuild/evidence/phase1-1-live-results.json
pnpm --filter @webx/browserd test:soak -- --duration-seconds=1800 --sample-seconds=15 --output=../../docs/browser-rebuild/evidence/phase1-1-soak-results.json
```

All commands passed after the final runtime correction. Browser protocol tests passed 8 of 8. Browser runtime tests passed 56 of 56. Browserd core tests passed 7 of 7. The dedicated adversarial command passed 5 browserd tests and 39 focused runtime tests. Repository-wide tests also passed.

## Finding dispositions

Every listed defect was reproduced with deterministic coverage against the Phase 1 design or starting behavior. Tests use controlled fake WebSocket or CDP fixtures where timing control matters.

| Finding | Reproduction and root cause | Correction | Resulting test and commit |
|---|---|---|---|
| A. CDP abort races | Already-aborted work could allocate state. Abort could race listener installation and `socket.send`. Late responses could retain pending entries. | Check abort before allocation, recheck after listener installation, close cancelled connects, remove timers/listeners/pending commands, and discard late replies. | `adversarial-cdp.test.ts`: 7 controlled fake-WebSocket cases. `8837eaa`. |
| B. Pressed input release | Click and key paths did not use a full finally-style cleanup model. A failed press response was ambiguous. Terminal targets could retain local held state. | Track possibly dispatched presses before replies. Use an independent bounded cleanup signal. Keep held state until release succeeds or CDP is conclusively unavailable. Route cancel, disconnect, epoch, target, and session termination through cleanup. | `adversarial-runtime.test.ts` covers dwell, double-click, ambiguous press, key-up failure, disconnect, epoch, terminal target, and zero residual state. `8837eaa`, `e6dc863`. |
| C. Concurrent profile safety | Per-launch orphan cleanup could treat another launch's provisional manifest as dead. PID alone could be reused. | Add one `ProfileManager`, one runtime-instance root, an atomic cross-process lock, lifecycle manifests, PID plus process-start identity, strict root/marker/symlink checks, and launch-scoped failure cleanup. | `profile-manager.test.ts`: 8 lifecycle groups, including 50 concurrent allocations. Live gate launches four sessions concurrently. `fbfa042`, `d99a581`. |
| D. Connection-scoped frames | Subscriber counts were session-wide. Duplicate subscriptions could increase interest. Server delivery used actor ownership rather than connection subscription. | Require bounded `subscriptionId`. Bind each subscription to connection, actor, full address, epoch, and interest. Use unique scheduler consumers. Remove them on connection, epoch, tab, or session termination. | Scheduler/runtime/server adversarial cases plus live proof: subscribed connection 10 frames; same-actor unsubscribed 0; other actor 0; duplicate count 1. `6474c3a`, `19b26d1`, `d99a581`. |
| E. Operation fingerprints | An actor-scoped operation ID returned the original record even when the second mutation differed. | Store a bounded SHA-256 digest of canonical semantic JSON. Exclude request ID and deadline. Exact retries reuse the original operation. Changed semantics return `OPERATION_CONFLICT`. | Canonical-order, queued/running/terminal retry, cross-action/address/actor, and no-second-effect cases. Live duplicate caused one side effect and conflict returned exact code. `382b649`, `d99a581`. |
| F. Typed errors | Browserd classified failures through message substrings and could mislabel unknown failures. | Use `BrowserProtocolError` with finite code, retry flag, safe message, and bounded safe details. Preserve typed task failures. Map unknowns to `INTERNAL_ERROR`. Remove the substring classifier. | `apps/browserd/tests/adversarial.test.ts` verifies exact public codes, redaction, and non-enumerating ownership failures. `19b26d1`. |
| G. Artifact provenance and lifetime | Media type and ownership metadata were incomplete. Global oldest-entry pressure could evict another owner. Frame artifacts lacked a bounded availability pin. Buffer-backed views could mutate stored bytes. | Store owner, session, optional tab, purpose, media type, size, digest, and times. Apply owner and session quotas before the global bound. Pin a two-item frame ring. Clean by tab/session. Copy bytes with `Uint8Array.from`. | Artifact tests cover media, scope, quota fairness, pin replacement, expiry, corruption, and cancelled capture. Live cross-actor denial and crashed-tab cleanup passed. `fa3bea1`, `e6dc863`. |
| H. Screenshot consistency | Layout was read only before capture. Metadata could describe a different viewport or document than the image. | Resolve the exact target and generation. Compare pre- and post-capture layout, DPR, dimensions, and scroll. Retry once within the deadline. Reject and remove inconsistent captures. Timestamp completed capture. | Fake-CDP stable/retry/reject/cancel cases and an animated Chromium fixture. `fa3bea1`, `d99a581`. |
| I. Lifecycle cancellation and dispatch truth | Some mutations marked dispatch after the process or CDP result. Partial create resources could survive. Normal tab close could also fail its own operation when its expected terminal event arrived. | Mark at the irreversible send boundary. Roll back partial session and target creation. Keep bounded cleanup after cancellation. Do not classify the expected close event as a crash of its own close operation. | Lifecycle create/attach/focus/close matrix, live navigation cancellation, and deterministic expected-close settlement. `382b649`, `7619054`. |
| J. Descriptor startup consistency | A descriptor could exist before the socket was fully ready. PID-only stale checks were not reuse-safe. | Publish atomically only after listen, `0600` socket verification, and runtime identity setup. Include runtime instance ID and PID start ticks. Remove socket on publication failure and remove both files on idempotent stop. | Browserd adversarial startup/discovery/stale-owner cases and live mode/readiness checks. `fbfa042`, `19b26d1`, `d99a581`. |
| K. Same-user trust decision | The descriptor secret cannot authenticate actors against hostile code under the same Unix UID. | Define trusted `webxd` as the only production client. Keep the descriptor from Pi/model requests. Treat direct access as administrator/developer capability. Do not claim hostile same-UID isolation. | `ADR-011-BROWSERD-TRUST-BOUNDARY.md`. Documentation commit. |

## Additional defects found during the gates

1. The first frame schedule delayed an initial capture because zero was treated as a recent capture time. Zero now means immediately capturable. `dda69d4`.
2. A new frame pin checked capacity before releasing the replaceable old pin. Replacement now releases the old pin first. `dda69d4`.
3. Node `Buffer.slice()` produced shared views. Stored PNG bytes could change and fail digest verification. Artifact and capture storage now make owned copies. `e6dc863`.
4. A target-close event could fail the operation that intentionally closed that target. Close operations now retain target correlation but ignore their expected terminal event. `7619054`.
5. Reconnecting soak clients initially reused generated operation IDs. The harness now adds a random per-client prefix. `7619054`.

## Fedora Chromium live evidence

Evidence: `docs/browser-rebuild/evidence/phase1-1-live-results.json`.

- Browser: Chromium `151.0.7922.173`, Fedora 44 build.
- Four concurrent profile launches: passed.
- Descriptor ready-state publication: passed.
- Frame isolation: 10 subscribed frames, zero on the same-actor unsubscribed connection, zero for another actor.
- Duplicate frame subscription: one live subscription.
- Disconnect and epoch subscription cleanup: passed.
- Operation retry: one side effect; changed fingerprint returned `OPERATION_CONFLICT`.
- Input cleanup: zero held buttons and keys after disconnect, epoch change, and terminal-target coverage.
- Artifact read: truthful `image/png`; cross-actor denial and crashed-tab cleanup passed.
- Animated screenshot consistency: passed.
- Startup: 579.57 ms.
- Human path: 908.02 ms.
- Parallel actions: 1,345.54 ms.
- Same-session serialized actions: 5,910.52 ms.
- Process-tree PSS / private dirty at the measured point: 438,840 / 276,728 KiB.

## Uninterrupted 30-minute soak evidence

Evidence: `docs/browser-rebuild/evidence/phase1-1-soak-results.json`.

The accepted run lasted 1,800.295 seconds without interruption and produced 121 samples. It used two actors, two browser sessions, three steady tabs, three steady frame subscriptions, repeated connection churn, duplicate subscriptions, four epoch invalidations, observations, frames, pointer and keyboard operations, exact operation retries, artifact reads, pruning, and eight tab create/close cycles.

| Measurement | Result |
|---|---:|
| Screenshot latency median / p95 / max | 194.04 / 268.11 / 391.42 ms |
| Path latency median / p95 | 812.66 / 1,097.79 ms |
| Frame publication median / p95 | 0.190 / 0.286 ms |
| Frame delivery median / p95 | 0.152 / 0.308 ms |
| CPU median / p95 | 4.70% / 7.09% of one core |
| PSS start / end / max | 755,398 / 840,340 / 840,931 KiB |
| Private dirty start / end / max | 502,396 / 578,316 / 578,460 KiB |
| browserd heap start / end / max | 20.70 / 19.08 / 20.70 MB |
| Artifacts count / bytes max | 192 / 2,058,567 |
| Operations max | 240 |
| Delivered / dropped replaceable frames | 3,556 / 1,336 |
| Reconnects / duplicate subscribe calls | 15 / 15 |
| Epoch invalidations / operation retries | 4 / 10 |
| Artifact reads / tab churn cycles | 363 / 8 |
| Steady subscriptions / held buttons / held keys | 3 / 0 / 0 |
| Steady profiles / targets | 2 / 3 |

Cleanup ended with zero profiles, artifacts, operations, subscriptions, held buttons, held keys, and browser processes. The descriptor and socket were removed.

PSS and private dirty still have positive full-run linear slopes. Chrome profile disk also grows during browsing. The hard bounds and cleanup passed, but longer real-task evidence remains necessary before production resource limits are final.

## Security and production-route audit

- No model or production browser route changed.
- The current production browser stack remains present and selected.
- No request accepts an actor selector after binding.
- No public arbitrary JavaScript evaluation was added.
- No sandbox, web-security, certificate, or site-isolation protection was weakened.
- No browser or system package was installed.
- Google Chrome remains unavailable and untested.
- Same-UID hostile-process isolation is not claimed.

## Remaining gaps and Phase 2 recommendation

Remaining gaps are Google Chrome coverage; fractional scaling, multiple monitors, fullscreen, PDF, and top-layer visual precedence; production `webxd` and Pi integration; Tauri human takeover; and longer real-task resource evidence.

The runtime evidence supports beginning Phase 2 development behind one reversible service switch. Production routing should not begin until a fresh independent acceptance review completes, trusted `webxd` is the only browserd client, and Phase 2 tests prove that browser failure cannot affect search and read.
