# ADR-018: Trusted workspace authority

## Status

Accepted for Phase 3A. Extended by ADR-021 through ADR-023 for Phase 3B.

## Decision

The read-only desktop workspace uses this authority path:

```text
Tauri React frontend
  -> fixed Tauri commands and channels
  -> Tauri Rust workspace client
  -> authenticated private webxd workspace Unix socket
  -> trusted webxd workspace gateway
  -> browserd workspace-broker connection
  -> BrowserRuntime
```

Browserd private protocol `browser.v2` has mutually exclusive actor and workspace-broker roles. An actor connection is bound once to one actor. A workspace-broker connection authenticates with the separate `workspaceBrokerSecret`, carries no caller-selected actor identity, and can use only the bounded read-only workspace command set. Role rebinding closes the connection.

Webxd is the only production browserd client for the workspace role. It derives bounded agent labels, holds the browserd workspace secret, and publishes a separate `workspace.v1` Unix-socket gateway. Tauri Rust validates and authenticates that gateway. The React frontend receives only sanitized state, frame metadata, and raw binary frame bytes.

Workspace snapshots exclude principal secrets, browser target and CDP identities, process IDs, profile paths, proxy data, typed text, DOM content, cookies, headers, storage, and operation arguments. Per-connection frame ledgers authorize only exact artifacts delivered through that connection's live subscription.

## Consequences

- Tauri JavaScript cannot connect to browserd or a Unix socket.
- Tauri Rust never connects directly to browserd.
- Browser pages are never loaded in the Tauri webview.
- Browserd restart invalidates old sessions instead of remapping them.
- Webxd restart can reconnect to the surviving browserd and restore visibility.
- The boundary protects against untrusted page content and accidental authority exposure. It does not protect against malicious code already running as the same Unix user.
- Phase 3A adds no model-facing workspace operation and no browser mutation.

## Phase 3B extension

Phase 3B preserves this authority path and role separation while versioning the private protocols as `browser.v3` and `workspace.v2`. The workspace-broker role now carries bounded control and input commands for trusted webxd. Browserd owns the lease and epoch; webxd holds the raw lease for one trusted desktop connection; Tauri Rust receives only the private epoch, input-target generation, exact painted-frame binding, and sequence needed for the next bounded request. React receives no raw authority or internal identity. No model-facing workspace control operation was added. See ADR-021 through ADR-023 and `PHASE3B-RESULTS.md`.

## Rejected alternatives

- A direct Tauri-to-browserd connection would duplicate trusted-client authority and expose browserd discovery to the desktop process.
- Frontend HTTP, WebSocket, or Unix-socket access would expose transport authority to JavaScript.
- Actor impersonation by webxd or Tauri would weaken the existing connection-bound actor model.
- Reusing actor or navigation secrets would collapse separate trust roles.
