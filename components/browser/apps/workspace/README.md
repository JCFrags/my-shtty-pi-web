# Pi Browser Workspace

This package is the Phase 3A read-only Tauri desktop workspace for AgentCursor browser sessions.

## Trust boundary

The application path is React -> fixed Tauri commands and channels -> Rust workspace client -> private authenticated webxd `workspace.v1` Unix socket. It never connects to browserd directly. Rust alone discovers and validates the workspace descriptor and binding secret. The frontend receives only sanitized workspace state, frame metadata, and binary `ArrayBuffer` frame deliveries.

The frontend does not use fetch, WebSocket, EventSource, Node integration, remote webview content, descriptor reads, or base64 frames. It has no browser pointer or keyboard input, takeover, return, cancellation, session mutation, or model-facing operation. It renders escaped text and local screenshot pixels under the restrictive Tauri CSP and main-window-only capability.

## User actions

The installed single-instance application accepts only these bounded fixed arguments:

```text
--raise
--hide
--select-session=<browser-session-id>
--select-tab=<tab-id>
```

Unknown production arguments are rejected. A later launch forwards the fixed action to the existing instance. Pi users can invoke the same behavior through `/web workspace show`, `/web workspace hide`, and `/web workspace attach <browserSessionId> [tabId]` when the AgentCursor backend is selected.

## Development and verification

```bash
pnpm --filter @pi-web/workspace test
pnpm --filter @pi-web/workspace build
cargo test --manifest-path components/browser/apps/workspace/src-tauri/Cargo.toml
pnpm --filter @pi-web/workspace tauri build --debug --no-bundle
pnpm --filter @pi-web/workspace test:binary-ipc
pnpm --filter @webx/webxd test:workspace-live
```

The normal test and build commands do not require a graphical display. The live route requires the local Fedora graphical session and Chromium. The exact-SHA 30-minute qualification command and results are in `docs/browser-rebuild/PHASE3A-RESULTS.md`.

## Runtime behavior

The app remains open through no-agent, unavailable, reconnecting, session/tab close, and browser replacement states. It selects one explicit tab at a time. Rust retains at most one in-flight and one pending frame. React retains one displayed frame and permits one live decoder object. A selection validates runtime, selection, session, tab, sequence, document, viewport, media, length, digest, and decoded dimensions before paint.

When webxd runs in legacy mode, the workspace shows that the AgentCursor browser workspace is not active. It does not call legacy workspace RPC and does not change `WEBX_BROWSER_BACKEND`. Human control remains Phase 3B.
