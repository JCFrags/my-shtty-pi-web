# Pi Web Tools

This repository is the single source for Pi's internet capabilities on Fedora.

It contains:

- web search, direct page reading, and bounded multi-source research;
- browser automation with explicit sessions and tabs;
- a Tauri desktop workspace for live viewing and user control;
- PDF and office-document conversion;
- the Pi extension that presents one clear tool set;
- one Fedora installer and uninstaller.

Search and direct reading do not require the visual browser. Search health depends only on SearXNG. Static read health depends only on the reader. Browser, crawl, and document-converter outages do not remove healthy search or static read tools. Browser automation starts only when a dynamic page, interaction, or visual check needs it.

## Main directories

- `apps/pi-webx`: Pi extension.
- `apps/webxd`: local web and browser authority.
- `components/browser`: browser coordinator, Agent Browser adapter, optional PinchTab adapter, Tauri workspace, reader, and document converter.
- `packages/sdk`: the canonical client interface used directly by the Pi extension.
- `packages/artifacts`: internal bounded-transfer primitives.
- `packages/policy`: destination and ownership policy.
- `packages/test-fixtures`: deterministic local test inputs.

The separate research archive concept is recorded in [`FUTURE_FEATURES.md`](FUTURE_FEATURES.md). Core web traffic uses only a short-lived cache. The cache holds 512 recent RAM entries and targets at most 10 GiB on SSD.

## Browser support

`agent-browser/chrome` is the required visual browser path. It supports the visible workspace and user takeover. `pinchtab/chrome` is an optional non-visual adapter. Optional adapters never block the main browser path from starting.

## Install on Fedora

Pi must already be installed. The default `web-core` profile includes search, direct read, stored content, and WebX. It does not include browser, render, or document dependencies. `documents`, `render`, and `browser` are composable optional profiles. `full` keeps the explicit compatibility behavior.

```bash
./install-fedora.sh --stage
./install-fedora.sh --stage --profile documents
./install-fedora.sh --stage --profile render --profile browser
./install-fedora.sh --stage --profile full
```

See [`docs/installation-profiles.md`](docs/installation-profiles.md) for the dependency, unit, resource-limit, transition, and doctor contracts.

For a reviewed update, use the staged procedure:

```bash
./install-fedora.sh --stage
# Run the deterministic candidate smoke test.
./install-fedora.sh --cutover-plan CANDIDATE EVIDENCE
./install-fedora.sh --cutover-apply CANDIDATE EVIDENCE
```

See [`docs/operations-fedora.md`](docs/operations-fedora.md) for exact smoke, resource, verification, and `--rollback RUN_ID` commands. Do not apply cutover until the deterministic gate passes.

The Fedora command installs only the selected Fedora package set and stages an immutable candidate. It does not change the live installation. The cutover plan generates the selected service units and records removed optional units. `pi-web doctor` checks the WebX authority capability catalog, installed profile, selected artifacts, and reviewed core resource limits.

Useful commands:

```bash
pi-web status
pi-web doctor --json
pi-web workspace
pi-web audit list --limit 20
pi-web audit show RECORD_ID
```

To remove installed code and services while preserving user data:

```bash
./uninstall-fedora.sh
```

Review `~/.config/pi-web`, `~/.local/share/pi-web`, `~/.cache/pi-web`, and `~/.local/state/pi-web` before deleting retained user data.

## Pi tools

- `web_search` — one complete query for ranked links or a few short sourced extracts
- `web_read` — direct reading with normalized-content storage, advanced legacy-compatible linked crawl controls, and explicit user-directed Markdown export
- `web_read_batch` — reads up to five selected direct sources as ordered separate results
- `web_content` — retrieves exact or focused bounded passages from stored normalized content without refetching
- `browser_open`
- `browser_tabs`
- `browser_observe`
- `browser_act`
- `browser_debug`

Only the user changes capability modes. Run `/web` with no options to open one settings menu for capability modes and browser workspace controls. Direct forms use `/web mode ...` and `/web workspace ...`; there is no separate browser slash command.

Search and read are capability groups rather than thin provider wrappers. Normal multi-source research uses `web_search` and then `web_read_batch` for selected sources. Linked crawl is explicit advanced legacy-compatible behavior, not the normal research path. `web_search` needs one complete query. It returns up to ten ranked links by default. Optional `output: "extracts"` reads selected pages and returns up to four short, separate source passages. Optional `domains` are strict host requirements. WebX sends the query to SearXNG without invented variants. It retries once without a `site:` operator only when the constrained query returns no eligible result. Search normalizes tracking URLs, removes duplicates, applies small relevance adjustments, and never follows page links or synthesizes across sources. Extract mode reads pages concurrently and never labels a search-engine snippet as a page extract. WebX can also select direct fetch, structured JSON, main-content extraction, Crawl4AI rendering, and document conversion behind `web_read`. Direct reads extract up to the explicit 1,000,000-character source bound. Agent-visible output has a 40,000-character hard ceiling. A read passage uses at most 30,000 characters and reports an opaque content ID plus exact stored-content continuation metadata. An explicit saved read writes one normal or focused extraction below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` and returns compact metadata instead of sending the body through the transcript. Existing files are protected unless overwrite is explicit. Structured API projections return complete row objects. If a source applies a bound, `contentOffset`, item pagination, or a section query provides a precise continuation. Source and crawl-link details remain structured metadata. Browser capabilities advertise only actions that the installed path can execute.

## Storage policy

The short-lived traffic cache keeps up to 256 entries and 32 MiB in memory. It keeps up to 2,048 entries and 512 MiB on disk. The shared policy module at `packages/policy/storage.mjs` defines these defaults.

## Real-usage audit history

The Pi extension records each real `web_search`, `web_read`, and `web_read_batch` call at its agent-facing boundary. A batch has one audit record. The record includes bounded batch counts and per-source status, content ID, cache state, and size metadata when available. It does not include fetched bodies, snippets, passages, or final agent-visible output. Records redact credential fields and sensitive URL parameters. Browser and research calls are not recorded.

Records are stored under `${XDG_STATE_HOME:-~/.local/state}/pi-web/audit` with directory mode `0700` and file mode `0600`. The extension removes records older than 30 days. It also removes the oldest records when total storage exceeds 100 MiB. The extension, audit command, doctor, documentation, and tests use the shared storage policy. This history is separate from the traffic cache and is not exposed as model-facing recall.

Use:

```bash
pi-web audit list --limit 50
pi-web audit show RECORD_ID
pi-web audit path
pi-web audit prune
```

A later agent can inspect exact real-use evidence with these commands. Run `pnpm test:live` for the separate live acceptance harness.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
cd components/browser
uv run pytest
cargo test --workspace
```

Generated dependencies and build output are not source and must not be committed.

### Offline extraction benchmark

Run the deterministic extraction corpus and its contract tests from the repository root:

```bash
pnpm test:extraction
pnpm benchmark:extraction
```

The benchmark uses local fixtures only. It compares current quality with the reviewed baseline. See [`components/browser/benchmarks/extraction/README.md`](components/browser/benchmarks/extraction/README.md) for limits, metrics, optional adapter slots, and baseline review steps.
