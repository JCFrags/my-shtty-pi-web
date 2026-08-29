# Screenshot-first browser Phase 0 spike

This isolated spike validates two long-lived, headed Chromium hosts. It does not replace the production browser stack.

## Complete proof

From the repository root:

```bash
pnpm --filter @webx/screenshot-first-browser-spike verify
```

The command type-checks the spike, runs deterministic unit tests, launches two headed browsers, runs the full two-agent proof, measures performance, and fails if cleanup is incomplete. It uses only a local fixture. It does not use MCP or an action-per-process adapter.

Set `SPIKE_CHROME_BIN` to an executable path to override browser selection. The default order is Google Chrome Stable, Google Chrome, Fedora `chromium-browser`, then `chromium`. Google Chrome is the production preference because it matches the supported consumer release and media behavior. Fedora Chromium is suitable for this deterministic spike. Its codec set, enterprise policy integration, release cadence, command wrapper, and user agent can differ.

## Design notes

- One browser process, temporary `0700` profile, kernel-selected loopback CDP port, target, CDP session, cursor state, and seeded persona exist for each simulated agent.
- The runtime keeps one WebSocket per browser host. Warm actions do not launch a process.
- Every driver operation carries the agent session and target. Coordinate actions also carry a screenshot observation ID.
- A coordinate observation is valid for at most 3 seconds. The target, document generation, CSS viewport size, device-pixel ratio, scroll offset, and coordinate bounds must still match. The guard does not compare screenshot bytes. This permits animation and cursor movement. It can still accept a coordinate after an element moves inside an otherwise stable viewport. Phase 1 should add an optional local-region or layout-shift guard for high-risk controls.
- `domFallback` is an explicit call. It returns a bounded accessibility snapshot. Handles start with the document generation and become stale after top-level navigation or document replacement.
- The cursor is a page overlay. It is visible in CDP screenshots. It is not the Linux OS cursor.
- The viewer is read-only. It serves no control endpoint and puts no control token in a URL. It uses server-sent frame events and explicit agent selection.

Generated profiles, screenshots, dependencies, and build output are ignored. The proof removes all temporary profiles and closes all browser processes on success or failure.
