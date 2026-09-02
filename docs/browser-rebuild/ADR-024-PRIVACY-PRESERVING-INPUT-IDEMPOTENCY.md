# ADR-024: Privacy-preserving input idempotency

## Status

Accepted and qualified in Phase 4A.

## Context

A retry key that binds only an event sequence and event-kind counts can confuse a changed human input batch with an exact retry. Retaining ordinary hashes would also expose low-entropy human input to offline guessing.

## Decision

The trusted webxd workspace gateway and browserd human-input ledger independently canonicalize the complete normalized input semantics. The canonical record binds the ordered events, coordinates, button and click count, wheel deltas, key code and location, modifiers, repeat state, Unicode text, session, tab, control epoch, input target generation, painted frame identity, document and viewport generations, and batch sequence. Transport request IDs, deadlines, and connection-local correlation fields are excluded.

Each layer computes HMAC-SHA-256 with its own ephemeral random key. Keys are not persisted or exposed to Rust, React, logs, metrics, evidence, or model tools. Retained records contain only the keyed digest and bounded acknowledgement. A new webxd process and a new browserd lease use new digest scopes.

An exact sequence, operation, and semantic digest returns the original acknowledgement without dispatch. A conflicting sequence or operation returns typed `CONTROL_LEASE_CONFLICT` and dispatches nothing. Old and gapped sequences remain typed failures. Digest failure fails closed: webxd releases the trusted desktop connection and browserd ends only the affected session.

## Verification

Commits `5ca640c` and `5fd91b0` added deterministic gateway, ledger, and real runtime tests. They change each required field while preserving event kinds and counts, including one point in a multi-event drag. Tests prove one CDP side effect for an exact retry, no side effect for conflicts, typed failures, and no plaintext human value in retained state, errors, diagnostics, snapshots, or qualification evidence.

The exact Phase 4A candidate at `30d76dc608cf9ce62d4c887cada02e63e93967b9` passed installed human takeover/return and the bounded privacy scans.

## Consequences

Retry integrity no longer requires storing human input or an unkeyed digest. Restarting a trusted process intentionally ends that process-local retry scope; it does not reclaim or silently remap human authority.
