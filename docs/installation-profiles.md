# Installation profiles

Pi Web Tools uses small, composable installation profiles. The default is `web-core`.

| Profile | Adds | Main dependencies |
| --- | --- | --- |
| `web-core` | Search, direct read, stored content, and WebX | Node.js, SearXNG, and the reader Python package |
| `documents` | PDF and office document conversion | Docling |
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

`web-core` does not install or build Chromium, Agent Browser, Playwright, Crawl4AI, Docling, Rust, WebKit, GTK, Tauri, or `pi-browserd`. It uses a filtered pnpm install. It uses `uv sync --package pi-web-reader`. It does not use `uv sync --all-packages`.

The files in `install/profiles` are the reviewed source for packages, capabilities, units, and resource limits. `candidate-manifest.json` records the exact resolved profile. The cutover tool validates this record against the immutable candidate. It generates only the selected units. It removes obsolete optional units during a profile reduction. It records every prior path and service state before replacement. Rollback restores these bytes and states.

The reader and SearXNG services each use `MemoryMax=2G` and `TasksMax=512`. These limits leave margin above the deterministic extraction corpus high-water use. The limits prevent an unbounded core worker from consuming the complete user session. Change them only with new measured evidence and a contract test update.

Run the read-only dependency report before a build:

```bash
./scripts/pi-web-profile --check
./scripts/pi-web-profile --profile documents --profile browser --check
```

After cutover, `pi-web doctor --json` reports the installed profile, the reviewed core limits, selected artifact checks, and capability health. Browser health is required only when the installed profile contains `browser`.
