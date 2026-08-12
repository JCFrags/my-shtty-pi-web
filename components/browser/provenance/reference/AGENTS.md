# Agent implementation contract

Current phase: **Phases 1–6 are represented in production source; Phase 2 coordination is executable in the reference runtime. Fedora, real agent-browser, viewport, and password-manager gates require target-machine validation before a release tag.**

## Non-negotiable product rules

1. Capability comes first. Coordination, confirmation, redaction, isolation, and allowlists are optional controls; they must not remove ordinary browser capabilities or become the core architecture.
2. Every operation carries explicit `agentId`, `browserSessionId`, and `tabId` as applicable. Never introduce a process-global current browser, agent, session, or tab.
3. Minimize model observations, not browser capability. Default to main content and compact interactive references. Full backend output remains recoverable as an artifact.
4. Use typed JSON internally and newline-delimited JSON-RPC 2.0 on the local Unix socket. TOON is only a model-facing final encoding when it benchmarks smaller and remains clear.
5. Use agent-browser as an external dependency first. Do not fork it unless an ADR documents a measured, unavoidable limitation.
6. One Chromium host owns each persistent profile data directory. Multiple agents may share that host only through explicitly owned tabs.
7. Serialize backend operations that require `focus tab → act/observe → collect result`. Unrelated hosts must remain concurrent.
8. Human takeover is coordination, not authorization. Human input pauses conflicting actions for that tab; it must not constrain other tabs or hosts.
9. UI and browser execution remain separate. Tauri renders the workspace shell; Chromium or Lightpanda renders websites.
10. Unsupported backend capabilities return structured `unsupported` errors. Never claim success after silently changing engine, session, or state.
11. Preserve browser sessions across workspace restarts. Do not terminate selected, human-controlled, or persistent-profile hosts during idle cleanup.
12. Commit vertical slices that compile and test. Document architectural deviations before spreading workarounds.

## Review checklist

- IDs are explicit at daemon boundaries.
- Per-host/tab queue semantics are preserved.
- Large data has an artifact path and bounded model view.
- New policies are optional and off by default.
- The agent can still click, type, navigate, evaluate JavaScript, inspect network/console/storage, upload, download, use extensions, and operate arbitrary sites where the backend supports them.
- Tests include more than one agent and assert no cross-session leakage.
