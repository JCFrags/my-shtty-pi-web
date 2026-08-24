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
```

To remove installed code and services while preserving user data:

```bash
./uninstall-fedora.sh
```

Review `~/.config/pi-web`, `~/.local/share/pi-web`, and `~/.cache/pi-web` before deleting retained user data.

## Pi tools

- `web_search` — includes optional bounded Crawl4AI result enrichment
- `web_read` — includes optional bounded Crawl4AI rendering and linked-page extraction
- `web_research` — includes optional bounded Crawl4AI evidence collection
- `browser_open`
- `browser_tabs`
- `browser_observe`
- `browser_act`
- `browser_debug`

Only the user changes capability modes with `/web off|read|browser|debug`.

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
