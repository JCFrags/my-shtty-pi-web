# Phase 4A install runbook

Phase 4A supports Fedora 44 x86_64 and a reviewed graphical user session. It does not install packages or a browser automatically.

## Build and verify

Start at one clean committed SHA. Use exact Rust 1.88.0 for Fedora release builds.

```bash
pnpm release:reproducibility -- --expected-sha "$SHA" --work-root "$HOME/.cache/pi-web/phase4a-repro-$SHA"
```

Use the first verified release root from that run. Record its manifest SHA-256.

## Preflight

```bash
~/.local/bin/pi-webctl preflight \
  --release "$RELEASE" \
  --expected-sha "$SHA" \
  --manifest-sha256 "$MANIFEST_SHA256" --json
```

Do not continue after an error. Preflight is non-mutating and checks release identity, immutable bytes, Fedora and architecture, user systemd and DBus, display, reviewed browser, runtime/data capacity, conflicts, and prospective installed bytes.

## Install or upgrade

```bash
~/.local/bin/pi-webctl install \
  --release "$RELEASE" \
  --expected-sha "$SHA" \
  --manifest-sha256 "$MANIFEST_SHA256" --json
```

A first install selects `legacy`. An upgrade preserves the selected backend. Activate the canary only explicitly:

```bash
~/.local/bin/pi-webctl backend agentcursor
```

## Verify

```bash
~/.local/bin/pi-webctl version --json
~/.local/bin/pi-webctl status --json
~/.local/bin/pi-webctl doctor --json
systemctl --user status pi-web-agentcursor-egress-proxy.service \
  pi-web-agentcursor-browserd.service webxd.service
~/.local/bin/pi-web-workspace --raise
```

Doctor intentionally reports live workspace readiness as `not-tested`; the installed acceptance harness tests it. Reload Pi after changing the installed extension or after an earlier WebX startup failure.

## Installed roots

The candidate uses isolated `pi-web-phase4a` roots under XDG data, config, cache, state, and runtime directories. `~/.local/bin/pi-webctl` and `~/.local/bin/pi-web-workspace` point through the atomic current selector. Existing legacy `pi-web` roots are not adopted or purged.
