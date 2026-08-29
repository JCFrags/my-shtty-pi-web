# Phase 0 results

## Verdict

The custom CDP browser driver is viable. The two-agent proof passed end to end. It used two persistent headed Chromium processes, two private temporary profiles, two loopback debugging endpoints, two explicit targets, and one long-lived Node runtime. Human-style cursor samples updated visible page overlays. Screenshot observations and explicit accessibility fallback both worked. The viewer received repeated frames for both sessions. Warm actions did not launch another Node, MCP, CLI, or browser process.

No existing production browser implementation was deleted or routed through the spike.

## Exact commands used

From the repository root:

```bash
git clone https://github.com/JCFrags/my-shtty-pi-web.git /home/mainpc/Projects/my-shtty-pi-web
git fetch origin main
git switch -c rebuild/screenshot-first-browser origin/main
pnpm install --frozen-lockfile=false
pnpm --filter @webx/screenshot-first-browser-spike typecheck
pnpm --filter @webx/screenshot-first-browser-spike test
pnpm --filter @webx/screenshot-first-browser-spike exec tsx src/verify.ts
pnpm install --frozen-lockfile
pnpm exec eslint spikes/screenshot-first-browser/src spikes/screenshot-first-browser/tests
pnpm --filter @webx/screenshot-first-browser-spike verify
pnpm typecheck
pnpm test
```

The single documented complete proof command is:

```bash
pnpm --filter @webx/screenshot-first-browser-spike verify
```

Set `SPIKE_CHROME_BIN=/absolute/path` to test another executable.

## Test environment

- Date: 2026-08-28 local session date; test completed after UTC midnight.
- OS: Fedora Linux 44 Workstation, x86-64.
- Kernel family: Linux.
- Desktop session: Wayland with `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0`.
- Browser rendering path reported by user agent: X11/XWayland for this Chromium launch.
- Node: `v24.18.0`.
- pnpm: `10.13.1`.
- Browser executable: `/usr/bin/chromium-browser`.
- Browser product from CDP: `Chrome/151.0.7922.173`.
- CDP protocol: `1.3`.
- AgentCursor source: version `0.3.0`, commit `b23c633c66fd240f836f5edd1034f6fcf678e237`.

Google Chrome was not installed in the tested candidate locations. The spike therefore used Fedora Chromium. Chrome remains the production preference. Chromium can differ in codecs, policy integration, bundled services, release cadence, wrapper behavior, and user agent.

## Automated results

- Frozen lockfile install: pass.
- Spike lint: pass.
- Repository TypeScript type-check: pass.
- Full repository test command: pass.
- AgentCursor path/persona unit tests: 2 passed.
- Chrome hosts running concurrently: pass, 2.
- Distinct profile directories: pass.
- Distinct debugging endpoints: pass.
- Distinct CDP targets: pass.
- Independent initial screenshots: pass.
- Accessibility fallback: pass, 3 interactive nodes per fixture.
- Concurrent different clicks: pass. `agent-a` count became 1. `agent-b` count became 10.
- Concurrent different typing: pass. Values were `alpha-only` and `bravo-only`.
- Cross-session target use: rejected with `OWNERSHIP_MISMATCH`.
- Old observation after navigation: rejected as stale.
- Persistent different personas: pass, fixed per-session seeds.
- Visible sampled cursor overlay: pass, 90 samples for `agent-a` and 64 for `agent-b` at the evidence point.
- Repeated viewer frames: pass, 6 server-sent frame events across both sessions, with at least 2 for each.
- Warm process gate: pass, browser launch count stayed at 2 and browser process IDs did not change.
- Cleanup: browser processes exited, CDP disconnected, and both temporary profiles were removed.

Initial independent screenshot SHA-256 values:

```text
agent-a 7512966bd0f6a9efa031c7c6dfa49374078362d41200ab7634bf32d044f531d9
agent-b 55b1dafe18378bb45c65421ae229b41d7ef23d4d754ac311d8a3a907e620e5ba
```

Screenshots were kept in memory and were not committed. The executable evidence is `spikes/screenshot-first-browser/src/verify.ts`. It asserts image byte size, URL/title identity, different hashes, overlay visibility, screenshot change after cursor-only movement, sampled-path counts, independent page state, repeated viewer delivery, process stability, and cleanup.

## Performance data

This is one development-machine run. Values are milliseconds unless noted. Median uses the small observed sample, so treat these numbers as baseline evidence rather than a service-level objective.

| Measurement | Min | Median | p95 / max | Notes |
|---|---:|---:|---:|---|
| Chrome startup, per process | 315.6 | 315.6 | 315.9 | Two processes launched concurrently. |
| Warm screenshot capture | 33.9 | 112.4 | 198.6 | Six alternating PNG captures. |
| Warm CDP command round trip | 0.164 | 0.224 | 0.288 p95; 0.597 max | Twenty `Runtime.evaluate` round trips. |
| Intentional mouse path | 389.2 | 389.2 | 703.6 | Two different seeded personas and distances. |
| Mouse path wall time | 447.4 | 447.4 | 731.2 | Includes CDP and overlay update overhead. |
| Click completion excluding path | 152.4 | 152.4 | 211.2 | Includes intentional dwell and press timing after movement. |
| Viewer frame event latency | 0 | 0 | 1 | Same-process loopback and millisecond timestamp resolution. Capture time is reported separately as screenshot latency. |
| Initial parallel screenshot pair | — | 303.8 | — | First parallel capture for both processes. |

At a 500 ms frame interval for each browser, the runtime plus both Chrome process trees measured:

- 11.82% of one CPU core over 2.03 seconds;
- 3,154.6 MiB total resident memory;
- 30 processes in the measured process trees.

The memory result is high and needs a longer clean-machine breakdown before a production limit is chosen. The measurement includes the Node verification runtime and all descendant Chromium helper processes. No memory optimization was attempted in Phase 0.

## What worked

- `DevToolsActivePort` with `--remote-debugging-port=0` gave separate loopback endpoints without port races.
- Browser-level CDP plus flattened target sessions gave explicit target input and lifecycle events.
- CDP `Input`, `Page`, `Runtime`, `DOM`, and `Accessibility` domains covered the required spike capabilities without a Chrome extension.
- A preload cursor overlay was present in CDP screenshots and restored after navigation.
- AgentCursor’s path and persona modules fit a custom driver without MCP.
- A 3-second observation window plus identity, generation, viewport, scale, scroll, and bounds checks allowed animation without byte equality.
- A simple read-only HTTP viewer proved selected-session and repeated-frame behavior.
- Direct `/proc` sampling avoided a measurement subprocess during the warm-action gate.

## What failed or needed correction

No completion-gate behavior failed in the final run.

During implementation, strict TypeScript found that the upstream optional seed constructor shape needed an `exactOptionalPropertyTypes` adaptation. The local selective port records this adaptation. No runtime workaround was needed.

The frame event latency measurement has only millisecond resolution and reads as zero on loopback. Phase 1 should include monotonic timestamps in frame publication metrics.

The spike viewer does not authenticate frame reads. It is bound to loopback, is read-only, has no control endpoint, and exists only during the proof. This is acceptable for the isolated spike. Production workspace frame subscriptions must use authenticated same-user IPC and owner-scoped authorization.

## Guard tradeoffs

The initial coordinate guard does not compare screenshot bytes. It accepts animation and cursor overlay changes. It rejects old time, wrong identity, document replacement, viewport or device-scale change, meaningful scroll, and out-of-bounds coordinates. An element can still move inside an otherwise stable viewport during the freshness window. Phase 1 should retain the simple default and add a newer-frame or local-region check for high-risk controls.

Accessibility handles begin with document generation. Top-level navigation invalidates them. A node can detach during same-document mutation, so a later semantic action must resolve the backend node again and return `HANDLE_STALE` rather than searching the new page broadly.

## Remaining uncertainties

- Overlay resilience on pages with aggressive DOM mutation, fullscreen, top-layer dialogs, cross-origin frames, and print or PDF viewers.
- Chrome behavior on native Wayland compared with the tested XWayland path.
- Long-run frame capture bandwidth, memory, and Chrome helper-process cost.
- Fractional scale and multi-monitor workspace behavior.
- Correct cancellation after a partially dispatched drag or navigation.
- Target swaps from prerendering, portals, renderer crashes, and browser internal pages.
- Production packaging and user-systemd graphical environment inheritance.
- Whether local-region staleness checks improve safety without causing excessive rejection.

## Phase 1 recommendation

Proceed with AgentCursor’s selectively ported MIT path/persona core and a custom explicit CDP driver in a long-lived TypeScript runtime. Do not use AgentCursor MCP or its extension. Implement the full protocol ownership address, control epochs, operation state, deadlines, cancellation, authenticated local frame transport, target crash handling, and resource soak tests before routing production Pi tools to it.
