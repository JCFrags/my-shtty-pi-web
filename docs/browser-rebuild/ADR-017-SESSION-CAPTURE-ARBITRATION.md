# ADR-017: Session capture arbitration and bounded screenshot recovery

Status: accepted for Phase 2B.1

## Context

Phase 2B had two independent screenshot producers in one browser session. `ObservationStore` captured explicit model observations while `FrameScheduler` captured replaceable workspace frames. The browser operation lane did not include the frame scheduler, so complete layout/capture/validation transactions could overlap against one Chrome compositor.

A barrier-driven test against required starting SHA `8504bd0f4d559cbeecf848ea729ecf5c970b030e` reproduced overlap in both frame-first and observation-first orderings. The fake CDP connection observed more than one active `Page.captureScreenshot` command in one session. This is the strongest structural explanation for the Phase 2B timeout, but the evidence does not prove it was the only cause.

## Decision

Each `BrowserSession` owns one `SessionCaptureCoordinator`. `ObservationStore` and `FrameScheduler` receive that same coordinator. Every production `Page.captureScreenshot` call occurs inside one coordinated transaction that includes:

1. overlay verification or installation;
2. pre-capture layout and identity read;
3. screenshot capture;
4. post-capture layout read;
5. target, CDP session, document, viewport, control epoch, dimensions, DPR, and scroll validation;
6. artifact and observation or frame commit.

Only one complete transaction may be active in one browser session. Different browser sessions retain independent coordinators and can capture concurrently.

Agent observations use a high-priority FIFO queue with at most eight queued requests. They are never silently replaced. Workspace frames keep at most one queued latest intent per tab and at most eight tab intents. A newer intent coalesces the old queued intent. After at most four consecutive agent transactions, one pending frame may run. An active frame is not preempted, but a queued agent runs before another frame unless the bounded fairness rule applies.

Cancellation removes queued work immediately and aborts active work. Tab close cancels that tab's capture work. Session close rejects queued work, aborts the active transaction, and settles the coordinator before resource cleanup. The coordinator's abort-aware execution wrapper also settles close when transaction code does not cooperate with its `AbortSignal`; late transaction completion cannot publish after the coordinator has settled it.

Diagnostic counters saturate safely. Queue and transaction distributions retain at most 2,048 samples. They contain timing and count data only and are not model-facing.

## Typed timeout and retry policy

`CdpConnection.send()` creates `CdpCommandTimeoutError` on its command timer. The safe structured identity contains the exact method, timeout in milliseconds, public `CDP_ERROR` code, and `retryable: true`. Classification uses the type and exact method, not message text. Late responses are ignored and pending state and timers settle once.

An explicit agent screenshot may make at most two `Page.captureScreenshot` attempts. A retry occurs only for a typed timeout from that exact CDP method. It preserves the public operation ID and overall deadline, waits only a short bounded delay, starts with a fresh layout read, and repeats all identity and post-capture checks. Cancellation, deadline expiry, disconnect, target failure, document/viewport/epoch change, decoding, dimensions, or artifact failure is not retried. A failed attempt commits no artifact, observation, or sequence.

A workspace-frame timeout is dropped without immediate retry. The next normal scheduler tick may try again. It cannot block a queued agent observation.

## Webxd cleanup consequence

`WebxdRuntime.stop()` is cleanup-final. Concurrent calls share one attempt. It settles clients and request controllers, clears bindings, closes the server, shuts down browser connections, and removes only its owned socket. Every stage runs even when an earlier stage fails; failures are returned as one `AggregateError`. A later call retries only residual cleanup. A stopped object is one-shot. Inode identity prevents an old instance from deleting a replacement socket.

## Evidence

Deterministic tests include:

- `same-session screenshot overlap correction` in `artifacts-frames-observations.test.ts`, in frame-first and observation-first order;
- `session capture coordinator` tests for per-session serialization, cross-session overlap, queue bounds, FIFO priority, bounded fairness, frame coalescing, cancellation, tab/session close, non-cooperative active work, and bounded metrics;
- `adversarial-cdp.test.ts` typed timeout, exact method/timeout identity, late response, pending cleanup, cancellation, disconnect, and ordinary failure classification;
- timeout recovery tests for one successful retry, two timeouts, identity changes, frame drop, and no failed-attempt commit;
- `runtime.test.ts` cleanup-final, concurrent stop, residual retry, one-shot restart rejection, and replacement socket safety.

The Fedora Chromium contention result at qualified code SHA `79254d6b30267432e35bec67cdb053aba59f322f` records 1,001 governed screenshot transactions: 784 agent attempts and 217 workspace attempts. Same-session maximum concurrency was 1. Cross-session concurrency was observed with process maximum 2 and 408 workload overlap events. It recorded zero typed timeouts, retries, recoveries, unrecovered failures, duplicate frame sequences, general-cache image bytes, held input, subscriptions, profiles, children, sockets, or descriptor leaks.

The uninterrupted final-code soak ran 1,800.578 seconds. It recorded 720 agent attempts, 2,974 workspace attempts, same-session maximum 1, process maximum 2, 429 workload overlap events, and zero typed timeouts, retries, recoveries, or unrecovered agent failures. Queue depths remained 1. General image-cache bytes remained zero and cleanup completed.

See `PHASE2B1-RESULTS.md` and `evidence/phase2b1-*-results.json`.

## Consequences

Capture coordination adds bounded queue wait but removes same-session compositor overlap. Agent work has priority without permanently starving workspace display. Cross-session parallelism remains available.

Phase 2B.1 qualifies the development route for Phase 3 work under its task gate. It does not resolve ADR-012, enable production-default AgentCursor routing, expose frame subscriptions to models, or authorize direct Tauri-to-browserd access.
