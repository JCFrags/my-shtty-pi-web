# Pi Browser Workspace

This package is the trusted Tauri desktop workspace for AgentCursor browser sessions. Phase 3A established read-only viewing; Phase 3B added user-only human takeover and fail-safe return.

## Trust boundary

The application path is React -> fixed Tauri commands and channels -> Rust workspace client -> private authenticated webxd `workspace.v2` Unix socket. It never connects to browserd directly. Rust alone discovers and validates the workspace descriptor and binding secret. The frontend receives only sanitized workspace state, frame metadata, and binary `ArrayBuffer` frame deliveries.

The frontend does not use fetch, WebSocket, EventSource, Node integration, remote webview content, descriptor reads, or base64 frames. It renders escaped text and local screenshot pixels under the restrictive Tauri CSP and main-window-only capability. During explicit user takeover it sends bounded pointer, wheel, key, and text input through Rust. It never receives a raw lease or exposes a model-facing operation; browserd remains the sole authority.

## User actions

The installed single-instance application accepts only these bounded fixed arguments:

```text
--raise
--hide
--select-session=<browser-session-id>
--select-tab=<tab-id>
--take-control
--return-control
```

Unknown production arguments are rejected. A later launch forwards the fixed action to the existing instance. Pi users can invoke the same behavior through `/web workspace show`, `/web workspace hide`, `/web workspace attach <browserSessionId> [tabId]`, `/web workspace takeover <browserSessionId> [tabId]`, and `/web workspace return` when AgentCursor is selected.

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

When webxd runs in legacy mode, the workspace shows that the AgentCursor browser workspace is not active. It does not call legacy workspace RPC and does not change `WEBX_BROWSER_BACKEND`. Takeover requires exact delivered-and-painted frame identity, browserd-owned control epochs, and a connection-bound lease. Return, hide, close, expiry, disconnect, and shutdown use the independent fail-safe return lane.

## Phase 4A installed bundle

The release builder produces a release-mode binary and RPM outside the checkout. Installation exposes `~/.local/bin/pi-web-workspace` through the atomic current selector; the app remains on demand and is not a systemd service. Installed acceptance qualified screenshot viewing and human takeover/return with Fedora Chromium. The actual login was Wayland; the qualification app used its tested X11 compatibility backend. Google Chrome, fractional scale, and multi-monitor were not tested.
