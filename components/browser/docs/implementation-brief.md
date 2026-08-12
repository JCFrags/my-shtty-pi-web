# Pi Web Workspace — Implementation Brief and Build Plan

**Audience:** an autonomous coding agent or engineering team building the final web capability for the Pi coding agent.

**Target platform:** Fedora Linux desktop.

**Product constraints:** free and self-hosted; capability-first; persistent authenticated browser use; visual human supervision; efficient model context; multiple Pi agents running concurrently on one computer.

**Date of brief:** 2026-07-27.

---

## 1. Mission

Build a first-class web subsystem for Pi that combines:

1. Self-hosted search through SearXNG.
2. Efficient main-content reading without launching a full browser unnecessarily.
3. Fast JavaScript execution through Lightpanda.
4. Complete Chromium control for visual sites, authenticated dashboards, extensions, uploads, downloads, debugging, and arbitrary browser actions.
5. A desktop companion named **Pi Browser Workspace** that makes browser sessions feel like a natural extension of Pi rather than unrelated Chrome windows.
6. Correct coordination when several Pi agents run at the same time.
7. A backend abstraction that starts with `agent-browser`, while preserving a clean path to Rustwright and PinchTab.
8. Token-efficient observations using Markdown, compact element references, page deltas, and selective TOON encoding.

The finished experience should resemble an integrated coding-agent browser:

- Pi remains usable in an ordinary terminal.
- `/browser` raises a dedicated desktop workspace.
- The workspace shows every active Pi agent and its browser sessions.
- The selected session has a live, interactive browser viewport.
- The actual website runs in Chromium or Lightpanda; the desktop app is a control and display shell.
- Humans and agents can operate the same session.
- Persistent Chromium profiles can contain password-manager extensions and authenticated sessions.
- Multiple agents do not collide through a global “current browser.”

---

## 2. Product principles

Use these principles to resolve ambiguous implementation choices.

### 2.1 Capability first

Do not turn the product into a restrictive policy gateway. The browser must support normal browser capabilities: clicks, typing, keyboard shortcuts, multiple tabs, JavaScript evaluation, console and network inspection, cookies and storage, extensions, persistent profiles, downloads, uploads, screenshots, PDFs, and visual interaction.

Optional confirmation, allowlist, isolation, and redaction features may exist, but they must not define the basic architecture or prevent normal power-user workflows.

### 2.2 Minimize model context, not browser capability

The browser can remain fully capable while the model receives a compact observation. Avoid sending full DOM trees, complete accessibility trees, screenshots, network logs, or browser state unless the task requires them.

### 2.3 Reuse proven components

Do not reimplement a browser automation daemon or live-view protocol before proving that an existing component is insufficient.

Start with `agent-browser` because it already provides:

- A native Rust daemon using CDP.
- Named sessions and namespaces.
- Chromium and Lightpanda engines.
- Persistent Chromium profiles.
- Extension loading.
- Compact accessibility snapshots and element references.
- Screenshots, uploads, downloads, network, console, storage, and debugging operations.
- A local dashboard that discovers all sessions.
- Per-session WebSocket viewport streaming with mouse, keyboard, and touch input.

Use `agent-browser` as an external dependency initially. Do not fork the entire project in the first milestone.

### 2.4 One coherent desktop workspace

Do not open one ordinary Chrome window per agent as the product UI. The user should normally see one Pi Browser Workspace window containing all agents and sessions.

### 2.5 Explicit identity everywhere

No browser operation may rely on one process-global “current agent,” “current browser,” or “current tab.” Every operation must resolve through explicit agent, browser-session, and tab identifiers.

### 2.6 Backend independence

The desktop workspace, Pi extension, search system, reader, and artifact store must not depend on `agent-browser`-specific semantics. Hide backend differences behind a common controller interface.

### 2.7 Internal JSON, model-facing optimized text

Use typed JSON internally. TOON is a final presentation encoding for suitable model-facing results, not the daemon protocol or persistent storage format.

---

## 3. Non-goals for the initial release

Do not spend the first implementation cycle on:

- Building a new browser engine.
- Replacing Chromium rendering.
- Implementing a new remote-desktop codec.
- Supporting every operating system.
- Supporting cloud browser providers.
- Building a multi-user or Internet-facing service.
- Mandatory per-domain permission systems.
- A custom password manager.
- A vector database.
- Simultaneously integrating all browser backends.
- A complete graphical replacement for Pi itself.

The first release is for one trusted Fedora desktop user running several local Pi agents.

---

## 4. Required user experience

### 4.1 Terminal companion mode

Pi continues to run in any terminal. The Pi extension adds:

```text
/web off
/web read
/web browser
/web debug

/browser
/browser show
/browser hide
/browser sessions
/browser profile <name>
/browser attach <session>
```

The Pi status area should show a compact state such as:

```text
web: chromium · 2 tabs · unifi.home.arpa
```

Calling `/browser` or `/browser show` must launch or raise the Pi Browser Workspace and select the invoking Pi agent.

Background search and reading must not steal focus. A browser tool may request attention, but normal background work should only update badges.

### 4.2 Pi Browser Workspace

The default layout should resemble an IDE:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Pi Browser Workspace                                                   │
├──────────────────┬──────────────────────────────────────────────────────┤
│ Agents           │ Agent: homelab                                      │
│                  │ Profile: main                                       │
│ ● homelab        │ [←] [→] [↻] https://unifi.home.arpa                │
│   ├ UniFi        │ [UniFi] [Vaultwarden] [+]                            │
│   └ Proxmox      ├──────────────────────────────────────────────────────┤
│                  │                                                      │
│ ● docs-research  │             Live browser viewport                    │
│   └ Fedora docs  │                                                      │
│                  │      Human and agent operate the same browser        │
│ ○ test-runner    │                                                      │
│                  │                                                      │
├──────────────────┼──────────────────────────────────────────────────────┤
│ Activity         │ click “Client Devices”                               │
│ Downloads        │ page loaded                                          │
└──────────────────┴──────────────────────────────────────────────────────┘
```

The workspace must provide:

- Agent tree grouped by Pi session/project.
- Browser sessions and tabs beneath each agent.
- Live viewport for the selected tab.
- Address, back, forward, reload, new tab, and close tab.
- Profile and engine indicator.
- Human/agent control indicator.
- Activity timeline.
- Downloads and artifact access.
- Optional console, network, storage, and extensions panels in debug mode.
- Background-session thumbnails or last-frame previews.
- Attention badges without involuntary focus switching.

### 4.3 Human takeover

When the user clicks or types inside the viewport, mark the tab as human-controlled. Queue agent actions for that tab until the user selects **Return to agent**. An optional inactivity timeout may automatically return control.

This is a coordination mechanism, not a permission mechanism.

### 4.4 Future workbench mode

After companion mode is stable, add an optional integrated terminal pane. Run Pi in a PTY and display its ordinary TUI through xterm.js. Do not rewrite Pi’s TUI.

A later graphical Pi client may use Pi’s SDK or RPC mode, but that is not required for the initial product.

---

## 5. System architecture

```text
Pi terminal A ─┐
Pi terminal B ─┼──── Unix socket / JSON-RPC ──── pi-browserd
Pi terminal C ─┘                                     │
                                                    ├── Agent registry
                                                    ├── Browser/profile registry
                                                    ├── Action queues
                                                    ├── Backend adapters
                                                    ├── Search and reader routing
                                                    ├── Artifact store
                                                    └── Workspace event stream
                                                             │
                  ┌──────────────────────────────────────────┼──────────────────────────┐
                  │                                          │                          │
                  ▼                                          ▼                          ▼
          SearXNG + reader                           Browser backends               Docling worker
                                                     │
                                                     ├── agent-browser (initial)
                                                     │    ├── Lightpanda
                                                     │    └── Chromium
                                                     ├── Rustwright (experimental)
                                                     └── PinchTab (optional)
                                                             │
                                                             ▼
                                                    viewport stream / CDP
                                                             │
                                                             ▼
                                                  Pi Browser Workspace
                                                  Tauri 2 + web frontend
```

### 5.1 Components

#### `pi-web` Pi extension

A TypeScript extension installed through Pi. It registers tools and commands, dynamically enables tools, identifies the Pi session, calls `pi-browserd`, renders compact results, and updates the TUI status.

#### `pi-browserd`

A user-level coordinator. Prefer Rust with Tokio and Axum because the desktop shell and browser backends are Rust/CDP-heavy, but correctness matters more than language choice.

Responsibilities:

- Register Pi agents and maintain heartbeats.
- Own stable IDs and metadata.
- Map agents to browser sessions and tabs.
- Enforce action ordering and profile ownership.
- Start/stop backend browser hosts.
- Proxy or expose viewport streams.
- Host search, read, and artifact APIs.
- Broadcast events to the workspace.
- Recover state after a UI restart.

#### Pi Browser Workspace

A Tauri 2 desktop app with a React-based frontend. Start from the concepts and protocol used by the existing `agent-browser` dashboard. The website itself is not loaded in the Tauri WebKit view; the Tauri app displays streamed browser frames and sends input to the real browser process.

#### SearXNG

A rootless Podman service used only for discovery. Enable JSON output in `settings.yml`.

#### Reader

A local main-content extraction pipeline. Use direct HTTP and Markdown negotiation first. Use Trafilatura for HTML extraction. Use a rendered Lightpanda or Chromium DOM when static extraction is insufficient.

#### Docling

A local document conversion worker for PDF and office formats. Return Markdown plus structured metadata and store complete output as artifacts.

---

## 6. Repository layout

Use one monorepo with both Cargo and pnpm workspaces.

```text
pi-web-workspace/
├── Cargo.toml
├── Cargo.lock
├── package.json
├── pnpm-workspace.yaml
├── README.md
├── AGENTS.md
├── docs/
│   ├── architecture.md
│   ├── protocol.md
│   ├── concurrency.md
│   ├── observations.md
│   ├── fedora-install.md
│   └── adr/
│       ├── 0001-agent-browser-first.md
│       ├── 0002-one-host-per-profile.md
│       ├── 0003-json-internal-model-formats.md
│       └── 0004-workspace-streaming.md
├── crates/
│   ├── browserd/
│   ├── protocol/
│   ├── artifact-store/
│   ├── reader-client/
│   ├── backend-core/
│   ├── backend-agent-browser/
│   ├── backend-rustwright/
│   └── backend-pinchtab/
├── packages/
│   ├── pi-extension/
│   ├── protocol-ts/
│   ├── result-format/
│   └── test-fixtures/
├── apps/
│   └── workspace/
│       ├── src-tauri/
│       └── src/
├── services/
│   ├── reader/
│   │   ├── pyproject.toml
│   │   └── src/
│   └── docling/
├── deploy/
│   ├── searxng/
│   ├── quadlet/
│   └── install-fedora.sh
├── fixtures/
│   ├── static-site/
│   ├── spa/
│   ├── canvas-app/
│   ├── iframe-app/
│   ├── auth-app/
│   ├── uploads-downloads/
│   └── browser-extension/
└── tests/
    ├── protocol/
    ├── reader/
    ├── multi-agent/
    ├── workspace/
    ├── backends/
    └── e2e/
```

Generate TypeScript protocol types from a single schema or maintain conformance tests that guarantee the Rust and TypeScript representations match.

---

## 7. Runtime paths on Fedora

Follow XDG conventions.

```text
$XDG_RUNTIME_DIR/pi-web/
├── browserd.sock
├── browserd.json
├── agents/
├── streams/
└── locks/

~/.config/pi-web/
├── config.toml
├── profiles.toml
└── searxng.toml

~/.local/share/pi-web/
├── pi-web.sqlite3
├── profiles/
├── artifacts/
├── downloads/
├── screenshots/
└── logs/

~/.cache/pi-web/
├── pages/
├── browser-binaries/
└── document-models/
```

`browserd.json` should contain the daemon PID, protocol version, workspace HTTP/WebSocket endpoint, and startup timestamp.

---

## 8. Core data model

Use stable UUIDs or ULIDs. Do not use PIDs as durable identities.

```ts
interface AgentRegistration {
  agentId: string;
  clientId: string;
  piSessionId?: string;
  piSessionFile?: string;
  piSessionName?: string;
  cwd: string;
  pid: number;
  mode: "tui" | "rpc" | "json" | "print";
  startedAt: string;
  lastHeartbeatAt: string;
}

interface BrowserProfile {
  profileId: string;
  name: string;
  engine: "chromium";
  dataDir: string;
  extensions: string[];
  launchArgs: string[];
  visibleByDefault: boolean;
}

interface BrowserHost {
  hostId: string;
  backend: "agent-browser" | "rustwright" | "pinchtab";
  engine: "lightpanda" | "chromium";
  profileId?: string;
  state: "starting" | "ready" | "stopping" | "stopped" | "failed";
  backendSessionId: string;
  createdAt: string;
}

interface BrowserSession {
  browserSessionId: string;
  ownerAgentId: string;
  hostId: string;
  label: string;
  createdAt: string;
  lastActivityAt: string;
}

interface TabInfo {
  tabId: string;
  hostId: string;
  browserSessionId: string;
  ownerAgentId: string;
  title: string;
  url: string;
  index: number;
  control: "agent" | "human" | "shared";
  state: "idle" | "running" | "waiting" | "crashed";
  lastActionAt?: string;
}

interface ArtifactRecord {
  artifactId: string;
  sha256: string;
  ownerAgentId?: string;
  browserSessionId?: string;
  tabId?: string;
  mediaType: string;
  size: number;
  path: string;
  sourceUrl?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}
```

The browser-session abstraction represents work owned by one Pi agent. A browser host represents the actual Lightpanda or Chromium process. Several agent-owned sessions may share one Chromium host when they intentionally use the same persistent profile.

---

## 9. Coordinator protocol

### 9.1 Transports

Use newline-delimited JSON-RPC 2.0 over:

- Unix socket for Pi extension clients.
- A loopback HTTP/WebSocket endpoint for the workspace frontend.

Keep the transport versioned. Reject incompatible major versions clearly.

Do not encode transport messages as TOON.

### 9.2 Required methods

```text
system.ping
system.capabilities

agent.register
agent.heartbeat
agent.unregister
agent.list

workspace.show
workspace.hide
workspace.focusAgent
workspace.focusTab
workspace.requestAttention

profile.list
profile.create
profile.update
profile.delete

browser.start
browser.stop
browser.list
browser.openTab
browser.closeTab
browser.focusTab
browser.navigate
browser.observe
browser.act
browser.debug
browser.streamInfo

search.query
read.url
read.activeTab
artifact.get
artifact.list
artifact.delete
```

### 9.3 Required events

```text
agent.registered
agent.updated
agent.disconnected
browser.hostUpdated
browser.sessionUpdated
browser.tabUpdated
browser.activity
browser.attentionRequested
browser.controlChanged
browser.downloadUpdated
artifact.created
workspace.focusRequested
system.error
```

Viewport frames should travel on a dedicated stream channel rather than through the normal JSON-RPC event channel.

---

## 10. Browser backend interface

```rust
#[async_trait]
pub trait BrowserController: Send + Sync {
    async fn capabilities(&self) -> Result<BrowserCapabilities>;
    async fn start_host(&self, request: StartHostRequest) -> Result<BrowserHostHandle>;
    async fn stop_host(&self, host: &BrowserHostHandle) -> Result<()>;
    async fn list_tabs(&self, host: &BrowserHostHandle) -> Result<Vec<TabInfo>>;
    async fn open_tab(&self, host: &BrowserHostHandle, url: Option<&str>) -> Result<TabInfo>;
    async fn close_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()>;
    async fn focus_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()>;
    async fn navigate(&self, address: &BrowserAddress, url: &str) -> Result<ActionResult>;
    async fn observe(&self, address: &BrowserAddress, request: ObserveRequest) -> Result<Observation>;
    async fn act(&self, address: &BrowserAddress, action: BrowserAction) -> Result<ActionResult>;
    async fn debug(&self, address: &BrowserAddress, request: DebugRequest) -> Result<DebugResult>;
    async fn stream_info(&self, address: &BrowserAddress) -> Result<StreamInfo>;
}
```

### 10.1 Initial `agent-browser` adapter

Use a dedicated namespace:

```text
AGENT_BROWSER_NAMESPACE=pi-web-v1
```

Assign every browser host a unique `--session` value. Invoke `agent-browser` in `--json` mode and rely on its native persistent daemon.

The adapter must:

- Discover and validate the installed version.
- Pin a tested minimum and maximum supported version range.
- Convert backend IDs to stable coordinator IDs.
- Avoid relying on process-global current sessions.
- Select the intended tab before every action.
- Treat `focus tab -> perform action -> collect result` as one atomic backend operation when the backend cannot address a tab directly.
- Parse structured errors rather than matching arbitrary human text.
- Reconnect after daemon restart.
- Discover the session stream endpoint.
- Preserve complete backend output as an artifact when the model-facing result is abbreviated.

Do not patch `agent-browser` during the first vertical slice. Open an upstream issue or add a narrow compatibility shim when required.

### 10.2 Rustwright adapter

Implement only after the agent-browser vertical slice and benchmarks are stable.

Prefer Rustwright’s native Rust API or native MCP/server path, not the early Node binding. The adapter must pass the same backend conformance tests.

Do not switch the default merely because a synthetic `goto()` test is faster. Compare complete workflows, including observation, action, screenshot, profile behavior, and recovery.

### 10.3 PinchTab adapter

Use PinchTab as an alternate full-browser service and a source of implementation ideas, particularly multi-instance management, profile handling, paired screenshot/snapshot capture, and handoff.

The workspace and Pi extension must not change when selecting PinchTab.

---

## 11. Multi-agent and profile concurrency

This is a core product requirement, not an afterthought.

### 11.1 Agent identity

At Pi session start, derive or create a stable `agentId` from:

1. Pi session identifier or session file when available.
2. A persisted extension entry when the session is new.
3. A generated UUID as fallback.

Create a separate `clientId` for each running Pi process. This distinguishes two terminals attached to the same Pi session.

Send a heartbeat every five seconds while Pi is active. Mark a client disconnected after fifteen seconds without deleting its browser state.

### 11.2 Default browser allocation

- Anonymous Lightpanda work: one host per Pi browser session or a backend-managed pool with strict session separation.
- Ephemeral Chromium: one host per agent-owned browser session by default.
- Persistent named profile: one Chromium host per profile, shared through agent-owned tabs.

### 11.3 One host per persistent profile

Never launch two Chromium processes against the same user-data directory.

When agents request the same profile:

1. Reuse the profile host.
2. Open an agent-owned tab.
3. Track ownership in the coordinator.
4. Serialize profile-global operations.

### 11.4 Action queues

The initial implementation may use one action queue per host:

```text
select tab
→ perform one action or observation
→ collect result
→ release host lock
```

Unrelated hosts execute concurrently.

Later, when a backend supports direct tab-addressed operations safely, move to one queue per tab while retaining a smaller host-level lock for profile-global operations such as extension popups, downloads, and browser settings.

### 11.5 Tab ownership

A tab belongs to one agent by default. The workspace may reassign ownership explicitly. Background agents must not issue actions to the user’s currently human-controlled tab.

### 11.6 Focus behavior

Never switch the workspace automatically for every background navigation. The invoking agent may request attention, creating a badge. `/browser` from a terminal must select that terminal’s agent immediately.

### 11.7 Resource management

Support configurable limits:

```toml
[limits]
max_chromium_hosts = 6
max_lightpanda_hosts = 24
max_tabs_per_host = 30
background_thumbnail_interval_ms = 2000
```

Do not terminate a selected or human-controlled browser. Idle cleanup should be configurable and disabled for persistent profile hosts by default.

---

## 12. Viewport and desktop integration

### 12.1 Preferred display path

Use the existing `agent-browser` viewport WebSocket stream. It sends JPEG frames and accepts mouse, keyboard, and touch input.

The Tauri application should render frames into a canvas and translate pointer coordinates using the frame metadata.

### 12.2 Selected versus background sessions

- Selected tab: continuous full-rate stream.
- Visible background thumbnail: low-rate stream or update after actions.
- Hidden background tab: do not subscribe unless needed.

The browser can continue running without model or UI frame consumption.

### 12.3 Workspace single-instance behavior

Run one workspace process per user. A second launch must signal the existing process and exit. The daemon sends focus requests to the running workspace.

### 12.4 Browser chrome

The workspace supplies its own tab strip and navigation controls. The initial viewport represents the web page, not Chromium’s native toolbar.

### 12.5 Password-manager and extension feasibility spike

This must happen in the first engineering cycle because it can affect the visual architecture.

Test at least one real extension path:

- KeePassXC-Browser with a dedicated test database, or
- Bitwarden connected to a local Vaultwarden test instance.

Test:

1. Persistent profile creation.
2. Extension installation/loading.
3. Autofill through keyboard shortcut.
4. Extension page visibility as a CDP target.
5. Behavior in `--headless=new` with page screencasting.
6. Behavior in headed mode.

Preferred solution:

- Keep the browser page stream.
- Trigger autofill through normal keyboard shortcuts.
- Open extension pages as workspace tabs when necessary.

Compatibility fallback:

If an essential extension popup or browser-native UI cannot be represented, add an optional **full-window mode** using headed Chromium in a nested display and stream the complete application window. Xpra is an acceptable free fallback. Do not make Xpra mandatory unless the extension spike proves it necessary.

---

## 13. Pi extension

### 13.1 Dynamic tool modes

Use Pi’s `pi.setActiveTools()` support. Preserve the user’s existing active tools and only add/remove this extension’s tools.

```text
/web off
    no web tools active

/web read
    web_search
    web_read
    artifact_read

/web browser
    web_search
    web_read
    browser_open
    browser_observe
    browser_act
    artifact_read

/web debug
    all browser tools plus browser_debug
```

The mode persists with the Pi session.

### 13.2 Tool surface

#### `web_search`

```ts
web_search({
  query: string,
  limit?: number,
  domains?: string[],
  freshness?: "day" | "week" | "month" | "year"
})
```

#### `web_read`

```ts
web_read({
  url?: string,
  browserSessionId?: string,
  tabId?: string,
  query?: string,
  view?: "main" | "outline" | "raw",
  maxChars?: number
})
```

When a browser tab is supplied, read the rendered authenticated DOM.

#### `browser_open`

```ts
browser_open({
  url?: string,
  engine?: "auto" | "lightpanda" | "chromium",
  profile?: string,
  visible?: boolean,
  newTab?: boolean,
  label?: string
})
```

#### `browser_observe`

```ts
browser_observe({
  browserSessionId?: string,
  tabId?: string,
  view?: "main" | "interactive" | "visual" | "full" | "diff",
  selector?: string,
  maxChars?: number
})
```

#### `browser_act`

Use a discriminated union for:

```text
navigate
click
fill
type
press
select
hover
scroll
drag
upload
download
back
forward
reload
wait
tab-new
tab-close
tab-focus
```

Every action accepts explicit browser-session and tab IDs. Defaults may resolve to the current agent’s last tab, never another agent’s global state.

#### `browser_debug`

Only active in debug mode. Include:

```text
evaluate
console
network
html
cookies
storage
pdf
record-start
record-stop
```

#### `artifact_read`

```ts
artifact_read({
  artifactId: string,
  offset?: number,
  limit?: number
})
```

### 13.3 Session lifecycle

On `session_start`:

- Connect to or launch `pi-browserd`.
- Register the agent.
- Restore the extension’s mode and browser mappings.
- Start heartbeats.
- Set the status indicator.

On session switch/fork/resume:

- Update registration metadata.
- Preserve or clone mappings according to the Pi session relationship.
- Do not silently transfer tab ownership on a fork; create a new mapping unless the user explicitly attaches.

On `session_shutdown`:

- Stop heartbeats.
- Unregister the client.
- Do not close persistent browser sessions automatically unless configured.

### 13.4 Workspace commands

`/browser` should call `workspace.show` and `workspace.focusAgent`.

Add a configurable Pi keyboard shortcut for the same action.

---

## 14. Observation model and token efficiency

### 14.1 `main` observation — default

Return:

- Page title and URL.
- Main visible content.
- Relevant headings.
- Toasts, alerts, dialogs, and validation messages.
- A concise change summary when there was a preceding action.

Example:

```text
page: UniFi Network
url: https://unifi.home.arpa/network/default/clients

main:
  48 connected clients
  3 access points online
  Gateway health: Excellent

changed:
  Client list finished loading.
```

### 14.2 `interactive` observation

Return only useful controls with refs:

```text
controls[6]{ref,role,name,state}:
  e12,button,Add client,enabled
  e18,textbox,Search clients,enabled
  e25,button,Display options,enabled
  e31,link,Desktop-PC,enabled
  e42,button,Block,enabled
  e49,button,Reconnect,enabled
```

A compact line format is also acceptable when it tokenizes better.

### 14.3 `visual` observation

Return:

- Screenshot as an image result or artifact.
- URL and title.
- A small list of relevant interactive refs.
- Optional bounding boxes.

The human workspace stream does not consume model tokens. A screenshot enters model context only when requested or when the backend determines that a page cannot be interpreted adequately through text.

### 14.4 `full` observation

Return the complete accessibility or DOM-derived structure. Store the untruncated result as an artifact and give the model a bounded view.

### 14.5 `diff` observation

After actions, return only changed state when possible.

```text
ok: true
action: click e42 "Block"

changed:
  dialog: Block Desktop-PC?
  warning: This client will lose network access.
  controls:
    e73 button "Cancel"
    e74 button "Confirm"
```

A successful CDP input event is not sufficient. The result should report visible page changes, URL changes, dialogs, new tabs, downloads, or lack of observable change.

### 14.6 TOON policy

Use the official TypeScript TOON implementation in the Pi extension’s result-format package.

Good TOON candidates:

- Search results.
- Tabs.
- Interactive controls.
- Network request summaries.
- Console messages.
- Downloads.
- Action histories.

Keep Markdown for prose and documentation. Keep compact JSON for irregular, deeply nested, or error-heavy structures when it is smaller or clearer.

Add a benchmark corpus and choose between TOON, compact JSON, and line format based on actual token counts for the active model family.

---

## 15. Search and reading pipeline

### 15.1 SearXNG

Run SearXNG through rootless Podman. Configure JSON output:

```yaml
search:
  formats:
    - html
    - json
```

The search adapter should:

- Call `/search` with `format=json`.
- Normalize URLs.
- Deduplicate results.
- Remove common tracking parameters.
- Preserve engine attribution.
- Return a bounded result count.
- Cache short-lived query results.

### 15.2 `web_read` resolution order

```text
1. HTTP request with Accept: text/markdown
2. Original URL response if Markdown/plain text
3. URL.md or index.md fallback
4. Nearest llms.txt
5. llms-full.txt only when explicitly requested
6. HTML extraction with Trafilatura
7. Render with Lightpanda and extract main visible content
8. Render with Chromium when Lightpanda fails or authenticated state is required
```

### 15.3 Main-content extraction

Trafilatura should return Markdown and metadata. Exclude recurring navigation, sidebars, headers, footers, hidden elements, and unrelated controls in the default view.

For active browser tabs, serialize the rendered DOM or relevant visible region and pass it through the same extraction/cleanup interface.

### 15.4 Documents

Detect PDFs and office files. Send them to Docling. Store:

- Markdown.
- Lossless or structured JSON when requested.
- Page/table/image metadata.
- Original file artifact.

Return only the initial useful section and an artifact ID to Pi.

---

## 16. Artifact store

Use SQLite for metadata and a content-addressed filesystem for bytes.

```text
~/.local/share/pi-web/artifacts/sha256/ab/cd/<full-hash>
```

The store must support:

- SHA-256 identity.
- MIME type.
- Source URL.
- Agent/session/tab ownership metadata.
- Byte ranges and text paging.
- Search by session and time.
- Per-session download directories.
- Automatic duplicate elimination.
- Configurable retention.

Never assume the global `~/Downloads` directory. Every browser session gets a dedicated download directory and the workspace presents a combined, grouped view.

---

## 17. Engine routing

Use simple capability routing.

### 17.1 Direct reader

Use for ordinary documentation, articles, Markdown, JSON, feeds, and static pages.

### 17.2 Lightpanda

Use for:

- JavaScript-rendered reading.
- Anonymous SPAs.
- Lightweight interaction.
- Background research.
- Parallel tasks where graphical rendering is unnecessary.

### 17.3 Chromium

Select Chromium immediately when any of these apply:

- Persistent profile.
- Password-manager extension.
- Visible live browser requested.
- Screenshot fidelity needed.
- Canvas, WebGL, or complex UI.
- Upload or download workflow.
- Browser-native authentication or dialogs.
- Passkeys.
- Lightpanda returns an unsupported feature or repeated failure.

Do not attempt to migrate a live authenticated Lightpanda session into Chromium. Start authenticated work in Chromium.

---

## 18. Fedora installation and services

### 18.1 Native desktop components

Run natively as user services or desktop applications:

- `pi-browserd`.
- Pi Browser Workspace.
- Chromium.
- Lightpanda.
- Password-manager desktop integration.

### 18.2 Rootless Podman components

Use rootless Podman for:

- SearXNG.
- Optional Valkey if required by the selected SearXNG configuration.
- Docling service or disposable worker.

### 18.3 User systemd units

Provide user units or Quadlets for the daemon and supporting services. The workspace may autostart through a desktop file but should also start on demand.

### 18.4 Tauri Fedora prerequisites

The install script should install the current Tauri 2 Fedora dependencies, including WebKitGTK 4.1 development packages, OpenSSL development headers, appindicator, librsvg, libxdo, and the C development group.

### 18.5 Idempotent installer

Create:

```text
./deploy/install-fedora.sh
```

It should:

- Check rather than blindly reinstall dependencies.
- Install or validate Rust, Node/pnpm, Python/uv, Chromium, Podman, and Tauri prerequisites.
- Install a pinned Lightpanda build.
- Install a compatible `agent-browser` version.
- Deploy SearXNG.
- Build and install the Pi extension, daemon, and workspace.
- Create user service files.
- Print diagnostic commands.

Also provide `pi-web doctor` with machine-readable JSON output.

---

## 19. Phased implementation plan

Each phase ends with a running demonstration and automated tests. Do not begin broad backend work before the current phase passes its gate.

### Phase 0 — upstream validation and architectural spikes

Tasks:

1. Install current Pi, agent-browser, Chromium, and Lightpanda on Fedora.
2. Confirm agent-browser named sessions and namespace isolation.
3. Start the agent-browser dashboard and verify multiple sessions appear.
4. Connect directly to a session stream; render frames and inject mouse/keyboard events.
5. Validate persistent Chromium profiles and extension loading.
6. Perform the password-manager feasibility spike.
7. Measure Lightpanda and Chromium behavior on the fixture corpus.
8. Record upstream versions and capabilities.
9. Write the four initial ADRs.

Gate:

- Two independent agent-browser sessions run simultaneously.
- One Chromium profile persists login state.
- One extension loads.
- The viewport stream is interactively controllable.
- The team has a documented extension-popup strategy.

### Phase 1 — one-agent vertical slice

Build:

- Protocol crate/package.
- Minimal `pi-browserd` with Unix socket.
- Agent registration.
- Agent-browser backend adapter.
- Pi extension with `browser_open`, `browser_observe`, and `browser_act`.
- `/browser show` that opens the existing agent-browser dashboard.
- Minimal artifact support for screenshots.

Gate:

From Pi in a terminal, the agent can:

1. Open a Chromium page.
2. Observe interactive controls.
3. Click and type.
4. Request a screenshot.
5. Raise a live browser dashboard.
6. Reuse the session for multiple turns.

### Phase 2 — multi-agent coordinator

Build:

- Stable agent and client IDs.
- Heartbeats and disconnected-client handling.
- Browser-session and tab registry.
- Explicit addressing in every operation.
- Per-host action queues.
- Unique agent-browser sessions/namespaces.
- Per-session artifact/download directories.
- A multi-agent integration test harness that starts at least three Pi-extension mock clients.

Gate:

Three agents can operate concurrently:

- Agent A: Chromium session.
- Agent B: Lightpanda session.
- Agent C: another Chromium session.

No action, observation, screenshot, or download crosses session boundaries.

### Phase 3 — Pi Browser Workspace

Build:

- Tauri 2 single-instance application.
- Agent/session tree.
- Selected live viewport.
- Navigation and tab controls.
- Human input injection.
- Human/agent control state.
- Activity timeline.
- Focus/raise commands from the daemon.
- Background badges and thumbnails.

Start by adapting the existing agent-browser dashboard protocol and UI concepts. Keep upstream attribution and licenses.

Gate:

- One desktop window shows all three test agents.
- Switching agents switches viewports without restarting browsers.
- User input controls the selected browser.
- `/browser` from any terminal raises the workspace and selects the correct agent.
- Background agents do not steal focus.

### Phase 4 — search, reader, and documents

Build:

- SearXNG deployment and adapter.
- Direct Markdown negotiation.
- `.md`, `llms.txt`, and `llms-full.txt` resolution.
- Trafilatura worker.
- Render escalation through Lightpanda and Chromium.
- Active-tab authenticated reading.
- Docling worker.
- Artifact paging.

Gate:

The fixture corpus and a real documentation corpus produce useful main-content Markdown without browser snapshots by default. PDFs return an initial Markdown section and pageable artifacts.

### Phase 5 — context-efficient observations

Build:

- `main`, `interactive`, `visual`, `full`, and `diff` views.
- Page-change detection.
- Compact element formatting.
- Selective TOON encoding.
- Output size limits and automatic artifact fallback.
- Token benchmark suite using representative model tokenizers.

Gate:

On the benchmark corpus:

- Normal page reads avoid full accessibility trees.
- Typical interactive observations are substantially smaller than raw JSON/DOM output.
- Actions return meaningful deltas.
- The full original result remains recoverable through an artifact ID.

### Phase 6 — persistent profiles and shared profile hosts

Build:

- Profile configuration UI and file.
- One Chromium host per profile.
- Agent-owned tabs in shared hosts.
- Profile-global and tab-level coordination.
- Password-manager workflows.
- Extension pages/panels as supported.
- Optional full-window compatibility mode only if required by the Phase 0 spike.

Gate:

- Login once and reuse the profile after restart.
- Password-manager autofill works without placing the password in a Pi tool argument.
- Two agents may use separate tabs in one profile without profile locking or tab confusion.
- One human may take over a tab and return it to the agent.

### Phase 7 — alternate backends and benchmarks

Build:

- Browser backend conformance suite.
- Rustwright adapter.
- PinchTab adapter.
- Backend selection in profile/config.
- End-to-end workflow benchmark runner.

Benchmark:

- Cold start.
- Warm action latency.
- Main-content observation latency.
- Interactive snapshot size.
- Screenshot latency.
- Driver and browser RSS separately.
- Multi-agent throughput.
- Stale-ref and recovery rate.
- Extension/profile compatibility.
- Complete task success rate.

Gate:

At least agent-browser and one alternate backend pass the same functional suite. Keep agent-browser as default unless another backend wins on representative workflows without a capability regression.

### Phase 8 — packaging, documentation, and optional workbench

Build:

- Fedora installer.
- User services.
- Desktop file and icon.
- Upgrade and rollback process.
- `pi-web doctor`.
- User documentation.
- Developer documentation.
- Optional embedded PTY workbench.

Gate:

A clean Fedora machine can install, launch Pi, enable the extension, and open the workspace using documented commands.

---

## 20. Test strategy

### 20.1 Unit tests

Cover:

- ID generation and session mapping.
- Protocol serialization.
- Profile locking.
- Action queues.
- Search result normalization.
- TOON selection logic.
- Artifact paging.
- Observation diffing.

### 20.2 Backend conformance tests

Every backend must support a common fixture suite:

- Open/navigate.
- Tabs.
- Click/fill/type/press/select/hover/scroll.
- Dialogs.
- Same-origin and cross-origin iframes where supported.
- Screenshots.
- Downloads and uploads.
- Console and network inspection.
- Persistent profile restart.
- Extension loading for Chromium backends.
- Crash and reconnect.

Record explicit capability gaps rather than simulating success.

### 20.3 Reader corpus

Include:

- Static article.
- Documentation page with sidebars.
- Markdown response.
- `llms.txt` site.
- Client-rendered SPA.
- Authenticated dashboard.
- Long page.
- JSON API.
- PDF with tables.
- Scanned PDF.

### 20.4 Multi-agent stress tests

At minimum:

1. Ten concurrent Lightpanda sessions.
2. Four independent Chromium hosts.
3. Three agents sharing one persistent-profile host through different tabs.
4. Continuous workspace switching while agents act.
5. Human takeover during queued agent work.
6. Agent process crash and reconnection.
7. Workspace restart while browsers remain alive.
8. Daemon restart and state reconstruction.

### 20.5 Visual tests

Use Playwright or an equivalent test harness against the workspace UI. Capture deterministic snapshots of:

- Agent tree.
- Active viewport.
- Attention badges.
- Download panel.
- Human-control state.
- Empty, loading, failed, and crashed states.

---

## 21. Performance targets

Treat these as engineering targets, not absolute release blockers until measured on the target Fedora machine.

- Workspace launch to usable UI: under 1.5 seconds warm.
- `/browser` focus request to visible workspace: under 250 ms when already running.
- Selected viewport local interaction feedback: p95 under 300 ms excluding website response time.
- Daemon command overhead: p95 under 40 ms excluding backend/browser work.
- Typical interactive observation: under 1,000 model tokens; target 200–500.
- Background sessions with no viewers should not continuously encode frames.
- Workspace restart must not restart active browsers.
- Browser actions on unrelated hosts must execute concurrently.

---

## 22. Acceptance criteria for the final vision

The project is complete when all of the following are demonstrated on Fedora:

1. Pi runs normally in an external terminal.
2. `/browser` opens or raises one Pi Browser Workspace window.
3. The workspace groups browser sessions by the invoking Pi agent.
4. At least three Pi agents can run simultaneously.
5. Each agent can have multiple tabs.
6. The selected browser is live and accepts human input.
7. Human takeover pauses conflicting agent actions for that tab.
8. Background agents continue working without stealing focus.
9. Lightpanda handles fast background browsing.
10. Chromium handles visual and authenticated workflows.
11. A persistent profile survives restart.
12. A password-manager extension works in that profile.
13. SearXNG search works without paid APIs.
14. `web_read` returns main-content Markdown by default.
15. Authenticated browser pages can be read from the active rendered tab.
16. Screenshots are optional model inputs, not the default observation.
17. Action results return page deltas when possible.
18. Large results and downloads use artifacts and paging.
19. TOON is used only where it improves model-facing output.
20. Agent-browser is replaceable behind the controller interface.
21. Rustwright and PinchTab can be evaluated without redesigning the workspace or Pi extension.
22. No cloud browser, paid search API, or hosted extraction dependency is required.

---

## 23. Instructions to the implementation agent

Follow these rules while executing the plan.

1. **Verify upstream before coding.** Read the current Pi extension/RPC docs, agent-browser dashboard/stream/session docs, Lightpanda status, Rustwright limitations, PinchTab API, SearXNG API, TOON spec, Trafilatura docs, Docling docs, and Tauri Fedora prerequisites. Pin exact tested versions or commits.
2. **Build vertical slices.** Every phase must leave a runnable end-to-end demonstration. Avoid months of protocol work before a browser appears.
3. **Do not overengineer policy.** Implement coordination and optional settings, not mandatory restrictions that remove browser capability.
4. **Do not expose backend-specific tools to Pi.** Pi receives one stable web tool set.
5. **Do not use one global current browser.** Explicit IDs are mandatory at the daemon boundary.
6. **Do not send large browser state to the model by default.** Store complete results as artifacts.
7. **Do not make screenshots the normal observation.** Main content and compact refs come first.
8. **Do not fork agent-browser immediately.** Wrap it, prove the product, then decide whether a narrow upstream contribution or maintained fork is warranted.
9. **Test password-manager behavior early.** Do not postpone extension UI until the end.
10. **Keep the UI separate from browser execution.** Tauri renders the workspace; Chromium renders websites.
11. **Commit in reviewable units.** Each commit should compile, test, and describe one coherent change.
12. **Document deviations.** If an upstream limitation forces a different design, write an ADR before spreading the workaround through the codebase.
13. **Measure real workflows.** Use UniFi-like dashboards, documentation, local SPAs, downloads, and extension flows—not only trivial example.com timings.
14. **Fail explicitly.** Capability gaps should return structured “unsupported” errors rather than silently changing engines or losing state.
15. **Preserve user control.** The workspace must always display what agent owns a tab, what action is running, and how to take over.

---

## 24. Initial execution queue

Perform these tasks first, in order:

1. Create the monorepo skeleton and CI.
2. Add an `AGENTS.md` containing this brief’s principles and current phase.
3. Pin and smoke-test agent-browser, Chromium, and Lightpanda on Fedora.
4. Start two named agent-browser sessions and verify dashboard discovery.
5. Write a tiny standalone stream viewer that displays one session and sends clicks.
6. Complete the password-manager/extension feasibility spike.
7. Define the protocol schema and generate Rust/TypeScript fixtures.
8. Implement `pi-browserd` ping, agent registration, and heartbeats.
9. Implement the agent-browser adapter for start/open/observe/click/type/screenshot/close.
10. Implement the Pi extension vertical slice and `/browser show`.
11. Add explicit browser-session and tab IDs everywhere.
12. Add the three-agent concurrency integration test.
13. Package the stream viewer as the first Tauri workspace.
14. Add the agent tree and focus routing.
15. Add SearXNG and `web_search`.
16. Add the direct reader and Trafilatura.
17. Add artifacts and paging.
18. Add observation levels and deltas.
19. Add persistent named profile hosts.
20. Run representative backend benchmarks before beginning Rustwright or PinchTab integration.

---

## 25. Required upstream references

Verify these at implementation time rather than assuming this brief’s date is current.

- Pi repository: https://github.com/earendil-works/pi
- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi RPC mode: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- agent-browser: https://github.com/vercel-labs/agent-browser
- agent-browser dashboard: https://agent-browser.dev/dashboard
- agent-browser streaming: https://agent-browser.dev/streaming
- agent-browser sessions: https://agent-browser.dev/sessions
- agent-browser Lightpanda engine: https://agent-browser.dev/engines/lightpanda
- Lightpanda: https://github.com/lightpanda-io/browser
- Rustwright: https://github.com/Skyvern-AI/rustwright
- PinchTab: https://github.com/pinchtab/pinchtab
- SearXNG search API: https://docs.searxng.org/dev/search_api.html
- Trafilatura: https://github.com/adbar/trafilatura
- Docling: https://github.com/docling-project/docling
- TOON: https://github.com/toon-format/toon
- TOON specification: https://github.com/toon-format/spec
- Tauri prerequisites: https://v2.tauri.app/start/prerequisites/

---

## 26. Final product definition

The final product is not merely a search plugin, a headless scraper, or an MCP wrapper. It is a local browser operating environment for Pi:

```text
Pi extension
    │
    ▼
pi-browserd
    ├── search and main-content reading
    ├── browser routing
    ├── multi-agent coordination
    ├── persistent profiles
    ├── artifacts
    └── stable backend interface
            │
            ├── Lightpanda
            ├── Chromium through agent-browser
            ├── Rustwright
            └── PinchTab
                    │
                    ▼
          Pi Browser Workspace
          one desktop window, many agents,
          live browser view, human interaction
```

Optimize for a coherent, powerful daily workflow. The user should experience the browser as part of Pi even though Pi itself remains terminal-native.
