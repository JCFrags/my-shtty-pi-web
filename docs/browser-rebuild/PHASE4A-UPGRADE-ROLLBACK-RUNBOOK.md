# Phase 4A upgrade and rollback runbook

## Upgrade

Build and verify a new exact-SHA release, then run the install command in `PHASE4A-INSTALL-RUNBOOK.md`. The controller records current and previous release identity in one atomic selector and preserves backend selection. It renders and validates all prospective bytes before changing services.

Verify:

```bash
~/.local/bin/pi-webctl version --json
~/.local/bin/pi-webctl status --json
~/.local/bin/pi-webctl doctor --json
```

## Roll back one candidate

```bash
~/.local/bin/pi-webctl rollback --json
```

Rollback restores the recorded previous release, backend, managed files, and exact active/enabled service state. It never maps a browser session into the restored daemon. Reload Pi and open new browser sessions after rollback.

## Select legacy without changing release

```bash
~/.local/bin/pi-webctl backend legacy
```

This keeps the candidate installed but starts only the legacy-selected webxd topology. There is no per-request fallback.

## Uninstall and reinstall

Remove candidate-managed files while restoring the preinstall legacy state:

```bash
~/.local/bin/pi-webctl uninstall --json
```

Use `--purge` only after reviewing retained candidate roots. Purge is marker- and allowlist-gated and still does not delete legacy roots. `uninstall-fedora.sh` is the separate destructive legacy/full-stack command and refuses to run while Phase 4A remains managed.

Reinstall with the exact install command and digests from the install runbook.

## Recovery

The controller uses an owner-only mutation lock and bounded transaction journal. A later command first recovers an interrupted activation. Do not manually edit selectors, journals, unit files, or managed root markers. If verification fails, preserve bounded controller output, use `doctor --json`, and roll back. Do not delete unknown files or weaken validation.

## Qualified rehearsal

Candidate `30d76dc` rolled back to `596730e`, passed version/status/doctor, and then reinstalled exact `30d76dc` with the same checks passing. Legacy nonempty roots remained unchanged.
