# ADR-025: Fedora user-service topology

## Status

Accepted and qualified in Phase 4A on Fedora 44.

## Decision

The installed topology is:

- Pi -> installed Pi WebX extension -> webxd actor Unix socket;
- Tauri React -> Tauri Rust -> webxd workspace Unix socket;
- webxd -> private browserd actor and workspace-broker connections;
- browserd -> one isolated Chromium process and disposable profile per browser session;
- Chromium -> reviewed loopback egress proxy -> public network.

`webxd.service` remains the one canonical WebX authority. The canary adds `pi-web-agentcursor-egress-proxy.service` and `pi-web-agentcursor-browserd.service`. Webxd has ordered soft dependencies, not a hard dependency that would disable search or static read when browser services fail. The Tauri workspace is an on-demand release binary and is not a service.

Units use fixed installed executables and arguments, owner-only runtime roots, restrictive umask, no shell command channel, bounded restart policy, and systemd sandboxing that is compatible with the immutable user release and Chromium. Runtime sockets and descriptors are mode `0600`; their directories are mode `0700`. CDP and proxy listeners remain loopback-only.

Backend selection is rendered once for each webxd process. Legacy mode neither starts nor falls back to AgentCursor. AgentCursor mode requires explicit controller selection. Candidate unit names do not collide with the legacy `pi-browserd.service` or legacy roots.

## Verification and limits

Installed `systemd-analyze security` reported MEDIUM exposure scores of 5.6 for the proxy, 6.5 for browserd, and 5.6 for webxd. These are review inputs, not a claim of hostile same-UID isolation. Version, status, doctor, reboot recovery, browser outage recovery, and search/read independence passed for the exact candidate. See `evidence/phase4a-systemd-security.json`.

## Consequences

A browser or proxy outage does not remove healthy search and read. Rollback can restore the previous immutable candidate and exact service state. Same-UID cooperative processes remain inside the stated trust boundary.
