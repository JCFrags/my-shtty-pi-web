# Pi Web Tools

This repository is the single source for Pi's internet capabilities on Fedora.

It contains:

- web search, direct page reading, and bounded multi-source research;
- browser automation with explicit sessions and tabs;
- a Tauri desktop workspace for live viewing and user control;
- PDF and office-document conversion;
- the Pi extension that presents one clear tool set;
- one Fedora installer and uninstaller.

Search and direct reading do not require the visual browser. Browser automation starts only when a dynamic page, interaction, or visual check needs it.

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

Pi must already be installed. Then run:

```bash
./install-fedora.sh
```

The installer stages the source at `~/.local/lib/pi-web-tools`, installs locked dependencies, builds the services and Tauri app, links the Pi extension, and starts user services.

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

- `web_search` — fixed fast, quality, and deep recipes for URL links or separate sourced extracts
- `web_read` — includes optional bounded Crawl4AI rendering, linked-page extraction, and one-page Markdown export
- `browser_open`
- `browser_tabs`
- `browser_observe`
- `browser_act`
- `browser_debug`

Only the user changes capability modes with `/web off|read|browser|debug`.

Search and read are capability groups rather than thin provider wrappers. Search uses required `operation` (`links` or `extracts`) and `effort` (`fast`, `quality`, or `deep`) axes. Its six fixed recipes hide provider counts and page-reading budgets. Search never follows links, and extracts do not synthesize across sources. WebX uses SearXNG JSON for all search discovery. It can then select direct fetch, structured JSON, main-content extraction, Crawl4AI rendering, document conversion, source ranking, and evidence extraction behind these two stable Pi tools. Full reads return complete main content up to the explicit 1,000,000-character source bound. WebX does not add a smaller facade limit. An explicit saved read writes one normal or focused extraction below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` and returns compact metadata instead of sending the body through the transcript. Existing files are protected unless overwrite is explicit. Structured API projections return complete row objects. If a source applies a bound, `contentOffset`, item pagination, or a section query provides a precise continuation. Source and crawl-link details remain structured metadata. Deep extracts return bounded passages from up to ten selected sources instead of complete pages. Browser capabilities advertise only actions that the installed path can execute.

## Real-usage audit history

The Pi extension records each real `web_search` and `web_read` call at its agent-facing boundary. Each user-only record contains the input, structured SDK result, final agent-visible output, timing, status, and failure details. Obvious credential fields and sensitive URL parameters are redacted. Browser and research calls are not recorded.

Records are stored under `${XDG_STATE_HOME:-~/.local/state}/pi-web/audit` with directory mode `0700` and file mode `0600`. The extension removes records older than 90 days and removes the oldest records when total storage exceeds 10 GiB. This history is separate from the traffic cache and is not exposed as model-facing recall.

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
