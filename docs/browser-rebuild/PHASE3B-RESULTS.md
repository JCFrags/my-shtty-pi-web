# Phase 3B results

## Outcome

Phase 3B is qualified on `rebuild/screenshot-first-browser` as a privileged local human-control layer above the accepted Phase 3A screenshot workspace.

- Required starting SHA: `e500e3200485f4df40d2b8501ac6efefc838ebbc`
- Gate 0 qualifying SHA: `25e767f2ca3b5f219306827fd38f236bf53eee46`
- Final production and harness SHA: `90fae06d42db5a3f62d0ad08a79e6cd0b38d1ef7`
- Soak evidence commit: `8237347`
- Private protocols: `browser.v3` and `workspace.v2`
- Public WebX API and browser contract: unchanged at `3.0.0`, path `agentcursor/chrome`

The final clean-tree gate used an externally supplied expected SHA and the real Tauri Rust application, React frontend, two Pi worker processes, two isolated Fedora Chromium sessions, browserd, webxd, a deterministic local fixture, and the secure test proxy. It completed 100 takeover/return cycles and ran uninterrupted for 1,888.734 seconds. No production or harness bytes changed after that qualification.

Production-default AgentCursor routing remains disabled. `WEBX_BROWSER_BACKEND` still defaults to `legacy`, and the legacy browser runtime remains installed and selectable. Tauri connects only to webxd. Phase 3B adds no model-facing workspace control tool, arbitrary CDP or JavaScript evaluation, MCP, stock AgentCursor extension, trusted OS input, upload, or download. ADR-012 remains unresolved.

## Gate 0 control readiness

Human-control work began only after the selection and capture-readiness gate passed and was committed separately. Evidence: `evidence/phase3b-gate0-results.json`, SHA-256 `0bd777621d1b6cc0220808f554782d80e602097413b9206c568d339e1f6fdaf6`.

| Gate | Result |
|---|---:|
| Exact stable switches | 200 / 200 |
| Switch latency | median 21 ms; p95 28 ms; max 38 ms |
| Former-selection / cross-agent / non-monotonic paints | 0 / 0 / 0 |
| Maximum gateway / broker subscriptions and frame ledger entries | 1 / 1 / 1 |
| Browserd replacements / new sessions | 2 / 4 |
| Replacement readiness | 518–1,091 ms |
| Governed transactions | 1,000 |
| Agent observations / workspace attempts | 500 / 500 |
| Typed capture timeouts / retries / unrecovered failures | 0 / 0 / 0 |
| Cleanup | zero owned profiles, children, sockets, descriptors, subscriptions, and ledgers |

The gate records `testedSha == expectedSha`, `workingTreeClean: true`, and exact process isolation. Independent review `res_01M1B01HN9Y3ZPNZ6AK23EMKJ0` returned ACCEPT before private control implementation began.

## Authoritative control lifecycle

Browserd owns one session control authority, one monotonic control epoch, one connection-bound expiring lease, held input, and the shared physical input lane. Takeover is compare-and-swap against the current epoch and an exact delivered and painted frame. A newer epoch fences queued and running old work. Agent observations and actions return typed retryable `CONTROL_HELD_BY_HUMAN` while human control or transfer is active and are never queued to execute after return.

Workspace-broker disconnect enters bounded grace. There is no reconnect lease reclaim. Explicit return, lease expiry, webxd loss, browserd replacement, tab/session loss, or failed cleanup returns safely or closes the affected session. Release-only held `pointerUp` and `keyUp` cleanup can bypass frame age, but it remains bound to the held state and cannot mutate.

The private protocol and authority commit is `e94d179326facfdde9b492a2adff4a135b109bb2`. Independent commit-gate review `res_01M1BCV5KTEKKWKYB318X74XX2` returned ACCEPT after lifecycle, stale-frame, response-loss, queue-saturation, and release-only regressions were corrected.

## Painted-frame private input

React can request control only after an exact frame has decoded, painted, and been acknowledged to Rust. Rust retains raw runtime, selection, session, tab, target, subscription, generation, epoch, input-target, and sequence authority, but not the browserd lease; trusted webxd keeps that lease per desktop connection. Browserd revalidates the full binding, image/CSS geometry, device-pixel ratio, coordinates, freshness, order, size, and rate before input.

The supported private input union covers pointer move; left, middle, and right click; double click; drag; horizontal and vertical wheel; key press/release/repeat; and bounded Unicode text. Batches are bounded at 32 events. Pointer movement can coalesce before admission. Held transitions stay ordered. Every successful mutation waits for a newer acknowledged paint before ordinary input resumes.

Human text and sensitive key identity are transient. They are not included in Pi presentations, model tools, aggregate workspace state, retained JSON, retained acceptance screenshots, or normal diagnostic output. React receives derived display handles rather than raw agent, persona, session, or tab identities; webxd uses keyed handles for agent/persona labels and Rust uses per-process salted handles for session/tab selection.

## User-only control entry and fail-safe return

The fixed workspace executable accepts strict bounded `--take-control` and `--return-control` launch actions. Pi exposes user-only `/web workspace takeover <browserSessionId> [tabId]` and `/web workspace return` commands. Direct spawn uses fixed arguments and no shell. These actions are absent from the SDK and model tool contract.

Takeover requires explicit identity, authoritative selection, and the current exact painted-frame acknowledgement. Attempt deadlines are absolute. Caller abandonment, expiry, disconnect, selection replacement, result-delivery loss, or return removes pending authority and drops the transport when needed so browserd can revoke it. A failed attempt cannot run later.

Explicit return, hide, close, emergency return, frontend failure, and shutdown use an independent lifecycle lane. They close ordinary input admission, settle held releases, and release browserd authority before hiding or exiting. The window remains visible on failure. The launcher increment is commit `469915d396b2e96fc9cccac3f38083d6b7001d2c`.

## Graphical acceptance

`evidence/phase3b-control-live-results.json` is the bounded pre-freeze graphical acceptance record. It passed eight complete cycles through the real Tauri and React input path, captured all seven visual states, scanned eight retained files with zero privacy matches, and cleaned every process and runtime resource. Its dirty-tree and unpinned fields make it development evidence, not the final exact-SHA qualification.

The final soak repeated and extended the same process-isolated acceptance:

- two Pi actors and two isolated Chromium processes changed only their own pages;
- the controlled actor's observation and mutation were blocked while the other actor remained usable;
- every tenth soak cycle exercised the full pointer, wheel, keyboard, Unicode, and repeat set;
- held button and key cleanup passed on disconnect, browserd replacement, and `CloseRequested`;
- a disconnected pending takeover expired and never executed before or after reconnect;
- five Pi reconnects, one webxd restart, one browserd replacement, 58 window cycles, and 29 tab cycles passed;
- old sessions were rejected after browserd replacement, and replacement sessions began agent-owned;
- search and read stayed healthy while browserd was unavailable;
- 5,027 frames painted with zero stale former-selection, cross-agent, or non-monotonic paint;
- the model resumed after every tested return and cleanup path.

## Final exact-SHA soak

Evidence: `evidence/phase3b-control-soak-results.json`, SHA-256 `f0911f6ba6542de35e84622c0bbc1c3d560f4f9ade7e5e2e567ad961e394976a`.

| Metric | Result |
|---|---:|
| Requested / actual duration | 1,800 / 1,888.734 seconds |
| Externally pinned clean SHA | `90fae06d42db5a3f62d0ad08a79e6cd0b38d1ef7` |
| Uninterrupted | yes |
| Workload iterations / bounded samples | 352 / 120 |
| Takeover/return cycles | 100 / 100 |
| Agent / workspace screenshot attempts | 716 / 4,701 |
| Same-session / cross-session capture concurrency | max 1 / observed, process max 2 |
| Typed timeouts / retries / recovered / unrecovered | 0 / 0 / 0 / 0 |
| Workspace switches | 352; median 33 ms; p95 982 ms; max 994 ms |
| Human motor replay | 565 samples; median 685.847 ms; p95 1,340.895 ms |
| Pi reconnects / webxd restarts / browserd replacements | 5 / 1 / 1 |
| Window / tab cycles | 58 / 29 |
| Privacy scan | 8 files; 19,196,758 bytes; zero encoded/literal matches; no retained human input |

The sample cadence is workload-boundary based. Long routed actions can coalesce requested 15-second intervals; the evidence records this explicitly. The run continued until both the minimum duration and all requested control cycles completed.

## Binary bounds, performance, and cleanup

The final workspace started to frontend-ready in 281.612 ms. Descriptor discovery, gateway bind, first snapshot, and first selected frame were 1, 0, 128, and 325 ms. Decode p95 was 9 ms, paint p95 was 1 ms, and publication-to-paint p95 was 27 ms. Frontend frame bytes remained `ArrayBuffer`, base64 frame bytes remained zero, Rust retained at most two frames, the frontend retained at most one frame and one `ImageBitmap`, and no `ImageBitmap` remained after settlement.

Final cleanup reports:

- zero profiles and child processes;
- removed webxd socket and browserd descriptor;
- exited Tauri/WebKit process tree;
- zero gateway clients, selected clients, pending frames, broker subscriptions, browserd workspace subscriptions, and frame-ledger entries;
- zero held buttons and keys after close/replacement cleanup;
- all three observed workspace sockets and the descriptor removed.

The 120 resource samples are bounded diagnostic evidence. `chromePlateauClaimedResolved` is false. This run does not satisfy ADR-012 or prove a long-term Chrome memory plateau.

## Visual evidence

The screenshots come from the real Tauri window and deterministic local pages:

- `evidence/phase3b-workspace-agent-a.png` — `cd4085bc1de8fead151eddce5aace16d3e07c0ac5b3f73a2e564d794b9d13d73`
- `evidence/phase3b-workspace-agent-b.png` — `40e11ec2fed4dba00c85f0b61076be889d18a75a4fc9eef35e583d09ab2b524c`
- `evidence/phase3b-workspace-empty.png` — `1ebc4de7c3f16662d801ebb7e0bf9fe75142ebb31c116e5dc5fe488c3710429b`
- `evidence/phase3b-workspace-human-a.png` — `c09cac6af6c6ef0a4286e9328ca0926f56fa5e4caea121de0146e7717adc64dc`
- `evidence/phase3b-workspace-human-b.png` — `0234e7c07d096332b8dcfbca46809e2afc50629ea14d229c7e8edce55aa638d4`
- `evidence/phase3b-workspace-reconnecting.png` — `8059274d5361df850d46770e81ceae6f0097d30c0026ffa1f3faccd87dbb9d9e`
- `evidence/phase3b-workspace-returned.png` — `22d5899b1765b89e26ff016b82d27bb2e5f2a23b4c7b75a965866049421c56ff`

## Verification

The frozen bytes passed the root test and typecheck suites, browser/workspace protocol schema and parser suites, browser-runtime and browserd authority/adversarial suites, webxd gateway and privacy suites, Pi launcher/extension suites, frontend security and input-pump suites, Rust tests and workspace checks, frontend production build, Tauri debug no-bundle build, binary input IPC stress, named graphical acceptance, and exact-SHA soak. Focused lint of changed paths passed. The repository-wide lint command retains unrelated pre-existing failures in unchanged test files; Phase 3B does not hide or reclassify them as a pass.

Qualification commands include:

```bash
pnpm test
pnpm typecheck
pnpm test:browser-core
pnpm --filter @webx/browser-protocol test
pnpm --filter @webx/workspace-protocol test
pnpm --filter @webx/browser-runtime test
pnpm --filter @webx/browserd test
pnpm --filter @webx/webxd test
pnpm --filter @pi-web/workspace test
cargo test --manifest-path components/browser/apps/workspace/src-tauri/Cargo.toml
pnpm --filter @pi-web/workspace build
pnpm --filter @pi-web/workspace tauri build --debug --no-bundle
pnpm --filter @pi-web/workspace test:input-ipc
pnpm --filter @webx/webxd test:phase3b-control-live
PHASE3A_EXPECTED_SHA=90fae06d42db5a3f62d0ad08a79e6cd0b38d1ef7 \
  pnpm --filter @webx/webxd test:phase3b-control-soak
git diff --check
```

## Commits

- `cc7f327` qualify atomic selection and control readiness
- `25e767f` make reconnect selection single-authority
- `e191d2b` record Gate 0 evidence
- `e94d179` add private browserd human-control authority
- `469915d` add user-only workspace takeover and return
- `90fae06` qualify graphical human control
- `8237347` record the final exact-SHA soak and visual evidence

## Remaining limits and rollback

Phase 3B covers Fedora Chromium and CDP virtual input. It does not cover Google Chrome, trusted Wayland/X11 pointer injection, multi-monitor or fractional-scale OS coordinates, packaging and supervision, production-default routing, hostile same-UID isolation, uploads/downloads, cross-origin out-of-process iframe DOM fallback, or a long-term Chrome memory plateau.

Rollback is to avoid launching the workspace and run webxd with its default `legacy` backend. The legacy runtime remains installed and selectable. Do not merge this branch to `main` or enable AgentCursor by default based on Phase 3B alone.

Phase 4A later packaged and qualified these bytes as an explicit Fedora canary at `30d76dc608cf9ce62d4c887cada02e63e93967b9`. It resolves ADR-012 for canary use with deterministic resource containment and the user-shortened installed soak. It still does not authorize a default switch. See `PHASE4A-RESULTS.md`.
