# Phase 4A release notes

## Candidate

- Release: `phase4a-30d76dc608cf9ce62d4c887cada02e63e93967b9`
- Source: `30d76dc608cf9ce62d4c887cada02e63e93967b9`
- Manifest SHA-256: `fc0b0f7bf57dab1d37a219497431d97966ace5b7fe680b5b32c49ee4a346fb64`
- Fedora: 44 x86_64
- Browser: Fedora Chromium 151.0.7922.173
- Backend default: `legacy`

## Added

- privacy-preserving HMAC input retry identity at webxd and browserd;
- immutable single-file Node bundles, fixed stdlib Python proxy, release Tauri binary and RPM, complete manifests/checksums/licenses;
- strict Fedora preflight, atomic current/previous selector, interrupted activation recovery, upgrade, rollback, uninstall/reinstall, classified doctor;
- supervised canary proxy/browserd/webxd and on-demand desktop workspace;
- deterministic per-session, profile, and global browser resource supervision;
- installed-only deterministic acceptance and fixed 300-second soak harnesses.

## Qualification

The exact installed candidate passed two-build normalized reproducibility, detached verification, preflight, upgrade, installed two-actor Pi/browser/Tauri and human-control acceptance, browser outage/search-read independence, resource warning and hard limit, rollback to `596730e`, reinstall, and a 315.024-second fixed soak.

The user superseded the original four-hour soak with a maximum of ten minutes. This release does not claim four-hour evidence. It also does not claim Google Chrome, fractional-scale, or multi-monitor coverage. Qualification used Fedora Chromium in the actual Wayland login, with the Tauri qualification workspace forced through its tested X11 compatibility backend.

## Compatibility and recommendation

Public WebX and browser contract are 3.0.0; private protocols are `browser.v3` and `workspace.v2`. AgentCursor remains an explicit canary. Keep legacy as default for Phase 4A. Evaluate any default switch only in a separate Phase 4B decision after continued real use and environment coverage.
