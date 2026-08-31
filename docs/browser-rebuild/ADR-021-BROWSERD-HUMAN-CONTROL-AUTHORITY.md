# ADR-021: Browserd owns human-control authority

## Status

Accepted for Phase 3B.

## Decision

Browserd owns the authoritative control state for each browser session. Control is either agent-owned, transferring, human-owned, or in bounded disconnected return. Every successful takeover and return advances a monotonic control epoch. A workspace client must acquire control with compare-and-swap semantics against the expected epoch and one exact control-eligible frame.

A successful acquire creates an opaque lease bound to the browserd connection, browser session, selected tab, control epoch, and input-target generation. The lease is never transferable and cannot be reclaimed after reconnect. Heartbeats keep it live. Expiry, workspace-broker disconnect, webxd loss, explicit return, session close, tab loss, browserd replacement, or bounded disconnected grace causes safe return or terminal session cleanup.

Agent observations and mutations are rejected with the typed retryable `CONTROL_HELD_BY_HUMAN` error while control is human-owned or transferring. They are not queued for later execution. Read-only session and tab visibility remains available. Browserd checks the control epoch again at execution boundaries, so an agent-user-agent ABA sequence cannot revive old work.

Browserd also owns the single physical input lane. Human batches and agent motor work share the session motor, but human samples do not call the AgentCursor path generator or create model operations. A failed or ambiguous dispatch settles held input before authority can return; if safe settlement is impossible, the session is closed rather than silently claiming agent ownership.

## Rationale

Workspace selection is presentation state, not authority. Keeping the epoch, lease, held-input state, and physical lane in browserd makes one component responsible for every browser mutation. Connection binding and monotonic epochs prevent stale workspace instances, response replays, reconnects, and old model work from acquiring authority implicitly.

## Consequences

- Private browser protocol is `browser.v3`; the public WebX browser contract remains `3.0.0`.
- Trusted webxd is the only workspace-broker client. Tauri still has no direct browserd connection.
- Raw lease IDs remain only in browserd and trusted webxd. Tauri Rust receives the private epoch, input-target generation, frame binding, and sequence needed for bounded requests. React receives only sanitized control state and bounded delivery fences.
- Control failures are typed and sanitized. Ownership failures do not disclose another actor's internal identity.
- Production browser routing still defaults to `legacy`; the legacy runtime remains installed and selectable.
- ADR-012 remains unresolved.

See ADR-022, ADR-023, `PROTOCOL-DRAFT.md`, and `PHASE3B-RESULTS.md`.
