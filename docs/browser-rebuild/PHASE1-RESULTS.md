# Phase 1 results

## Verdict

The parallel Phase 1 browser core passes its implementation, live-browser, crash, cancellation, and 30-minute resource gates. It is ready to support Phase 2 integration behind a reversible service switch. It is not ready for model-facing production routing.

`packages/browser-protocol`, `packages/browser-runtime`, and the separate `apps/browserd` service implement the required internal foundation. The current Rust browserd, browser backends, browser protocol, Tauri workspace, and `webxd` browser adapter remain unchanged and unrouted.

The uninterrupted soak evidence is in `docs/browser-rebuild/evidence/phase1-soak-results.json`. The final acceptance review and repository-wide checks complete the branch gate.

## Branch and commits

- Branch: `rebuild/screenshot-first-browser`
- Phase 1 starting SHA: `10ee76d57babb4c88fa5e57fc84f70988349c895`
- Protocol: `4bea43d` — `feat(browser-protocol): add strict screenshot-first runtime protocol`
- Runtime: `abac66c` — `feat(browser-runtime): add explicit CDP runtime core`
- browserd: `5be9938` — `feat(browserd): add actor-bound Unix service`
- Runtime hardening: `14d55bd` — `fix(browser-runtime): harden bounded concurrent operations`
- Live and soak harness: `fbe7ad8` — `test(browser-runtime): add live verification and resource soak`
- Dispatch truth: `76723c9` — `fix(browser-runtime): preserve irreversible dispatch truth`
- Cancellation and orphan tests: `7583f9d` — `test(browser-runtime): cover cancellation cleanup and orphan profiles`
- Shutdown cleanup: `3d921b5` — `fix(browser-runtime): clear bounded state on shutdown`
- Queue cleanup: `16f4ebb` — `fix(browser-runtime): remove cancelled work from lanes`
- Navigation authority: `4a15fa9` — `test(browser-runtime): verify navigation fails closed`
- Expanded live gates: `6c90389` — `test(browser-runtime): expand cancellation and cleanup gates`
- Documentation commit: the later branch commit that contains this results file.

## Environment

- Date: 2026-08-28 local session date.
- OS: Fedora Linux 44 Workstation, x86-64.
- Desktop: GNOME Wayland. The 30-minute Chromium process command lines used `--ozone-platform=wayland`.
- Node: `v24.18.0`.
- pnpm: `10.13.1`.
- Executable: `/usr/bin/chromium-browser`.
- Browser: Chromium `151.0.7922.173`, Fedora 44 build.
- AgentCursor: version `0.3.0`, commit `b23c633c66fd240f836f5edd1034f6fcf678e237`.

Google Chrome was not installed and was not tested. No browser or system package was installed. This is an external test-environment gap, not a claimed pass.

## Exact commands

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @webx/browser-protocol typecheck
pnpm --filter @webx/browser-protocol test
pnpm --filter @webx/browser-runtime typecheck
pnpm --filter @webx/browser-runtime test
pnpm --filter @webx/browserd typecheck
pnpm --filter @webx/browserd test
pnpm test:browser-core
pnpm lint
pnpm typecheck
pnpm test
```

Live Chromium verification:

```bash
pnpm --filter @webx/browserd test:live -- --output=../../docs/browser-rebuild/evidence/phase1-live-results.json
```

Genuine 30-minute soak:

```bash
pnpm --filter @webx/browserd test:soak -- --duration-seconds=1800 --sample-seconds=15 --output=../../docs/browser-rebuild/evidence/phase1-soak-results.json
```

The live and soak commands use only deterministic loopback fixture pages. They need an existing graphical Chromium or Chrome executable. Set `BROWSERD_CHROME_BIN` to a reviewed executable path.

## Unit and contract results

- Browser protocol conformance: 7 passed.
- Browser runtime core: 16 passed.
- browserd Unix transport: 7 passed.
- Strict TypeScript with `exactOptionalPropertyTypes`: passed for all three Phase 1 projects.
- Deterministic generated JSON Schema comparison: passed.
- Normal repository `pnpm lint`, `pnpm typecheck`, and `pnpm test`: passed after the final live and soak changes.

CI runs the Phase 1 protocol, runtime, and browserd contract tests without a graphical browser. The graphical commands remain opt-in.

## Live integration result

Evidence: `docs/browser-rebuild/evidence/phase1-live-results.json`.

The completed Fedora Chromium run passed:

- two actor-bound socket connections and two isolated browser sessions;
- different session IDs, Chrome profiles, CDP identities, and personas;
- two explicit tabs in one browser session;
- one persona and motor shared across those tabs;
- actions in different sessions running concurrently;
- pointer actions across tabs in one session serializing;
- screenshot-first observations with artifact references and no inline duplicate image;
- explicit DOM fallback and a human-style fallback click;
- actor, session, tab, target, generation, viewport, scroll, and epoch rejection;
- popup registration;
- cancellation during a path with `cancelled` and `partially-dispatched` status;
- post-path revalidation after movement, with the click prevented and `partially-dispatched` recorded;
- overlay reinjection after page mutation while a top-layer modal dialog existed;
- public vertical wheel dispatch and stale-scroll rejection;
- target crash failure while a sibling tab survived;
- full Chrome kill failure without fallback;
- no new process from a warm observation and action;
- private descriptor, socket, and profile modes;
- descriptor, socket, Chrome, artifact, and profile cleanup.

Headline live values:

| Measurement | Result |
|---|---:|
| Two-session startup | 504.82 ms |
| Human path wall time | 905.41 ms |
| Different-session parallel actions | 1,332.35 ms |
| Same-session serialized actions | 5,905.86 ms |
| Active burst frames | 10 |
| Distinct intermediate cursor positions | 10 |
| One remaining Chrome process-tree PSS after crash scenario | 581,745 KiB |
| Private dirty | 261,820 KiB |
| Artifact count / bytes | 28 / 304,879 |
| Operation count | 47 |

The live result proves that a final-position-only screenshot was not used. It observed 10 frame sequences at 10 different cursor positions during one approximately 900 ms path.

## Soak and resource result

Evidence: `docs/browser-rebuild/evidence/phase1-soak-results.json`.

The uninterrupted run lasted `1,800.000` seconds and produced 120 resource samples. It ran two Chrome processes, three tabs, three idle frame subscriptions, 360 explicit screenshot observations, 120 DOM observations, 120 human-style pointer paths, and 3,386 delivered workspace frames. Artifact and operation registries reached their configured steady bounds. The process count remained 27. Shutdown removed both profiles, the descriptor, the socket, all artifacts, and all operations.

| Soak measurement | Result |
|---|---:|
| Two-session startup | 456.92 ms |
| Screenshot latency median / p95 / max | 36.96 / 215.13 / 450.68 ms |
| DOM fallback median / p95 | 6.16 / 6.87 ms |
| Path wall median / p95 | 820.75 / 1,090.65 ms |
| CDP round trip median / p95 | 0.207 / 0.309 ms |
| Frame publication median / p95 | 41.67 / 1,297.76 ms |
| Bound-socket frame delivery median / p95 | 0.170 / 0.318 ms |
| CPU median / p95 | 4.12% / 5.45% of one core |
| PSS start / end / maximum | 887,639 / 893,898 / 901,214 KiB |
| Private dirty start / end / maximum | 499,568 / 512,484 / 513,200 KiB |
| browserd heap start / end / maximum | 17.43 / 17.29 / 18.58 MB |
| Profile bytes start / end / maximum | 13.60 / 16.10 / 16.10 MB |
| Artifact count / bytes maximum | 128 / 1,323,467 |
| Operation count maximum | 207 |
| Dropped replaceable frames | 778 |
| Event-loop histogram mean / maximum | 20.06 / 21.58 ms |

Full-run linear regression slopes were `+33,139 KiB/hour` PSS, `+52,813 KiB/hour` private dirty, `+2.05 MB/hour` Node heap, `+4.23 MB/hour` profile disk, `+0.33 MB/hour` artifact bytes, and `+307 operations/hour`. The artifact count stayed at 128 and operation count stayed near 205 after their initial retention ramps. Profile bytes reached 16,103,112 and then stayed constant during the final third. Node heap ended below its start. PSS and private dirty varied within 30,547 KiB and 31,576 KiB ranges but retained positive regression slopes. A longer real-task soak must determine whether those browser-memory slopes persist.

Phase 0 summed RSS is not used because it can count shared pages more than once. Phase 1 uses `/proc/<pid>/smaps_rollup` PSS over the Node service and both complete Chrome process trees.

Candidate Phase 2 development budgets for this exact two-session, three-tab load are: 1.0 GiB process-tree PSS, 550 MiB private dirty, 32 MB browserd heap, 8% p95 CPU of one core, 24 MB combined profile disk, 128 artifacts, and 256 retained operations. These are review candidates, not service-level objectives. Do not weaken process isolation from these measurements.

## Bounded state and cleanup

The implementation applies these default bounds:

- at most four browser sessions per actor;
- strict protocol and transport frame sizes;
- bounded CDP command IDs and pending commands;
- bounded observations and DOM handles with expiry;
- 128 artifact entries, per-item and total byte limits, expiry, and pruning;
- 2,048 operation entries with retention and pruning;
- one frame capture in flight and one latest frame per tab;
- bounded subscriber writes with droppable workspace events;
- eight tabs per browser session;
- runtime-created profiles only.

The soak fails if artifact or operation bounds are exceeded, if a session profile remains, or if shutdown retains an artifact or operation.

## Failures found and corrected

Implementation and live testing found these concrete defects:

1. A queued operation could remain stranded when its lane was released during a drain. The registry now drains a non-empty lane again after releasing its running marker.
2. Successful browserd responses did not include `ok: true`. Strict response validation rejected valid coordinate results. The server now emits the required response discriminator.
3. Automatic target attachment caused popup and session hangs. The runtime now discovers targets and explicitly attaches and registers owned targets.
4. Long generated paths produced too many replay samples. The motor now keeps a bounded representative sequence while preserving duration and intermediate movement.
5. Browserd live evidence originally resolved under the package working directory. Commands now use the repository documentation path.
6. The first wheel attempt timed out in CDP input. The final live harness now dispatches the public wheel action and verifies the resulting stale-scroll rejection.
7. Serial request handling on one bound connection prevented independent browser sessions from acting concurrently. Binding remains ordered, but ordinary bound requests now run concurrently with a 64-request connection bound.
8. An observation delivered inline also created an unused artifact. Inline observations now compute their digest without storing duplicate bytes.
9. Irreversible input and navigation dispatch were marked only after CDP replied. Cancellation could therefore understate an already-sent effect. The runtime now marks dispatch immediately before sending press, wheel, key, text, and navigation commands, and tests drag-release cleanup.
10. Cancelled queued work retained a lane slot until the running predecessor settled. Cancellation now removes queued work immediately.
11. The first 30-minute soak attempt was interrupted when the development PC restarted. It produced no passing evidence and is not counted. Two short post-reboot preflight runs were intentionally stopped to correct sample cadence and shutdown evidence before the final run started from zero.

## Security boundary

The Unix runtime directory is `0700`. The descriptor and socket are `0600`. The descriptor secret changes at each start. A connection binds once. Ordinary request schemas contain no actor selector. The server rejects rebind and scopes objects to the bound actor.

The descriptor secret is shared by trusted same-user clients. It does not prove an asserted actor identity against a malicious process that already runs as the same Unix user and can read the descriptor. Before production routing, `webxd` must be the trusted client or supply an actor-specific attestation if the threat model requires isolation among same-user processes.

Production navigation has no permissive default. It fails closed without `NavigationAuthorization`. Live tests permit only their loopback fixture origin.

## Unresolved issues

- Google Chrome remains untested because it is not installed.
- Production `webxd`, Pi extension, SDK, and Tauri integration are intentionally absent.
- Actor-specific trusted-service attestation is a Phase 2 security design if hostile same-user processes are in scope.
- Fractional-scale, multi-monitor, fullscreen, PDF, and visual precedence over top-layer content remain untested. Phase 1 did test native Wayland launch plus overlay reinjection during DOM mutation and a modal dialog.
- PSS and private dirty had positive regression slopes. A longer real-task soak must confirm whether Chrome reaches a stable plateau.
- More exhaustive browser-specific cancellation timing remains useful before model-facing cutover, although Phase 1 now covers queued, mid-path, pre-press, held drag, dispatched navigation, target failure, browser failure, duplicate, terminal, and deadline cases.

## Phase 2 recommendation

Proceed to Phase 2 if the final acceptance review finds no reproduced Phase 1 gate failure and the final branch checks pass. Phase 2 should connect `webxd` to the separate daemon behind one reversible service-level switch. It must not import the full runtime into `webxd` or remove the old production stack yet.
