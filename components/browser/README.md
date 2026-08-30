# Browser component

This directory contains the retained legacy browser stack, reader/document services, and the replacement AgentCursor runtime and read-only Tauri workspace developed on `rebuild/screenshot-first-browser`.

## Current Phase 3A architecture

The replacement browser path is explicit and screenshot-first:

```text
Pi extension -> webxd -> actor-bound browser.v2 connection -> browserd -> isolated Chromium session
Tauri React -> Tauri Rust -> private workspace.v1 webxd gateway -> browser.v2 workspace-broker role
```

Trusted webxd is the only production browserd client. Actor connections remain bound to one Pi actor. The separate workspace-broker role is read-only and supplies sanitized aggregate state plus exact subscribed frames. Tauri does not connect directly to browserd. React receives no descriptor, secret, Unix-socket path, CDP endpoint, profile path, or proxy detail.

The workspace under `apps/workspace/` renders local UI and raw binary screenshot frames on a canvas. It can list and select concurrent agent sessions and explicit tabs, show the captured virtual cursor, and recover from webxd restart or browserd replacement. It has no browser pointer/keyboard input, takeover, return, cancellation, navigation, or model-facing workspace operation. Human control remains Phase 3B.

## Backend selection

`WEBX_BROWSER_BACKEND` is immutable for one webxd process, accepts `legacy` or `agentcursor`, and defaults to `legacy`. The legacy browser runtime remains installed and selectable. AgentCursor uses the public path `agentcursor/chrome`; it is not the production default. Search and direct read do not depend on browserd.

## User workspace commands

For the AgentCursor backend, the user-only commands are:

```text
/web workspace show
/web workspace hide
/web workspace attach <browserSessionId> [tabId]
```

They launch one fixed validated Tauri executable directly without a shell and use single-instance forwarding. Takeover and return explicitly report unavailable until Phase 3B. The model receives no aggregate workspace or launcher tool.

## Main implementation paths

- `../../packages/browser-protocol/`: private `browser.v2` actor and workspace-broker schemas.
- `../../packages/browser-runtime/`: persistent CDP runtime, isolated sessions, capture coordinator, snapshots, and frame subscriptions.
- `../../apps/browserd/`: private browser authority service.
- `../../apps/webxd/`: trusted actor adapter and private workspace gateway.
- `../../packages/workspace-protocol/`: bounded `workspace.v1` schema and binary framing.
- `apps/workspace/`: Tauri Rust client and React read-only viewer.
- `services/reader/`: direct-reading support.
- `services/docling/`: optional bounded document conversion.

## Verification

Use repository commands from `docs/browser-rebuild/PHASE3A-RESULTS.md`. Normal CI includes protocol, runtime, browserd, webxd, Pi, SDK, frontend, Rust, typecheck, lint, build, binary IPC, and security tests. The graphical live route and exact-SHA 30-minute soak are opt-in and use Fedora Chromium plus the real Tauri app.

ADR-012, production-default AgentCursor routing, human takeover, packaging, broader display coverage, Google Chrome coverage, and long-term Chrome memory policy remain open.
