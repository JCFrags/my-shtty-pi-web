# Phase 4A results

## Disposition

Phase 4A is accepted as an immutable, explicit AgentCursor canary on Fedora 44. The repository and installed default remain `legacy`; legacy bytes and data remain functional and rollback remains available. No merge to `main` is authorized.

## Identity

- Starting SHA: `14d196a3d8eb0aebad86ed335a478d85425d8cca`
- Gate 0 SHA: `a783be3` (input integrity through `5fd91b0`, root lint and release CI at `a783be3`)
- Qualifying code SHA: `30d76dc608cf9ce62d4c887cada02e63e93967b9`
- Release ID: `phase4a-30d76dc608cf9ce62d4c887cada02e63e93967b9`
- Manifest SHA-256: `fc0b0f7bf57dab1d37a219497431d97966ace5b7fe680b5b32c49ee4a346fb64`
- Checksum-document SHA-256: `9b32b5ccfbbd58fd49ab7fc2813b448ea5fb291af2f9a4a1e39ca45f1c8aa522`
- Final documentation SHA: the Git commit containing this result set; reported after commit because a commit cannot embed its own SHA.

## Build and CI

Root lint, typecheck, complete serialized pnpm tests, both generated-schema checks, exact Rust 1.88 workspace tests, Python proxy tests, profile/controller/release-builder tests, Tauri frontend and Rust checks, and supply-chain checks passed for the final source lineage. Browser runtime had 170 tests and webxd 144 tests in the final full run.

The packaging strategy is esbuild single-file ESM production bundles, a stdlib-only Python proxy with fixed Fedora interpreter, and a release-mode Tauri binary plus RPM. Runtime services use no checkout, source TypeScript, development `node_modules`, Vite, or Cargo target tree.

Two external builds passed normalized reproducibility. Only RPM container metadata is normalized; complete RPM payload files, digests, sizes, modes, owners, and groups are compared. First and second manifest digests were `fc0b0f7bf57dab1d37a219497431d97966ace5b7fe680b5b32c49ee4a346fb64` and `a8319b69eeaa197dbc0b815681d6a3ecb5108915f253e1886cb4fe329a1cddea` because reviewed RPM-container metadata differs.

GitHub CI previously passed all eight available jobs at exact `b16fbc3` (run 33487997836), including Fedora two-build reproducibility. Final documentation push status is recorded in the delivery response.

## Installed layout and topology

Candidate state is isolated under XDG roots named `pi-web-phase4a`; immutable releases are below the data root and selected through an atomic owner-only pointer. Configuration, state, cache, profiles, sockets, and secrets are outside release bytes. `~/.local/bin/pi-webctl` and `~/.local/bin/pi-web-workspace` point through the current selector.

Supervised units are `pi-web-agentcursor-egress-proxy.service`, `pi-web-agentcursor-browserd.service`, and canonical `webxd.service`. Tauri is on demand. Installed systemd security exposure was MEDIUM: 5.6, 6.5, and 5.6 respectively. This is cooperative same-UID isolation, not a hostile same-UID claim.

## Environment

Qualification used Fedora 44 x86_64, Chromium 151.0.7922.173, and the actual GNOME Wayland login. The Tauri qualification workspace used its tested `GDK_BACKEND=x11` compatibility route. Google Chrome was not installed or tested. Fractional scale and multi-monitor were not qualified. No OS pointer injection is claimed.

## Installation lifecycle

Detached verification and closed preflight passed. The first isolated candidate clean install and explicit AgentCursor activation passed. Exact immutable upgrade then installed `30d76dc`; version, status, and doctor passed. Candidate rollback restored `596730e` and its service state; version/status/doctor passed. Reinstall of exact `30d76dc` passed the same checks. Earlier candidate non-purge uninstall restored the preinstall legacy webxd active and enabled. Legacy nonempty roots remained preserved throughout.

Current installed doctor passes release, filesystem, services, display, browser, egress, authority, and resource checks. It truthfully marks live workspace readiness `not-tested`; installed acceptance proves that separate path.

## Installed acceptance

The immutable installed acceptance completed in 17.838 seconds. It used two actors and deterministic loopback fixtures. All checks passed: screenshots, DOM action, two-actor isolation, workspace paint, human takeover/return, ownership nondisclosure, proxy and webxd restart, three browserd replacements, browser-outage denial and recovery, three search/read checks including during browser outage, one resource warning, one typed hard resource limit, cleanup, and restoration of ordinary services.

Resource terminal status is owner-scoped, retained for at most 60 seconds and 64 entries, returns the same-owner typed limit, and does not disclose cross-owner existence. No session was recycled or remapped.

## Resource policy

Candidate defaults are 1,024/1,280 MiB per-session soft/hard PSS, 4,096 MiB global Chrome PSS, 512/1,024 MiB profile soft/hard, 5-second sampling, 30-second drain, 15-second emergency close wait, and at most two installed sessions. A hard limit fences authority, settles operations and human return, and closes only the affected exact process/profile boundary.

## Fixed installed soak

The user superseded the original 14,400-second requirement. Every soak-like command was limited to ten minutes; the production harness uses a fixed 300-second workload and a 600-second subprocess cap. The exact candidate passed uninterrupted in 315.024 seconds.

Metrics: 23 iterations; 5 human control cycles; 5 Pi reconnects; one proxy restart; one webxd restart; one browserd replacement; 2 ownership denials; one outage denial; 3 search/read checks; 26 actions; 38 observations; 7 workspace samples. Observation maximum was 30.698 ms and workspace maximum 650.564 ms. There were 23 memory samples: start 670,356 KiB, end 660,692 KiB, minimum 474,260 KiB, maximum 694,004 KiB, elapsed 288.215 seconds, fitted slope -120,709.733 KiB/hour.

A five-minute run cannot support final-two-hour, final-hour, or final-30-minute segment slopes. The bounded final report also does not retain separate browserd, webxd, Tauri/WebView, or per-Chromium-tree regressions. No absent values are invented. The observed aggregate full-window slope was negative, and the independently tested hard supervisor supplies deterministic containment. This is not a general Chrome plateau claim.

## Security and privacy

Input retries use independent ephemeral HMAC-SHA-256 digests at webxd and browserd. Exact retry returns one acknowledgement; a semantic conflict is typed and dispatches nothing. Evidence and privacy scans retained no human input, page body, descriptor, socket secret, profile path, or raw terminal session. Release verification covers modes, owner, link count, symlink/ancestor safety, exact SHA, protocol compatibility, complete payload checksums, license closure, and rollback identity. Dependency and vendored-source checks passed.

Independent orchestration and audits were suspended by explicit user instruction after orchestration failures. Final acceptance therefore uses direct self-review and deterministic evidence; it does not claim a later independent audit.

## Recommendation

Keep AgentCursor non-default after Phase 4A. Use the canary for bounded real operation and collect longer passive evidence without exceeding user-approved test durations. Decide a default cutover only in Phase 4B, with separate approval and no removal of rollback until that decision passes.
