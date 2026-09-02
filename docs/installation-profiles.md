# Installation profiles

Pi Web Tools uses small, composable installation profiles. The default is `web-core`.

| Profile | Adds | Main dependencies |
| --- | --- | --- |
| `web-core` | Search, direct read, stored content, and WebX | Node.js, SearXNG, and the reader Python package |
| `documents` | Text PDF conversion and a bounded Docling worker | Poppler `pdftotext` and Docling |
| `render` | Bounded dynamic rendering | Crawl4AI, Playwright Chromium, and the egress proxy |
| `browser` | Visual browser control and the workspace | Fedora Chromium, Agent Browser, Rust, GTK, WebKit, Tauri, and `pi-browserd` |
| `full` | All profiles | All dependencies above |

Each optional profile includes `web-core`. You can compose the three optional profiles. Use `full` alone. It is the compatibility name for all profiles.

```bash
# Default core candidate
./install-fedora.sh --stage

# Core plus document conversion
./install-fedora.sh --stage --profile documents

# Core plus render and browser support
./install-fedora.sh --stage --profile render --profile browser

# Compatibility profile
./install-fedora.sh --stage --profile full
```

`web-core` does not install or build Chromium, Agent Browser, Playwright, Crawl4AI, Docling, `pdftotext`, Rust, WebKit, GTK, Tauri, or `pi-browserd`. Document reading returns an explicit profile error. It uses a filtered pnpm install. It uses `uv sync --package pi-web-reader`. It does not use `uv sync --all-packages`.

The files in `install/profiles` are the reviewed source for packages, capabilities, units, and resource limits. `candidate-manifest.json` records the exact resolved profile. The cutover tool validates this record against the immutable candidate. It generates only the selected units. It removes obsolete optional units during a profile reduction. It records every prior path and service state before replacement. Rollback restores these bytes and states.

The reader and SearXNG services each use `MemoryMax=2G` and `TasksMax=512`. The document service uses one conversion process, a queue of two requests, a 120-second conversion deadline, `MemoryMax=4G`, `TasksMax=128`, a 256 MiB input limit, a 512 MiB private temporary file system, and a 16 MiB result limit. Timeout and cancellation stop the conversion process before the slot can recover. These limits leave margin above the deterministic extraction corpus high-water use. The limits prevent an unbounded core worker from consuming the complete user session. Change them only with new measured evidence and a contract test update.

Run the read-only dependency report before a build:

```bash
./scripts/pi-web-profile --check
./scripts/pi-web-profile --profile documents --profile browser --check
```

After cutover, `pi-web doctor --json` reports the installed profile, the reviewed core and document limits, `pdftotext`, selected artifact checks, and capability health. Office and scanned PDF readiness stays optional and false unless the release contains an acceptance-tested asset-set allowlist entry and `DOCLING_ARTIFACTS_PATH/model-assets.json` matches it. The current release has no such entry. A local digest manifest alone cannot enable or claim these capabilities. Browser health is required only when the installed profile contains `browser`.

## Phase 4A canary profile

`browser-agentcursor` is a separate prebuilt immutable candidate profile. It does not mutate or replace the legacy `browser` profile. Its closed Fedora 44 package set supplies Node 24, Python, Chromium, GTK/WebKit, systemd tools, and the release-mode Tauri runtime. Installation still selects `legacy`; use `~/.local/bin/pi-webctl backend agentcursor` only after exact-SHA preflight and install. See `browser-rebuild/PHASE4A-INSTALL-RUNBOOK.md`.
