# ADR-020: Read-only workspace before takeover

## Status

Accepted for Phase 3A.

## Decision

Phase 3A is a privileged cross-agent viewer, not a browser controller. It can list sanitized AgentCursor sessions and tabs, select one explicit tab, display continuous screenshot frames, and show bounded status. It cannot send pointer or keyboard input, take or return control, cancel operations, close sessions or tabs, navigate, or mutate browser state.

The frontend contains no browser input handlers or misleading takeover control. The user-only Pi command can show, hide, or attach the fixed workspace executable. `takeover` and `return` respond that the operation is unavailable. No workspace operation is added to the model-facing contract.

Human takeover is deferred to Phase 3B. That phase must separately design and qualify controller epochs, queued and running action settlement, user interrupt, return-to-agent behavior, and the agent-user-agent ABA race. Read-only qualification does not authorize those changes.

## Rationale

The workspace broker can observe every local agent session, so it crosses actor boundaries by design. Qualifying that narrow viewer separately avoids combining cross-agent observation, human input, and controller mutation in one trust-boundary change.

## Consequences

- The UI says `Viewing agent control` and `Read-only workspace`.
- `cancellable` in an operation summary is informational only.
- Tauri capabilities grant no shell, process, filesystem, HTTP, WebSocket, opener, clipboard, upload, or download permission.
- Production-default AgentCursor routing remains disabled. `WEBX_BROWSER_BACKEND` still defaults to `legacy`, and the legacy runtime remains installed and selectable.
- ADR-012 remains unresolved.
