# Phase 2B.1 results

## Outcome

Phase 2B.1 is qualified on `rebuild/screenshot-first-browser`. The code started exactly from `8504bd0f4d559cbeecf848ea729ecf5c970b030e`. Final runtime and harness code is `79254d6b30267432e35bec67cdb053aba59f322f`.

The final code passed all deterministic gates, the Fedora Chromium capture-contention gate, the complete process-isolated route, and one clean-tree, externally pinned, uninterrupted 1,800-second process-isolated routed soak. No runtime, webxd, proxy, or harness code changed after qualification. This document and the evidence files form the permitted documentation-only follow-up.

Production-default AgentCursor routing remains disabled. `WEBX_BROWSER_BACKEND` remains immutable at startup and defaults to `legacy`. The legacy browser stack remains installed. Phase 2B.1 does not implement Phase 3 or Tauri and does not resolve ADR-012.

## Provenance

- Required starting SHA: `8504bd0f4d559cbeecf848ea729ecf5c970b030e`
- Qualifying code SHA: `79254d6b30267432e35bec67cdb053aba59f322f`
- Browser: Fedora Chromium `151.0.7922.173`
- Google Chrome: not installed or tested
- Capture evidence: `evidence/phase2b1-capture-contention-results.json`
- Process evidence: `evidence/phase2b1-process-route-results.json`
- Soak evidence: `evidence/phase2b1-routed-soak-results.json`
- Evidence SHA-256: contention `9ee0cbbdb3d43ebfaf395a153df8b1972981e55d0b2bccae683aeacd939abaee`; process `03e97670065c10451dfcb5436e447602cf31f520e0d939776d46ec3641c07a73`; soak `256a2df189c6e69b16fa3bd928f78f79a441111c5e1fc6d605b0f5dfc61e9e6a`

Both graphical commands started from a clean tree and required the exact external pin through `PHASE2B1_EXPECTED_SHA`. Evidence records identical `testedSha` and `expectedSha`. A forced mismatch also proved automatic bounded failure output and complete child cleanup before the qualifying runs.

## Finding disposition

| Finding | Reproduction | Root cause | Correction | Passing evidence | Commit |
|---|---|---|---|---|---|
| Agent and workspace screenshots could overlap in one session | `same-session screenshot overlap correction` used a barrier-controlled fake CDP connection in frame-first and observation-first order. Against `8504bd0`, active `Page.captureScreenshot` count exceeded one. | `ObservationStore` and `FrameScheduler` owned independent capture transactions; frames were outside the browser operation lane. | Added one `SessionCaptureCoordinator` per `BrowserSession` and routed each complete observation and frame transaction through it. | Both deterministic orderings serialize; graphical same-session maximum is 1 while cross-session maximum is 2. | `7511a36`, `854b000` |
| Screenshot command timeout was untyped | Command timers returned a generic protocol error, so safe retry could not use type identity. | Timeout construction lost exact internal class identity. | Added `CdpCommandTimeoutError` with exact method, timeout, code, and retryable identity; late responses settle once. | Adversarial CDP tests distinguish timeout, cancellation, disconnect, and ordinary CDP failure. | `854b000` |
| Read-only screenshot recovery was not bounded | Deterministic fixtures inject one timeout, two timeouts, and identity changes. | There was no exact typed retry policy around the full transaction. | Agent screenshots retry once only for typed `Page.captureScreenshot` timeout under the original deadline and operation identity. Frames do not retry immediately. | One-time recovery succeeds; exhausted or changed-identity cases fail typed; failed attempts publish nothing. | `854b000` |
| Coordinator close could hang on non-cooperative active work | Independent audit held an active transaction on a never-settling promise and reproduced a close hang. | Close awaited transaction code after abort even if that code ignored the signal. | Added an abort-aware execution settlement boundary and propagated capture cancellation through overlay setup. | `settles close even when an active transaction does not cooperate with cancellation`; browser-runtime suite passes. | `7a85361` |
| Webxd shutdown could skip socket cleanup | Injected browser shutdown failure left later cleanup dependent on an earlier stage. | `stop()` used sequential fail-fast cleanup. | Added shared all-stage cleanup, aggregated failure, residual retry, one-shot state, request/binding settlement, and inode-safe socket ownership. | Cleanup-final and replacement-safety runtime tests pass; process evidence removes socket after full route. | `2032118` |
| Qualification did not measure contention precisely enough | First review found cumulative process overlap, implicit SHA provenance, opt-in failure output, and unbounded soak arrays/duration. | Diagnostics and evidence policy were not workload-scoped or independently pinned. | Added workload overlap baseline, external exact SHA pin, automatic bounded failure artifacts, bounded samples, and hard soak duration. | Corrected clean pinned contention and soak both pass; metrics retain at most 2,048 timing samples. | `59746a1`, `79254d6` |

The reproduced overlap is a concrete structural defect and the strongest explanation for the earlier Phase 2B screenshot timeout. It does not prove conclusively that no external Chromium scheduling factor contributed.

## Capture coordinator architecture

One coordinator belongs to one browser session and dedicated Chrome process. It owns overlay, pre-layout, screenshot, post-layout, identity validation, and commit as one transaction. There is no coordinator per tab and no public or model-facing coordinator API.

Agent observations use high-priority FIFO with eight queued requests maximum. Workspace frames keep one latest queued intent per tab and eight tabs maximum. Frames coalesce. After four consecutive agent captures, one pending frame may run. Queued cancellation is immediate. Tab/session close aborts affected work. Session close settles active and queued work before target, artifact, CDP, profile, or Chrome cleanup.

Metrics are diagnostic-only and bounded. Counts saturate; timing arrays retain at most 2,048 samples. They contain no screenshot bytes or page payloads.

## Timeout and retry policy

An agent observation makes at most two screenshot attempts. Retry requires `CdpCommandTimeoutError`, exact method `Page.captureScreenshot`, an open coordinator/session, unchanged tab/target/CDP session/document/viewport/epoch identity, an unexpired operation deadline, and a non-aborted signal. It starts a fresh full transaction after a short bounded delay. It uses the same public operation ID.

Cancellation, deadline expiry, disconnect, target close/crash, identity change, artifact failure, decoding failure, or invalid dimensions is not retried. A second timeout returns the typed retryable error. No stale frame is substituted. Failed attempts create no artifact, observation, event, or sequence.

Workspace-frame timeouts are counted and dropped. They do not immediately retry. The next scheduled tick is independent and a queued agent observation proceeds first.

## Capture-contention result

The qualifying Fedora Chromium run lasted 248.767 seconds and recorded:

| Metric | Result |
|---|---:|
| Governed screenshot transactions | 1,001 |
| Explicit agent observations / exact image reads | 784 / 784 |
| Workspace screenshot attempts / delivered frames | 217 / 217 |
| Human motor actions | 32 |
| Same-session maximum concurrency | 1 |
| Cross-session concurrency | yes; process maximum 2; 408 workload overlap events |
| Maximum agent/workspace queue depth | 1 / 1 |
| Typed timeouts / retries / recoveries / unrecovered failures | 0 / 0 / 0 / 0 |
| Duplicate/non-monotonic frame sequences | 0 / 0 |
| Exact image ledger | 784 records; SHA-256 `ed93e52393afcb9ff4b8ba9171f74eb3226d0a345dd60ef152fd6ff5e1a45a6c` |
| General image-cache bytes | 0 |
| Final subscriptions, held input, profiles, children | 0 |

Agent action latency median/p95 was 711.967/1,274.403 ms with 16 motor samples in the reported path. All coordinator queues settled.

## Cleanup-final webxd proof

`WebxdRuntime.stop()` uses `open`, `stopping`, `stopped`, and `cleanup-failed` states. Concurrent callers share one attempt. Client connections and request controllers settle, bindings clear, the server closes, browser shutdown runs, and socket removal is attempted even when an earlier stage fails. Failures are aggregated. A later stop retries residual work. A stopped instance cannot restart. An old runtime checks socket inode identity and cannot unlink a replacement.

Deterministic tests inject browser and socket cleanup failures, verify all stages and residual retry, verify one-shot behavior, and preserve a replacement socket. Both process routes report `webxdSocketRemoved: true`, zero remaining children, and zero profiles.

## Final process-isolated route

The final qualifying command used distinct Pi harness, webxd, browserd, proxy, fixture, and Chrome processes. It records:

- normal 60,000 ms observation lease, no override, 10,004.135 ms model delay, and successful 555.523 ms click;
- visible 16-sample motor path;
- three concurrent exact observations with distinct IDs, digests, and byte counts;
- DOM fallback;
- frame stream beyond idle timeout with no duplicate or non-monotonic sequence;
- Pi reconnect and same actor session reuse;
- webxd restart with browserd runtime and session preserved;
- browserd replacement with old-session rejection and new-session success;
- proxy outage and recovery while search/read remained healthy;
- download denial with no remaining file;
- exact close retry after injected response loss;
- zero general idempotency image bytes;
- zero profiles, children, stale webxd socket, or browserd descriptor after cleanup.

## Final uninterrupted 30-minute soak

The clean pinned soak requested 1,800 seconds and completed uninterrupted in 1,800.578 seconds at qualifying code SHA `79254d6b30267432e35bec67cdb053aba59f322f`.

| Metric | Result |
|---|---|
| Workload | 360 iterations; 720 explicit screenshots; 2,974 workspace captures; 3,694 screenshot attempts; 703 actions; 240 DOM fallbacks; 120 search/read calls |
| Capture concurrency | same-session maximum 1; cross-session yes; process maximum 2; 429 workload overlap events |
| Agent/workspace queue depth | maximum 1 / 1 |
| Agent queue wait | median upper bound 0.007 ms; p95 upper bound 178.259 ms; max 2,600.186 ms |
| Workspace queue wait | median upper bound 0.012 ms; p95 upper bound 100.512 ms; max 1,136.742 ms |
| Agent transaction | median upper bound 381.675 ms; p95 upper bound 591.995 ms; max 1,566.258 ms |
| Workspace transaction | median upper bound 98.361 ms; p95 upper bound 1,089.961 ms; max 2,879.767 ms |
| Typed timeouts / retries / recoveries / unrecovered failures | 0 / 0 / 0 / 0 |
| Screenshot plus exact image route | median 193.839 ms; p95 598.298 ms; max 3,141.978 ms |
| Exact image validation/presentation check | median 0.013 ms; p95 0.023 ms |
| Action route | median 616.432 ms; p95 1,428.074 ms; max 1,738.701 ms |
| Motor replay | median 609.532 ms; p95 1,419.567 ms; max 1,732.526 ms |
| Motor nominal | median 538.679 ms; p95 747.910 ms |
| Motor samples | median 16; minimum 9 |
| Post-path guard | p95 0 ms; max 0.758 ms |
| Delayed actions | 15/15 succeeded; model-delay median 10,002.986 ms |
| Frames | 2,972 delivered; 0 duplicate; 0 non-monotonic |
| Reconnect / webxd restart / tab cycles / close retry pairs | 1 / 1 / 30 / 36 |
| Final durable idempotency | 475 entries; 283,984 bytes |
| General image bytes | 0 |
| Final observation metadata | 22 entries; 21,127 bytes |
| Final subscriptions / held buttons / held keys | 0 / 0 / 0 |
| Cleanup | zero profiles and children; webxd socket and browserd descriptor removed |

The evidence includes bounded periodic webxd/browserd heap, actor connection, operation, artifact, profile, and per-Chrome-tree PSS/private-dirty samples. `chromePlateauClaimedResolved` is explicitly false. ADR-012 remains unresolved.

## Verification

The following exact gates pass at the qualifying code SHA:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:browser-core
pnpm --filter @webx/browserd test:adversarial
pnpm --filter @webx/browserd test:gate0
pnpm --filter @webx/webxd test:phase2b
components/browser/.venv/bin/python -m pytest -q components/browser/tests/reader/test_secure_egress_proxy.py
git diff --check
PHASE2B1_EXPECTED_SHA=79254d6b30267432e35bec67cdb053aba59f322f pnpm --filter @webx/webxd test:capture-contention
PHASE2B1_EXPECTED_SHA=79254d6b30267432e35bec67cdb053aba59f322f pnpm --filter @webx/webxd test:process-route -- --output=<outside-clean-tree-path>
PHASE2B1_EXPECTED_SHA=79254d6b30267432e35bec67cdb053aba59f322f pnpm --filter @webx/webxd test:routed-soak-phase2b -- --output=<outside-clean-tree-path> --soak-output=<outside-clean-tree-path>
```

Repository tests include 128 browser-runtime tests and 126 focused webxd Phase 2B tests. All listed gates passed before graphical qualification. `git diff --check` is rerun for the documentation-only commit.

The unrelated legacy `test:routed-soak` harness is not the Phase 2B.1 command. The directive names `test:routed-soak-phase2b`, which is the pinned process-isolated harness used above.

A fresh independent read-only acceptance review of the frozen code, documents, and all three evidence files returned **ACCEPT** with no concrete blocking request mismatch, factual contradiction, or in-scope safety failure (`res_01M18P4SJFMCZV2BCBVYFZR1FY`).

## Commits

- `7511a36 test(browser-runtime): reproduce overlapping captures`
- `854b000 feat(browser-runtime): arbitrate session captures`
- `2032118 fix(webxd): make shutdown cleanup-final`
- `7a85361 fix(browser-runtime): bound capture close settlement`
- `59746a1 test(browser-route): add capture contention qualification`
- `79254d6 fix(browser-route): pin qualification evidence`

## Remaining gaps and Phase 3 recommendation

Phase 2B.1 closes its capture arbitration and final qualification gate. Phase 3 development may begin as a separate task for the trusted local screenshot workspace and human-control boundary. It must remain above webxd/browserd authority, must not connect Tauri directly to browserd, must not expose model-facing frame subscriptions, and must not change the production backend default.

Production-default AgentCursor routing remains blocked by ADR-012 and later deployment, packaging, Chrome, display, and resource gates. This Phase 2B.1 soak does not prove a long-term Chrome memory plateau.

## Phase 3A follow-up

Phase 3A subsequently added and qualified the trusted read-only Tauri workspace without changing the Phase 2B.1 actor contract or its non-graphical recovery gate. It introduced the connection-bound actor role and the trusted-webxd-only workspace-broker role. See `PHASE3A-RESULTS.md`.

Phase 3B later versioned the private protocols as `browser.v3` and `workspace.v2` and qualified user-only human control without adding model-facing authority. Production routing still defaults to `legacy`, and ADR-012 remains unresolved. See `PHASE3B-RESULTS.md`.
