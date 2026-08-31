# ADR-022: Bind private human input to an exact painted frame

## Status

Accepted for Phase 3B.

## Decision

Human takeover and input are admitted only from the current Tauri-painted frame. Receipt, decode, or publication alone is insufficient. React acknowledges a paint to Tauri Rust; Rust retains the full private frame authority and sends browserd one exact binding containing runtime, session, tab, target, selection, subscription, control epoch, document generation, viewport generation, input-target generation, frame sequence, CSS dimensions, device-pixel ratio, capture time, and delivery identity.

Browserd accepts the binding only when it matches the current selected target and the connection-scoped delivered-frame ledger. Input batches additionally require the live lease, exact next sequence, current epoch and generations, finite in-bounds coordinates, bounded encoded bytes, freshness, and rate admission. A successful mutation closes the admission barrier until a newer frame is painted and acknowledged.

The input union supports pointer move; left, middle, and right press/release; double click; drag; horizontal and vertical wheel; key press/release/repeat; and bounded Unicode text. Batches contain at most 32 events. Pointer moves may coalesce before admission. Press/release transitions remain ordered and are never dropped. Release-only `pointerUp` and `keyUp` cleanup may bypass frame age, but it must still match held state and cannot carry a mutation.

React never receives the lease, control epoch, input-target generation, raw runtime/session/tab/target/subscription identity, socket path, descriptor, secret, human text history, or sensitive key identity. Rust validates frontend batches and owns private authority. Webxd keeps raw leases only per trusted socket client and returns sanitized acknowledgements. Retained evidence scans reject human-entered content and raw private identifiers.

## Rationale

A screenshot coordinate is meaningful only for the exact document, viewport, target, and paint the user saw. A newer received frame does not prove that the user saw it. The painted-frame barrier prevents stale clicks during animation, selection changes, reconnect, takeover, and post-input refresh.

## Consequences

- Control can be unavailable while a session is capture-cold, a selection has not painted, or a post-input frame is pending.
- Frontend input is bounded and backpressured; it is not an arbitrary JavaScript, CDP, or DOM-evaluation channel.
- Human input is private transient transport data and is absent from Pi presentations, model tools, retained JSON, screenshots, and normal logs.
- CDP virtual input is the supported path. Phase 3B does not add trusted OS pointer events, Wayland portal input, X11 XTest, active-window guessing, uploads, or downloads.

See ADR-021, ADR-023, and `PHASE3B-RESULTS.md`.
