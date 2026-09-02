# browserd

`browserd` is the separate persistent AgentCursor browser authority. Production accepts only trusted webxd actor and workspace-broker connections over owner-only Unix sockets. One ready browser session owns one isolated Fedora Chromium process, one disposable profile, one persistent browser CDP connection, and one human-style motor. Requests use explicit session, tab, observation, document, viewport, epoch, and actor identity; there is no active-tab authority.

The daemon does not expose arbitrary JavaScript evaluation, executable paths, Chrome flags, profiles, MCP, the AgentCursor extension, or public CDP. Navigation requires signed webxd authorization and the reviewed loopback proxy. Browser replacement invalidates old sessions rather than remapping them.

## Phase 4A production runtime

The immutable release bundles browserd as one production ESM file and supervises it with `pi-web-agentcursor-browserd.service`. Strict installed configuration defaults to at most two sessions and rejects unknown resource variables. Candidate resource defaults are:

- per-session PSS warning/hard: 1,024/1,280 MiB;
- global Chrome PSS hard: 4,096 MiB;
- profile warning/hard: 512/1,024 MiB;
- sample/drain/emergency wait: 5/30/15 seconds.

A hard limit fences new authority with `BROWSER_RESOURCE_LIMIT`, removes subscriptions, settles operations and human return, and closes only the exact affected process/profile boundary. It never signals an unrelated process or creates a replacement under the old session ID. Owner-scoped terminal classification is bounded to 64 entries and 60 seconds and preserves cross-owner nondisclosure.

See `docs/browser-rebuild/ADR-027-BROWSER-RESOURCE-SUPERVISION.md` and `docs/browser-rebuild/PHASE4A-RESULTS.md`.
