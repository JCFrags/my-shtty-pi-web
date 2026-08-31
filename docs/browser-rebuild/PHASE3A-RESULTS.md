# Phase 3A results

## Outcome

Phase 3A is qualified on `rebuild/screenshot-first-browser` as a read-only trusted multi-agent Tauri screenshot workspace.

- Required starting SHA: `d6e42db04a3f0b0227c2211093cfcbdac76847d4`
- Preserved user-approved runtime-directory correction: `37a0c4b2008479b62cbdb8a8f3095347d41f79dc`
- Qualifying production and harness SHA: `7cece820ad4510ac45c239a2ef6a09711cccfde8`
- Final documentation SHA: the documentation-only commit that contains this report and the qualifying evidence; the exact SHA is recorded in the final delivery because a Git commit cannot contain its own SHA.
- Private protocols: `browser.v2` and `workspace.v1`
- Public WebX API and browser contract: unchanged at `3.0.0`, path `agentcursor/chrome`

The exact-SHA gate started from a clean tree with an externally supplied expected SHA. It ran the real Tauri Rust client and React frontend, two Pi harnesses, two isolated Chromium sessions, browserd, webxd, a deterministic fixture, and a secure test proxy in separate processes. It completed uninterrupted for 1,811.605 seconds and cleaned up all owned resources.

Human takeover, Tauri browser input, cancellation, and model-facing workspace tools remain absent and are deferred to Phase 3B. Production-default AgentCursor routing remains disabled. `WEBX_BROWSER_BACKEND` still defaults to `legacy`, and the legacy browser runtime remains installed and selectable. ADR-012 remains unresolved.

## Delivered architecture

The only workspace path is React -> fixed Tauri commands/channels -> Rust client -> authenticated private webxd workspace Unix socket -> trusted webxd gateway -> browserd workspace-broker connection -> BrowserRuntime. Tauri never connects directly to browserd. The frontend has no fetch, WebSocket, EventSource, Unix socket, descriptor read, remote navigation, or browser input path.

Browserd roles are connection-bound and exclusive. Actor connections cannot call workspace commands. Workspace connections authenticate with a distinct secret, contain no caller-selected actor identity, and cannot call actor commands. Rebinding closes the connection. Workspace subscriptions and delivered-frame ledgers are connection-scoped and bounded. Exact role-separation, wrong-secret, cross-tab, cross-connection, agent-artifact, disconnect, and sanitized-snapshot tests pass.

Tauri Rust alone discovers and validates the webxd descriptor, private runtime directory, file and socket modes, PID plus process-start ticks, socket location, and binding secret. JavaScript receives no descriptor, secret, socket path, browserd endpoint, CDP identity, profile path, proxy detail, or raw actor credential.

## Binary transport and frontend bounds

Webxd and Rust use bounded length-prefixed JSON headers with optional raw payload bytes. Rust delivers frames through a Tauri channel. The actual JavaScript type is `ArrayBuffer`; base64 and JSON numeric byte arrays are not used. The 100 x 1 MiB binary probe verifies unique digest, order, and bounded queues.

The soak records at most two Rust-retained frames, one frontend-retained frame, one concurrent `ImageBitmap`, and zero `ImageBitmap` objects after settlement. Selection, runtime, document, viewport, sequence, length, digest, media type, and decoded dimensions are checked before paint. A selection barrier waits for any prior frontend frame to settle.

## Multi-agent graphical proof

The committed graphical acceptance and final soak prove:

- two sanitized agent labels, two sessions, multiple explicit tabs, and exact selection;
- 365 selection barriers and 308 continuous soak switches;
- 2,594 frames received and 2,456 painted by the real Tauri application;
- zero cross-agent paints, zero former-selection paints, and zero non-monotonic paints;
- five distinct cursor-motion frame digests from one human-style action, exceeding the required three;
- 25 tab create/close cycles;
- five Pi reconnects;
- one webxd restart with the browserd runtime and sessions preserved;
- one browserd replacement with old sessions rejected and new sessions created;
- 51 hide/raise or single-instance window cycles;
- search/read remained healthy through the browser outage;
- user-only show, hide, and attach use one fixed validated executable, fixed bounded arguments, direct spawn without a shell, and Tauri single-instance forwarding.

## Latency

| Metric | Result |
|---|---:|
| Startup to frontend ready | 886.681 ms |
| Descriptor discovery | 0 ms recorded |
| Gateway bind | 1 ms |
| First snapshot | 709 ms |
| First selected frame | 1,027 ms |
| All soak switches | 308; median 2,510 ms; p95 3,132 ms; max 13,660 ms |
| Initial stable session switch | 134 ms |
| Initial stable tab switches | 2,987 and 3,564 ms |
| Webxd recovery switch | 1,182 ms |
| Decode | median 6 ms; p95 8 ms; max 11 ms |
| Paint | median 0 ms; p95 1 ms; max 4 ms |
| Publication to paint | median 107 ms; p95 134 ms; max 170 ms |

The first snapshot and first selected frame meet the 2-second development targets. The 1.5-second stable switch p95 development target was not met. This is recorded as a remaining performance gap, not hidden as an SLA pass.

## Final uninterrupted graphical soak

Evidence: `evidence/phase3a-workspace-soak-results.json`, SHA-256 `4554ad58dca2a0fa8f21d7b9cc3803f65a8b18dd3853eab6c30a20640cf9e7ff`.

| Metric | Result |
|---|---:|
| Requested / actual duration | 1,800 / 1,811.605 seconds |
| Uninterrupted | yes |
| Iterations | 308 |
| Screenshot attempts | 3,246 |
| Explicit agent screenshots | 616 |
| Workspace screenshot attempts | 2,615 |
| Workspace switches | 308 |
| Tab cycles | 25 |
| Pi reconnects / webxd restarts / browserd replacements | 5 / 1 / 1 |
| Window and single-instance cycles | 51 |
| Same-session capture maximum | 1 |
| Cross-session capture concurrency | yes; process maximum 2 |
| Typed timeouts / agent retries / recovered / unrecovered | 27 / 13 / 13 / 0 |
| Recovered-agent rate | 13 / 631 = 2.0602% |
| Graphical policy | <=32 retries, <=5% recovered rate, <=64 typed timeouts, zero unrecovered |
| Pre-replacement timeouts | 0 across the recorded pre-replacement segment |
| Post-replacement timeouts | 13 agent and 14 workspace; all agent retries recovered |
| Cross-agent / stale / non-monotonic paints | 0 / 0 / 0 |
| General idempotency image bytes | 0 |

The earlier Phase 2B.1 non-graphical recovery gate remains unchanged at at most three recoveries and 0.5%. Phase 3A uses a separate explicit graphical policy because continuous Tauri capture and a browserd replacement are part of this workload. The evidence records the policy and the recovered timeouts. No unrecovered screenshot failure occurred.

## Resources and cleanup

The final Tauri/WebKit process tree used 282,379 KiB PSS and 163,336 KiB private dirty at final analysis. The first and last periodic samples were:

| Process tree | First PSS / private dirty KiB | Last PSS / private dirty KiB |
|---|---:|---:|
| Tauri + WebKit | 257,938 / 142,964 | 280,279 / 165,308 |
| webxd | 91,298 / 89,844 | 73,310 / 71,800 |
| browserd | 93,456 / 92,128 | 88,849 / 87,504 |
| Chromium session A | 380,753 / 198,332 | 378,363 / 194,880 |
| Chromium session B | 414,498 / 216,784 | 414,115 / 217,732 |

The evidence contains 117 bounded periodic CPU and memory samples. It does not claim that the long-term Chrome plateau issue is resolved.

Final cleanup reports zero profiles and children, no webxd socket, no browserd descriptor, no Tauri process tree, zero gateway clients/selections/pending frames, zero broker and browserd workspace subscriptions, zero frame-ledger entries, and all three observed workspace instance sockets removed.

## Visual evidence

These are screenshots of the actual Tauri window using deterministic local pages:

- `evidence/phase3a-workspace-agent-a.png` — `8fd80a9bbc46677c8fbae755a5a7617c5d3ffa52289fb1beca87193d7cfcf99e`
- `evidence/phase3a-workspace-agent-b.png` — `1b10ab5965330142384f58b8f6c39f5d3d1c18d04d52a71b9889fa3a3a5b798f`
- `evidence/phase3a-workspace-empty.png` — `4457b017c10f0854827f4579f941bd5495dbae72d20a08652322c4107cb2800b`
- `evidence/phase3a-workspace-reconnecting.png` — `56d83b39072266e023ebba7bb9a85e8c777b697571122f734b2ce61491baa546`

The historical pre-qualification graphical record is `evidence/phase3a-live-results.json`; it produced the committed screenshots and was independently accepted, but it is not the final exact-SHA qualification record. The final soak generated separate temporary screenshots during qualification; their hashes in the soak record are run-specific and do not replace the committed visual evidence hashes above.

## Verification commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:browser-core
pnpm --filter @webx/workspace-protocol test
pnpm --filter @webx/webxd test:workspace
pnpm --filter @pi-web/workspace test
cargo test --manifest-path components/browser/apps/workspace/src-tauri/Cargo.toml
pnpm --filter @pi-web/workspace build
pnpm --filter @pi-web/workspace tauri build --debug --no-bundle
pnpm --filter @pi-web/workspace test:binary-ipc
pnpm --filter @webx/webxd test:workspace-live
PHASE3A_EXPECTED_SHA=7cece820ad4510ac45c239a2ef6a09711cccfde8 pnpm --filter @webx/webxd test:workspace-soak
git diff --check
```

Normal repository, protocol, runtime, webxd, Pi launcher, SDK, frontend, Rust, typecheck, lint, build, and binary IPC gates pass. The final rerun recorded 405 root workspace tests; 5 workspace-protocol, 8 browser-protocol, 129 browser-runtime, 8 browserd, 130 webxd plus 4 focused workspace-gateway, 23 Pi launcher/extension, 14 SDK, and 11 workspace frontend tests. The Rust workspace recorded 62 passed and 4 environment-dependent ignored tests; the workspace crate's direct Cargo run recorded 11 passed. The secure egress proxy recorded 16 Python tests. The Vite build transformed 34 modules, and the debug Tauri build passed during qualification. The graphical live route passed before qualification. The final exact-SHA graphical soak passed after the production and harness bytes were frozen.

## Legacy surgery and new modules

The exact deleted and replaced files are in `PHASE3A-LEGACY-WORKSPACE-SURGERY.md`. Removed files include `src/lib/rpc.ts`, `src/fixtures.ts`, `src/model.ts`, `src/components/Viewport.tsx`, and the legacy model/contract tests. The old `browserd_descriptor`, frontend workspace authority, HTTP/WebSocket transport, base64 frames, leases, human input, takeover, and cancellation were removed.

Added modules include `packages/workspace-protocol/`, `apps/webxd/src/workspace/`, browser.v2 workspace-broker schema/runtime support, the secure Tauri Rust descriptor/client/protocol/frame/state/window modules, bounded React state and canvas rendering, and the user-only Pi workspace launcher.

## Commits

- `37a0c4b` preserve the webxd runtime directory
- `e44449e` add bounded workspace.v1 framing
- `4af57df` inventory legacy workspace surgery
- `38207f9` add browser.v2 workspace-broker role
- `4392735` fan out broker frames by subscription
- `edd4816` add private webxd workspace gateway
- `7069b2a` add secure Tauri binary client
- `f380ba1` add multi-agent screenshot viewer
- `0a7168b` add user-only workspace launch
- `588608b` add graphical Tauri qualification
- `216905b` ignore generated Tauri schemas
- `20a71a3` harden outage soak lifecycle
- `a0ae32f` gate replacement capture readiness
- `a6a1d83` preserve queued selection commands
- `e5f0d8a` dwell after frame capture timeout
- `4ea0e00` bound graphical soak recoveries
- `7ae05ad` settle the prior frame before the selection barrier
- `7cece82` record Phase 3A documentation and remove the obsolete legacy human-control test

## Remaining gaps and Phase 3B recommendation

Phase 3A is read-only and does not prove human-control authority. Human takeover remains Phase 3B. The stable switch p95 development target was missed, and Fedora Chromium showed concentrated but fully recovered screenshot timeouts after browserd replacement. Long-term Chrome memory plateau evidence, packaging, Wayland/multi-monitor behavior, Google Chrome coverage, and production-default routing also remain open.

Do not start Phase 3B implementation from this Phase 3A result alone. First reduce or explicitly accept the post-replacement capture latency and switch-latency gap, then design the privileged controller-epoch boundary as a separate reviewed phase. Phase 3A must not be treated as authorization for browser input. Production-default AgentCursor routing remains disabled.

## Phase 3B follow-up

Phase 3B subsequently passed a separate control-readiness gate, versioned the private protocols as `browser.v3` and `workspace.v2`, added browserd-owned human-control authority, and qualified user-only exact-painted-frame input. It did not alter this historical Phase 3A qualification or enable production-default routing. See `PHASE3B-RESULTS.md` and ADR-021 through ADR-023.
