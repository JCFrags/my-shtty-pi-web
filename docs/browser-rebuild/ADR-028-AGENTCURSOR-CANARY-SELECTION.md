# ADR-028: AgentCursor canary selection

## Status

Accepted for explicit Phase 4A canary use. It does not authorize a default switch.

## Decision

Repository and installed configuration default to `WEBX_BROWSER_BACKEND=legacy`. The `browser-agentcursor` installation profile is distinct from the legacy `browser` profile. Only the user-facing immutable controller can change the process-level backend:

```bash
~/.local/bin/pi-webctl backend agentcursor
~/.local/bin/pi-webctl backend legacy
```

Selection renders one fixed backend into webxd configuration and restarts the reviewed topology. Requests cannot choose a backend, fall back, supply executable paths or Chrome flags, or remap an old session. A browserd replacement invalidates old AgentCursor sessions; actors must open new sessions. Legacy installation bytes and nonempty legacy `pi-web` roots remain preserved.

The canary requires verified immutable bytes, Fedora preflight, reviewed Chromium, healthy loopback proxy, browserd, webxd, and classified doctor findings. The installed Tauri workspace is on demand. Search and direct read remain independent during browser outages.

## Phase 4A evidence

The exact installed candidate passed two-actor Pi/browser/Tauri acceptance, ownership nondisclosure, human takeover/return, proxy/webxd/browserd restart and recovery, resource warning and hard-limit behavior, rollback/reinstall, and the user-shortened fixed 300-second soak. The soak does not represent the original four-hour request; the user explicitly superseded it with a maximum of ten minutes.

## Consequences

Phase 4B may evaluate a default cutover, but only as a separate decision. Phase 4A keeps AgentCursor opt-in, legacy default and functional, and deterministic rollback available.
