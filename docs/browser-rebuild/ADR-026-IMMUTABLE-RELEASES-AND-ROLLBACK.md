# ADR-026: Immutable releases and rollback

## Status

Accepted and qualified in Phase 4A.

## Decision

Phase 4A builds only from an exact clean Git SHA into an external root. A release contains single-file production ESM bundles for browserd, webxd, and the Pi extension; a stdlib-only Python proxy with a fixed Fedora interpreter; a release-mode Tauri binary and RPM; protocols, deployment templates, licenses, manifest, and complete checksum inventory. Ordinary services do not execute TypeScript, pnpm, Cargo, Vite, or repository files.

The candidate uses isolated roots named `pi-web-phase4a`. Releases are immutable after publication. One owner-only atomic selector identifies current and previous releases. Configuration, state, cache, profiles, sockets, and ephemeral secrets remain outside release directories. Installation requires the expected 40-character Git SHA and manifest SHA-256.

The controller validates schema, checksums, modes, owner, link count, ancestor safety, release identity, protocol compatibility, packages, browser, display, disk, unit topology, and all prospective rendered bytes before service mutation. An owner-only mutation lock and bounded transaction journal recover interrupted activation. Rollback restores selector, configuration, managed bytes, and service active/enabled state. Uninstall preserves legacy bytes unless an explicit, marker-gated purge is requested.

Two-build reproducibility compares every immutable payload. RPM container metadata can contain timestamps, so comparison normalizes only the container and compares the complete RPM payload inventory, digest, size, mode, owner, and group.

## Verification

Exact candidate `phase4a-30d76dc608cf9ce62d4c887cada02e63e93967b9` passed two-build normalized reproducibility. Manifest SHA-256 is `fc0b0f7bf57dab1d37a219497431d97966ace5b7fe680b5b32c49ee4a346fb64`; checksum-document SHA-256 is `9b32b5ccfbbd58fd49ab7fc2813b448ea5fb291af2f9a4a1e39ca45f1c8aa522`. Detached verification, preflight, upgrade, rollback to `596730e`, reinstall, version, status, and doctor passed.

## Consequences

A source correction requires a new release ID, clean two-build run, reinstall, and qualification. Release binaries, build roots, profiles, and runtime state are not committed to Git.
