# Phase 4A operations runbook

## Normal checks

```bash
~/.local/bin/pi-webctl status --json
~/.local/bin/pi-webctl doctor --json
systemctl --user --no-pager --full status \
  pi-web-agentcursor-egress-proxy.service \
  pi-web-agentcursor-browserd.service webxd.service
```

Healthy AgentCursor state has all three units active and enabled. Doctor must pass release, filesystem, services, display, browser, egress, authority, and resource categories. Workspace live readiness is intentionally `not-tested` by doctor.

## Browser outage

Search and direct read must remain available. Inspect bounded service status and recent journal lines; do not publish raw page, input, descriptor, or secret content. Restart only the failed candidate unit, then wait for doctor authority health. Existing browser sessions do not survive browserd replacement and must not be remapped.

```bash
systemctl --user restart pi-web-agentcursor-browserd.service
~/.local/bin/pi-webctl doctor --json
```

## WebX socket failure

The systemd unit owns its runtime directory. A manual directory is not a durable repair.

```bash
systemctl --user show webxd.service -p RuntimeDirectory -p RuntimeDirectoryMode
systemctl --user restart webxd.service
~/.local/bin/pi-webctl doctor --json
```

Reload Pi after a startup-time extension failure.

## Resource supervision

A warning permits current work and exposes only a bounded private reason. A hard limit fences new authority with `BROWSER_RESOURCE_LIMIT`, removes subscriptions, settles operations and human return within the drain budget, and closes only that session. The actor opens a new session. Never raise limits to hide a reproduced leak.

## Logs and privacy

Use bounded journal queries such as `journalctl --user -u UNIT -n 100 --no-pager`. Do not retain raw terminal sessions. Evidence must omit page text, human input, URLs with credentials, descriptors, secrets, PIDs, profile paths, and private runtime identities.

## Rollback

Use `~/.local/bin/pi-webctl rollback --json` for a candidate regression or `backend legacy` to keep the release installed while returning to the default backend. See the rollback runbook for uninstall and recovery.
