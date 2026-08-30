# ADR-015: Production observation lease and motor timing

Status: accepted for Phase 2B

## Context

Phase 2A production used a 3,000 ms screenshot freshness default while its headed harness used 30,000 ms. The Phase 2A routed motor path had a 5,214.985 ms median. The harness therefore did not prove that a production-configured model could inspect an image, reason, and complete a visible screenshot-bound click.

The motor also waited for every CDP sample acknowledgement in series. Long-run testing found that one background Chrome session could delay these acknowledgements by about five seconds even though its generated path was shorter than one second.

## Decision

Browserd accepts two independent service settings:

- `BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS`;
- `BROWSERD_DOM_OBSERVATION_TTL_MS`.

Each defaults to 60,000 ms and must be between 10,000 and 120,000 ms inclusive. Invalid service configuration fails startup. Expiry decisions use monotonic time. The public screenshot or DOM result contains the exact wall-clock `validUntil` derived at capture.

Time is only one guard. Screenshot-bound actions still require the exact actor, browser session, tab, target, document generation, viewport generation, control epoch, viewport dimensions, DPR, scroll, coordinates, deadline, and cancellation state. The runtime checks the relevant state again after path replay and before irreversible input. Expiry or any structural mismatch fails closed.

The 60-second default is a bounded initial allowance for model image delivery, inspection, reasoning, service queueing, and visible pointer travel. It is not a promise that page state remains stable for 60 seconds. Structural checks invalidate changed state immediately. Operators can reduce the value within the accepted range after representative task evidence.

The motor keeps AgentCursor's persistent persona and sampled path model. Ordinary paths within a 1,000 CSS-pixel viewport target:

- at least six distinct samples when distance permits;
- monotonic sample schedule and no teleport;
- median replay near 400–1,500 ms;
- p95 no more than 2,500 ms.

The runtime reports generated nominal path duration, replay wall time, cumulative and maximum CDP input latency, overlay update latency, post-path guard time, sample count, completion-after-path time, queue/dispatch timing, and total action time.

Sample input acknowledgements may be in flight concurrently inside a bounded pipeline. The motor waits for all admitted acknowledgements before completing and propagates any failure. This removes the sum of per-sample acknowledgement latency from visible path time without claiming dispatch before Chrome accepted the commands. Cancellation prevents new samples and cleanup handles recorded input state.

The dedicated Chrome process disables background timer throttling, renderer backgrounding, and window occlusion calculation. Each controlled tab enables CDP focus emulation. These settings do not disable sandboxing, site isolation, web security, or certificate validation and do not depend on OS active-window authority.

## Evidence

The final process-isolated route used the normal 60,000 ms default, no test freshness override, waited 10,004.351 ms after image delivery, and completed the bound click. Deterministic monotonic tests prove immediate admission, 30-second admission, expiry, configuration bounds, separate DOM lifetime, structural invalidation, and post-path failure.

The final uninterrupted Phase 2B soak recorded 705 motor paths:

- nominal median/p95: 541.775 / 732.930 ms;
- replay median/p95/max: 760.615 / 1,225.191 / 1,724.915 ms;
- action-route median/p95/max: 789.382 / 1,232.572 / 1,733.117 ms;
- sample-count median 16 and minimum 9;
- post-path guard p95 0 ms and maximum 1.034 ms.

The first long Phase 2B soak reproduced the background-session defect at 5,229.488 ms p95. Focus emulation plus bounded acknowledgement pipelining corrected it. Phase 2A's median was 5,214.985 ms.

## Consequences

A screenshot may be usable longer, so callers must not treat time as state identity. The structural and post-path guards are mandatory.

DOM lifetime can change independently from screenshot lifetime. Public SDK results expose its `validUntil` rather than hiding lifetime behind test configuration.

The latency gate applies to ordinary desktop distances. Longer movement can exceed it under the operation's bounded deadline. The implementation does not force every path to one duration or remove overshoot, curvature, jitter, dwell, off-center behavior, overlay updates, cancellation, or persistent persona state.

This decision does not establish a Chrome memory plateau and does not enable production-default AgentCursor routing.
