# Fedora staged update operations

Use this procedure for a reviewed Pi Web Tools update. Do not run cutover before all deterministic checks pass.

## 1. Create the candidate

Start from a clean reviewed commit.

```bash
./install-fedora.sh --stage
```

The command writes one candidate to `~/.local/lib/pi-web-tools-releases/COMMIT`. Set `PI_WEB_RELEASE_ROOT` to use another private release root. The stage command uses `pnpm install --frozen-lockfile`, `uv sync --frozen`, and `cargo build --locked`. It puts the Python environment, Node dependencies, Rust output, runtime files, and build cache below the candidate. It does not use `sudo`. It does not change live links, binaries, units, service state, or sockets.

Review `candidate-manifest.json`. Confirm the commit and both SHA-256 tree digests. The candidate digest covers file bytes, executable bits, and symbolic-link targets, including locked dependency output.

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

The cutover does not delete cache, stored content, audit events, exports, or old releases.

## 6. Verify and roll back

Start a new Pi session or use `/reload` after the owner reviews the cutover result.

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

Rollback restores the recorded paths and service state. It does not uninstall Pi Web Tools. It does not delete historical data. Use `uninstall-fedora.sh` only when you intend to remove the installed code and service registration.
