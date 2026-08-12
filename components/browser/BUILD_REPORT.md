# Build and validation report

Report date: 2026-07-29

## Delivered source implementation

This repository implements the requested Fedora-oriented Pi browser workspace as a capability-neutral monorepo:

- Versioned newline-delimited JSON-RPC over a user-owned Unix socket, plus capability-token-protected loopback HTTP/WebSocket transport for the desktop workspace.
- Stable agent, client, host, browser-session, tab, profile, and artifact identities; no process-global current browser.
- A Rust coordinator with heartbeats, restart snapshots, explicit ownership checks, per-host queues, one-host-per-profile reuse, human-control gates, workspace events, browser routing, search/reader orchestration, and artifact fallback.
- An external `agent-browser` adapter with namespace/session isolation, tested-version bounds, persistent-profile and extension launch data, stable-to-backend tab mapping, atomic focus/action/observation, viewport discovery, debug operations, reconnect handling, and structured unsupported/errors.
- Explicit Rustwright and PinchTab adapter boundaries that report unsupported capabilities instead of silently changing engines or state.
- A Pi TypeScript extension with `/web` modes, `/browser` commands, dynamic tool activation, stable session registration, heartbeats, explicit tab addressing, abortable unbounded RPC by default, and compact artifact-backed results.
- A Tauri 2/React single-window workspace with agent/session/tab navigation, live streamed viewport input, human takeover/return, focus routing, activity, downloads/artifacts, profile editing, debug panels, and background-frame retention.
- Local SearXNG configuration, URL normalization and deduplication, Markdown-first reading, `.md`/`llms.txt` fallbacks, Trafilatura extraction, explicit Lightpanda/Chromium escalation, active-tab reading, Docling conversion, and content-addressed SQLite-backed artifacts.
- Fedora installer/uninstaller, user systemd units, rootless Podman Quadlet, desktop entry, diagnostics, fixtures, conformance scripts, benchmark scripts, and CI.

The original implementation brief is preserved at `docs/implementation-brief.md`.

## Capability posture

No domain permission gateway, mandatory allowlist, mandatory confirmation layer, forced redaction, fixed browser-operation deadline, or silent engine fallback is present. Optional timeouts, inactivity return, and resource limits are configuration. Model-facing bounds preserve the complete result in pageable artifacts. Human takeover coordinates conflicting work on a tab but does not remove browser capabilities.

## Validation completed in this build environment

The available environment provides Node.js 22, Python 3.13, uv, and Chromium, but not Rust/Cargo, pnpm dependencies, Podman, agent-browser, Lightpanda, or a Fedora desktop session. Within those constraints, the following executable checks passed:

- Repository architecture/source invariants.
- Protocol TypeScript compilation using the available global compiler.
- JavaScript contract and integration tests, including three-agent isolation, per-host serialization and cross-host concurrency, shared-profile ownership, human takeover, heartbeat recovery, workspace transport authentication, artifact paging, observation formatting, and workspace input contracts.
- Python reader and Docling unit tests.
- JavaScript syntax checks, Python bytecode compilation, and shell syntax checks.

The final command transcript and counts are regenerated before packaging and recorded in `VALIDATION.json`.

## Required target-machine release gates

These gates are implemented as scripts and documentation but cannot be truthfully marked passed in this container:

1. Compile and test the Rust workspace with Rust 1.88.
2. Install pnpm dependencies and build all TypeScript packages and the Tauri application.
3. Run on Fedora with the pinned Chromium, Lightpanda, and agent-browser versions.
4. Verify two named agent-browser sessions and dashboard discovery.
5. Verify bidirectional JPEG viewport streaming and input against a real session.
6. Complete the KeePassXC-Browser or local Vaultwarden password-manager feasibility spike in persistent headed and headless-new profiles.
7. Run the real browser fixture conformance suite, three-agent stress suite, recovery tests, and representative workflow benchmarks.
8. Validate rootless Podman SearXNG/Docling services and user-systemd installation from a clean Fedora account.

A release tag should be created only after those target-machine gates pass. Failures must be recorded as structured capability gaps or ADR-backed deviations; they must not be hidden by weakening the requested agent capability.
