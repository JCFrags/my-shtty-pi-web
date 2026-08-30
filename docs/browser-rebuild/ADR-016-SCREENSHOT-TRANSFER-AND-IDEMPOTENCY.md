# ADR-016: Exact screenshot transfer and route-aware idempotency

Status: accepted for Phase 2B

## Context

Phase 2A returned screenshot base64 in a successful POST response. WebX treated every successful POST or DELETE as a 15-minute idempotent mutation, so the general cache could retain image bytes. Webxd also kept one `latestScreenshot` buffer per browser session. Concurrent observations could overwrite each other and the retained bytes had no exact observation lifetime.

An HTTP cache hit could also appear to revive an observation after browserd had expired its observation, artifact, DOM handles, or document state.

## Decision

WebX classifies routes before applying idempotency:

1. `durable-mutation`: small session, tab, action, navigation, cancellation, and close results. These use the bounded 15-minute general mutation map.
2. `ephemeral-observation`: screenshot and DOM observation creation. These bypass the general map and rely on browserd operation identity and current resource validation.
3. `image-read`: exact screenshot image and frame bytes. These never enter the general map.
4. `none`: ordinary non-idempotent or independently cached reads.

Test diagnostics report entries and serialized bytes by policy and `imageBytesRetained`. The latter must always be zero. Normalized logs and compact details do not contain image base64.

A screenshot observation uses two public requests:

1. POST observation returns metadata only.
2. GET `/v1/browser/sessions/<session>/tabs/<tab>/observations/<observation>/image` returns the exact image for that actor, browser session, tab, and observation.

Webxd keeps no full screenshot buffer in `SessionBinding`. It keeps only bounded metadata with actor owner, session, tab, observation ID, browserd runtime instance, artifact ID, media type, byte length, digest, image dimensions, and monotonic expiry. Metadata is bounded by count and serialized bytes and is cleared on expiry, tab/session close, actor/runtime replacement, or shutdown.

For each image request, webxd resolves exact metadata, reads the owner-scoped browserd artifact in bounded chunks, validates canonical base64, exact total byte count, final EOF, media type, SHA-256, and PNG or JPEG dimensions, and returns bytes only for immediate SDK/Pi presentation. One retrieval does not consume or invalidate another valid observation.

The SDK and facade require the real observation ID. There is no synthetic latest-session screenshot.

## Retry and lifetime rules

A durable mutation retry uses the stable public WebX operation ID. Changed semantics with the same key remain a conflict.

A screenshot observation exact retry succeeds only while browserd's operation result, observation binding, and artifact remain usable. An image GET reads the live exact artifact every time. A DOM observation exact retry succeeds only while the observation, document, and handles remain usable. An operation record alone cannot revive a stale resource.

Relevant lifetimes remain distinct:

- WebX durable mutation idempotency: 15 minutes, at most 1,024 entries and 16 MiB;
- browserd operation records: bounded by operation-registry count and retention policy;
- screenshot observation: 60 seconds by default, configurable 10–120 seconds;
- DOM observation and handles: 60 seconds by default, separately configurable 10–120 seconds;
- screenshot artifact: valid only with its exact observation and artifact store record;
- workspace frame artifact: short-lived bounded frame ring.

Expired observation, missing artifact, expired handle, or changed document returns a typed stale or not-found response. WebX cannot substitute a stale cached public success.

## Evidence

Deterministic tests cover:

- zero image bytes and zero ephemeral/image entries in general idempotency;
- conflicting durable keys and exact mutation retry;
- concurrent exact observations on two tabs in one session;
- independent same-tab and cross-actor observations;
- foreign actor, wrong tab, expiry, close, and runtime replacement;
- canonical base64, full byte count, digest, media type, and image dimensions;
- screenshot artifact expiry, DOM expiry, and document change while an operation result remains;
- SDK/facade retrieval by the real observation ID.

The process-isolated route retrieved three concurrent images with distinct observation IDs, digests, and byte counts. The 30-minute soak completed 720 screenshot-plus-image requests. Final general idempotency held 475 durable entries and 283,984 serialized bytes, zero ephemeral entries, zero image entries, and zero image bytes. Webxd retained 22 metadata records using 21,130 bytes at the final sample and zero long-lived image buffers.

## Consequences

Screenshot delivery requires one metadata request and one exact image request. This extra request is accepted because it gives correct concurrency, lifetime, isolation, and memory behavior. The final soak's combined screenshot-plus-image route had 43.820 ms median and 507.081 ms p95 latency.

The future trusted workspace gateway can use browserd's separate frame subscriptions and artifacts. It must not turn frame events into model observations or expose a model-facing subscription tool.

This decision corrects the Phase 2A statement: image base64 was intended to stay out of general idempotency, but the old all-POST policy did not enforce that. Phase 2B now enforces and measures zero retained image bytes.
