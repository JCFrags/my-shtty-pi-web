# Fedora staged update operations

Use this procedure for a reviewed Pi Web Tools update. Do not run cutover before all deterministic checks pass.

## 1. Create the candidate

Start from a clean reviewed commit.

```bash
./install-fedora.sh --stage                         # web-core, the default
./install-fedora.sh --stage --profile documents     # web-core plus documents
./install-fedora.sh --stage --profile full          # explicit compatibility profile
```

Optional `documents`, `render`, and `browser` profiles are composable. See [`installation-profiles.md`](installation-profiles.md). The command writes one candidate to `~/.local/lib/pi-web-tools-releases/COMMIT`. Set `PI_WEB_RELEASE_ROOT` to use another private release root. The stage command uses a filtered `pnpm install --frozen-lockfile` and selected `uv sync --package` arguments. It uses `cargo build --locked` only for the `browser` profile. It puts selected dependency output and build cache below the candidate. It does not use `sudo`. It does not change live links, binaries, units, service state, or sockets.

Review `candidate-manifest.json`. Confirm the commit and both SHA-256 tree digests. The candidate digest covers file bytes, executable bits, and symbolic-link targets, including locked dependency output.

Treat the candidate as immutable. Smoke tests and installed Python units set `PYTHONDONTWRITEBYTECODE=1` so Python does not add cache files below the candidate. If a later plan reports a digest mismatch, do not weaken the check or delete unknown files. Stage a new candidate from a clean reviewed commit.

## 2. Run the deterministic gate

```bash
CANDIDATE="$HOME/.local/lib/pi-web-tools-releases/COMMIT"
"$CANDIDATE/apps/pi-webx/node_modules/.bin/tsx" "$CANDIDATE/scripts/pi-web-smoke.ts" \
  --candidate "$CANDIDATE"
```

The harness creates a unique run ID. It uses a private runtime directory and candidate Unix socket. It starts the candidate reader and authority in the foreground. Search and reader fixtures listen only on loopback ports that the kernel selects. The reader accepts the special `fixture.invalid` loopback mapping only in this process.

The harness does not start browser, crawl, or document workers. It checks that these failures do not stop later search and static reads. It checks batch reads, content IDs, exact and focused stored content, structured rows, output limits, and document failure. Cleanup removes only the run runtime directory and candidate processes.

Evidence remains at `${XDG_STATE_HOME:-~/.local/state}/pi-web/m7-runs/RUN_ID/evidence.json`. It identifies the candidate commit and tree digest. It contains only check metadata, process resource values, output sizes, and storage counts and deltas. It does not contain response bodies, audit bodies, or secrets. Evidence is at most 256 KiB. Pi-visible text is at most 40,000 characters.

## 3. Run the optional live core smoke test

Run this only after the deterministic gate passes. It uses the current loopback SearXNG service for search. You can set `WEBX_LIVE_SEARX_URL` to another reviewed loopback SearXNG endpoint.

```bash
"$CANDIDATE/apps/pi-webx/node_modules/.bin/tsx" "$CANDIDATE/scripts/pi-web-smoke.ts" \
  --candidate "$CANDIDATE" --live
```

The live mode uses these finite public targets:

- strict-domain IANA search;
- `https://example.com` static read;
- two rows from JSONPlaceholder.

Each request has a 45 second limit. The complete run has a 180 second limit. The test does not open a visual browser. It stores only metadata and short checked excerpts.

## 4. Review the cutover plan

Use the evidence path from the successful run.

```bash
./install-fedora.sh --cutover-plan "$CANDIDATE" "$EVIDENCE"
```

The plan lists every replaced path and service unit. Core `webxd` has only soft dependencies on the reader and SearXNG. Browser, crawl, document, and egress services are optional.

## 5. Apply the cutover

```bash
./install-fedora.sh --cutover-apply "$CANDIDATE" "$EVIDENCE"
```

The tool writes a private journal below `${XDG_STATE_HOME:-~/.local/state}/pi-web/cutovers/RUN_ID`. Before replacement, it records the exact prior file bytes, file modes, symbolic-link targets, missing paths, and active and enabled state for all managed units. It moves a compatible legacy install directory to the private journal backup instead of deleting it. It then stops managed units, uses atomic file or link replacement where the filesystem permits it, reloads user units, and restores the prior service state. Signal traps and error handling restore the saved paths and service state after an interrupted or failed apply.

Unit-file state is not always `enabled` or `disabled`. For example, the Podman-generated SearXNG unit reports `generated`. Restore logic preserves this state, skips invalid enable or disable commands for generated or static units, attempts every prior active-state restoration, and reports all restoration failures together.

The cutover does not delete cache, stored content, audit events, exports, or old releases. A profile reduction removes only managed optional launchers and units. The journal records those paths and all prior service states. Rollback restores them.

## 6. Verify and roll back

Start a new Pi session or use `/reload` after the owner reviews the cutover result. The `pi-web` launcher uses the stable installation symbolic link. `pi-web doctor --json` must print JSON and exit successfully. An empty successful-looking response is a failed check.

```bash
pi-web status
pi-web doctor --json
journalctl --user -u webxd.service -n 100 --no-pager
```

If verification fails, use the exact run ID from the apply result:

```bash
./install-fedora.sh --cutover-rollback RUN_ID
pi-web doctor --json
```

Rollback restores the recorded paths and service state. It stops only units that are active in the current profile before it restores paths. This permits rollback from a reduced profile when optional unit files are absent. Failure to stop an active unit still blocks all path restoration. Rollback does not uninstall Pi Web Tools or delete historical data. Use `uninstall-fedora.sh` only when you intend to remove the installed code and service registration.

## 7. Verify optional-worker isolation

Record the current state before this test. Stop `pi-browserd.service`, `pi-web-crawl.service`, `pi-web-docling.service`, and `pi-web-egress-proxy.service` under a shell exit trap that restores the prior state. Leave `webxd.service`, `pi-web-reader.service`, and `pi-web-searxng.service` running.

While the optional units are stopped:

- `pi-web doctor --json` must report overall success, healthy search and read checks, and an optional browser failure;
- run one strict-domain search, one static read, one stored-content continuation, and one batch read;
- confirm one browser operation fails without stopping a later static read.

Restore the exact prior optional-unit state before you leave the shell. Confirm all previously active units are active again. Do not use a blanket restart if one of the units was inactive before the test.

## 8. Accepted installation from 2026-08-28

The accepted `web-core` candidate is `7f986081b4e8a03729620777248ba1484c9bc4d7`. Its tree SHA-256 is `63e7d2493b86df33539fa34a3f754a59e8388c75b5bb67689065c40c079686e6`. The applied journal is `cutover-1787960108-7f986081b4e8`. To restore the prior full-profile installation, run:

```bash
cd /home/mainpc/Projects/webx
./install-fedora.sh --cutover-rollback cutover-1787960108-7f986081b4e8
pi-web doctor --json
```

The rollback rehearsal restored prior candidate `401f4488f9303b754d02c38132ca5f45a19f6fa8` and all seven prior active services. The final `web-core` apply then restored the three required core services and left the four optional services inactive. This command is rollback, not uninstall. Keep both candidate releases and the final journal until a later accepted installation has its own tested rollback.
