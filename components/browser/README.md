# Pi Web Workspace

Pi Web Workspace is a local browser operating environment for the Pi coding agent on Fedora. It keeps Pi terminal-native while adding self-hosted search, low-context reading, fast JavaScript execution, persistent Chromium profiles, live visual supervision, human takeover, and explicit coordination across several simultaneous Pi agents.

The architecture is capability-first. Browser features are not removed to simplify policy: normal clicks, typing, keyboard input, tabs, uploads, downloads, screenshots, PDFs, JavaScript evaluation, network/console/storage inspection, persistent profiles, and extensions remain available whenever the selected backend supports them. Model context is reduced through bounded main-content observations, compact interactive references, deltas, and content-addressed artifacts rather than by weakening the browser.

## Architecture

```text
Pi terminals ── newline JSON-RPC / Unix socket ── pi-browserd
                                                       ├── SearXNG search
                                                       ├── HTTP/Markdown/Trafilatura reader
                                                       ├── Docling worker
                                                       ├── artifact store
                                                       └── BrowserController
                                                            ├── agent-browser + Chromium (required visual path)
                                                            └── PinchTab + Chromium (optional non-visual path)
                                                                  │
                                                                  ▼
                                                        Pi Browser Workspace
                                                        Tauri 2 + React canvas
```

The daemon owns stable agent, client, profile, host, browser-session, tab, and artifact IDs. There is no process-global current browser. Persistent profiles use one Chromium host per user-data directory; agent-owned tabs can share that host. Backend operations that require focus are serialized per host, while unrelated hosts execute concurrently.

## Repository

- `crates/browserd`: native coordinator, Unix/HTTP/WebSocket transports, recovery, queues, browser routing, human takeover, artifacts.
- `crates/backend-agent-browser`: external agent-browser adapter with version validation, namespaces, named sessions, atomic tab focus/action/observation, viewport discovery, and structured errors.
- `../../apps/pi-webx`: Pi tools, unified `/web` settings, lifecycle handling, and compact result formatting.
- `apps/workspace`: one Tauri/React desktop window containing the agent tree, tabs, live JPEG viewport, activity, artifacts, and debug panels.
- `services/reader`: Markdown negotiation, `.md`, `llms.txt`, Trafilatura, and explicit render escalation.
- `services/docling`: local PDF and office conversion to Markdown and structured metadata.
- `packages/browserd-reference`: zero-dependency executable reference coordinator used for deterministic concurrency tests and environments without Rust.
- `deploy`: service configuration templates and local defaults used by the root installer.
- `fixtures` and `tests`: browser, reader, multi-agent, protocol, observation, extension, and workspace fixtures.

## Install on Fedora

```bash
../../install-fedora.sh
```

The root installer validates the Fedora/Tauri toolchain, Node/pnpm, uv, Chromium, Podman, and Agent Browser. It builds the repository, installs user services, deploys loopback-only SearXNG, and links the extension at `~/.pi/agent/extensions/pi-web`.

Then start Pi normally. New sessions default to browser mode, so no command is required. Run `/web` with no options to open one settings menu. The menu controls capability modes and browser workspace actions.

All direct forms use the same slash command:

```text
/web
/web status
/web mode off|read|browser|debug
/web workspace show|hide|list
/web workspace attach|takeover|return <sessionId>
```

There is no separate browser slash command.

Diagnostics:

```bash
pi-web doctor --json
systemctl --user status pi-browserd pi-web-reader pi-web-docling pi-web-searxng
journalctl --user -u pi-browserd -f
```


## Pi tool surface

`web_search`, `web_read`, `browser_open`, `browser_tabs`, `browser_observe`, `browser_act`, and `browser_debug` form the Pi-facing surface. Every daemon browser operation resolves through an explicit agent, session, and tab address. Tool defaults only reuse the invoking agent’s own last tab.

Only the user changes capability modes. `browser_tabs` lets the model review its owned sessions and tabs, reuse relevant ones, and close transient tabs or sessions when they are no longer needed. Internal artifacts and short-lived caches are implementation details rather than separate Pi tools.

The default observation is `main`. `interactive` returns compact refs, `visual` adds an optional image artifact, `full` keeps the complete structure artifact-backed, and `diff` reports page changes after actions. Typed JSON stays internal. TOON is considered only for regular model-facing arrays and only when it is measurably smaller than compact JSON or line format.

## Development

Required local versions are recorded in `VERSION_PINS.toml` and `deploy/versions.env`.

```bash
corepack enable
pnpm install
uv sync --all-packages
cargo test --workspace
pnpm test
python -m pytest tests/reader tests/docling
```

Run the dependency-free coordinator tests without installing Rust or pnpm dependencies:

```bash
node --test packages/browserd-reference/test/*.test.mjs tests/multi-agent/*.test.mjs
```

Validate repository invariants and run the target-machine browser spikes:

```bash
node scripts/check-repo.mjs
node scripts/run-agent-browser-conformance.mjs
node scripts/password-manager-spike.mjs
node scripts/benchmark-agent-browser.mjs
```

The conformance, stream, and password-manager commands require Fedora, the pinned agent-browser release, Chromium, Lightpanda, and a disposable extension test profile. The dependency-free reference tests verify coordinator semantics but do not substitute for those release gates.

Run the fixture server:

```bash
node packages/test-fixtures/src/server.mjs
```

Protocol details and the retained architecture are under `docs/`.

## Operational boundaries

The initial release is a single trusted Fedora user’s local system. The daemon uses a user-owned Unix socket and capability-token-protected loopback HTTP/WebSocket endpoints; it is not an Internet-facing multi-user service. Optional redaction, confirmation, allowlisting, timeouts, resource ceilings, and isolation can be added around the stable protocol, but they are disabled by default where they could prevent task completion and are not allowed to reduce the baseline browser capability.

Alternate backends currently expose explicit capability metadata and structured `unsupported` responses. They are intentionally not selected automatically and cannot silently replace an active engine or lose browser state.

## License

Apache-2.0. Upstream components retain their own licenses and attribution; see `docs/upstream.md`.
