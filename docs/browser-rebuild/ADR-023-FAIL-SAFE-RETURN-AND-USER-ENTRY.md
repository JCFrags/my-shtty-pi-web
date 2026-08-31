# ADR-023: Return control through an independent lifecycle lane

## Status

Accepted for Phase 3B.

## Decision

Every user-visible exit from human control uses an independent bounded lifecycle request lane. Explicit return, hide, window close, emergency return, worker shutdown, frontend failure, channel closure, and stale desktop heartbeat first stop ordinary input admission, discard unsent mutations, serialize held releases, and attempt browserd control release. Hide and close remain visible when release fails. An ambiguous release drops the transport so browserd's disconnect grace can settle authority; it does not report success locally.

Takeover requires an explicit browser session and optional explicit tab. The fixed workspace executable accepts only bounded shell-free arguments. The Pi `/web workspace takeover <browserSessionId> [tabId]` and `/web workspace return` commands are user-only launcher actions. They are not SDK operations or model-facing tools. A takeover stages at most one bounded attempt, validates authoritative selection, waits for the exact current paint acknowledgement, and expires if its caller, connection, selection, or deadline disappears. Failed, abandoned, disconnected, expired, returned, or response-lost attempts cannot execute later.

No request can infer authority from the active browser tab, active desktop window, a recent selection, or a caller-supplied owner field. The workspace remains a single Tauri instance and continues to connect only to webxd.

## Rationale

The ordinary input queue can be full, blocked on a frame barrier, or disconnected precisely when cleanup is required. Using the same queue for return could leave a button held or browserd permanently human-owned. A separate lifecycle lane keeps return independent while browserd's lease and disconnect rules remain the final authority.

## Consequences

- `hide` and close are fail-safe operations, not unconditional window actions.
- Emergency return is available from the local frontend, but no model can request takeover, return, lease, input, selection authority, or a generic workspace command.
- Launcher arguments contain no secrets or leases and are passed with direct spawn, never a shell.
- Reconnect never resumes an old human lease. The user must acquire again from a new exact painted frame.
- Production routing remains `legacy` by default, and not launching the workspace is the Phase 3B rollback.

See ADR-021, ADR-022, and `PHASE3B-RESULTS.md`.
