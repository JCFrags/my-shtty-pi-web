# Browser component

This directory contains the retained legacy browser stack, reader/document services, and the replacement AgentCursor runtime and trusted Tauri workspace developed on `rebuild/screenshot-first-browser`.

## Current Phase 4A architecture

The replacement browser path is explicit and screenshot-first:

```text
Pi extension -> webxd -> actor-bound browser.v3 connection -> browserd -> isolated Chromium session
Tauri React -> Tauri Rust -> private workspace.v2 webxd gateway -> browser.v3 workspace-broker role
```

Trusted webxd is the only production browserd client. Actor connections remain bound to one Pi actor. The separate workspace-broker role supplies sanitized aggregate state, exact subscribed frames, and private human-control authority. Tauri does not connect directly to browserd. React receives no raw lease, descriptor, secret, Unix-socket path, CDP endpoint, profile path, or proxy detail.

The workspace under `apps/workspace/` renders local UI and raw binary screenshot frames on a canvas. It can list and select concurrent agent sessions and explicit tabs, show the captured virtual cursor, recover from daemon replacement, and send bounded user input only after exact painted-frame takeover. Browserd owns epochs, leases, agent exclusion, input serialization, held-input cleanup, and fail-safe return. Human control is absent from model tools.

## Backend selection

`WEBX_BROWSER_BACKEND` is immutable for one webxd process, accepts `legacy` or `agentcursor`, and defaults to `legacy`. The legacy browser runtime remains installed and selectable. AgentCursor uses the public path `agentcursor/chrome`; it is not the production default. Search and direct read do not depend on browserd.

## User workspace commands

For the AgentCursor backend, the user-only commands are:

```text
/web workspace show
/web workspace hide
/web workspace attach <browserSessionId> [tabId]
```

Takeover and return use the fixed user-only commands `/web workspace takeover <browserSessionId> [tabId]` and `/web workspace return`. All workspace commands launch one fixed validated Tauri executable directly without a shell and use single-instance forwarding. The model receives no aggregate workspace, control, lease, or launcher tool.

## Main implementation paths

- `../../packages/browser-protocol/`: private `browser.v3` actor and workspace-broker schemas.
- `../../packages/browser-runtime/`: persistent CDP runtime, isolated sessions, capture coordinator, snapshots, and frame subscriptions.
- `../../apps/browserd/`: private browser authority service.
- `../../apps/webxd/`: trusted actor adapter and private workspace gateway.
- `../../packages/workspace-protocol/`: bounded `workspace.v2` schema and binary framing.
- `apps/workspace/`: Tauri Rust client and React trusted viewer/control UI.
- `services/reader/`: direct-reading support.
- `services/docling/`: optional bounded document conversion.

## Verification

Use repository commands and evidence from `docs/browser-rebuild/PHASE4A-RESULTS.md`. Normal CI includes protocol, runtime, browserd, webxd, Pi, SDK, frontend, Rust, typecheck, lint, build, binary IPC, release, installer, and security tests. Installed graphical qualification uses Fedora Chromium plus the real release Tauri app.

ADR-012 is resolved for the Phase 4A canary through tested hard containment and the user-shortened installed soak. Production-default AgentCursor routing, broader display coverage, Google Chrome coverage, hostile same-UID isolation, and a general long-term Chrome plateau claim remain open.
