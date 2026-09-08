# terminal-browser


A real browser that runs inside your terminal



<video src="https://github.com/user-attachments/assets/abe2f43e-fc50-4866-b753-33388967945d" controls></video>



### Install this Pi/Herdr integration

Use a reviewed complete artifact from **this repository**, not the upstream curl
installer or Homebrew package. Node and Python 3.11 or newer are required for installation.
Pi and Herdr remain host applications. Build instructions are below.

```bash
INSTALL="$HOME/.local/share/terminal-browser-managed"
pnpm install:dist stage /absolute/path/terminal-browser-linux-x64.tar.gz /absolute/path/manifest-linux-x64.json "$INSTALL"
```

Staging validates the outer checksum, runtime pins, complete file inventory and
safe archive paths. It never changes active selections or starts a browser.
It returns the artifact ID. Keep the archive and its reviewed outer manifest.

Before first activation, prepare an owner-only JSON receipt with these fields.
All paths except `piSource` must be exact absolute paths. `piSource` is the exact
existing Pi `packages` source, including a relative source if currently used;
use `null` only for a fresh installation (the new package is appended).
`herdrSource` pins the existing local 0.2.0 plugin root; use `null` only when
that plugin is not registered. `herdrRegistry` is the persisted Herdr registry.
The CLI and Herdr parent directories must already exist. An occupied directory
at either selection is refused, not deleted.

```json
{
  "schemaVersion": 1,
  "namespace": "terminal-browser-dev-61753e09",
  "paths": {
    "dataHome": "/home/USER/.local/share",
    "stateHome": "/home/USER/.local/state",
    "cacheHome": "/home/USER/.cache",
    "runtimeHome": "/run/user/UID",
    "appData": "/home/USER/.config",
    "interopState": "/home/USER/.local/state/terminal-browser-interop",
    "interopShare": "/home/USER/.local/share/terminal-browser-interop"
  },
  "selection": {
    "cli": "/home/USER/.local/bin/terminal-browser",
    "herdr": "/home/USER/.local/share/terminal-browser-herdr",
    "piSettings": "/home/USER/.pi/agent/settings.json",
    "piSource": "packages/pi-terminal-browser",
    "herdrRegistry": "/home/USER/.config/herdr/plugins.json",
    "herdrSource": "/absolute/path/to/existing/herdr-plugin"
  }
}
```

For adoption, verify these are the existing installation's actual base paths,
not merely your current shell defaults. The accepted local development
namespace is `terminal-browser-dev-61753e09`; the unrelated `baadb0eb` namespace
must stay unchanged. For a fresh installation, choose a new namespace matching
`terminal-browser-` plus eight hexadecimal characters. Profiles, database/WAL,
cache and download history stay in place. No live state is copied. A locked or
uncertain profile is refused; no numbered or temporary profile is substituted.

```bash
chmod 600 /absolute/path/installation-receipt.json
pnpm install:dist configure "$INSTALL" /absolute/path/installation-receipt.json
pnpm install:dist activate "$INSTALL" ARTIFACT_ID
terminal-browser doctor --json
```

**Activation requires approval.** It changes next-launch selections, not loaded
processes. Pi gets the exact new absolute versioned package source at the same
index, preserving object filters and unrelated settings. Do not use a stable
symlink as evidence of a loaded Pi update. Do not auto-reload, clear a draft, or
resume browser control. The matching Herdr registry entry gets the exact retained `plugin_root` and
`manifest_path`, plus the prebuilt descriptor without its checkout build step.
Other plugins, their order, and the current enabled flag stay unchanged.
No running Herdr API or reload is called. Doctor distinguishes this persisted
next-launch selection from unknown running Herdr registration.

After installation, the retained bundle contains the same manager; no checkout
is needed for an update or rollback:

```bash
MANAGER="$INSTALL/releases/ARTIFACT_ID/terminal-browser/scripts/install.sh"
"$MANAGER" stage /absolute/path/update.tar.gz /absolute/path/manifest.json "$INSTALL"
"$MANAGER" activate "$INSTALL" NEW_ARTIFACT_ID
"$MANAGER" status "$INSTALL"
"$MANAGER" rollback "$INSTALL"
```

Use the archive's original filename from its outer manifest. Repeated staging
and activation are safe. Releases and scoped activation backups are retained;
there is no destructive cleanup. Rollback checks the selected paths and changes
only the integration's Pi source, Herdr registration fields and launch links, preserving unrelated later
settings edits. Changed selections or package order cause a safe refusal.
An interrupted activation or rollback retains an owner-only transaction. Inspect
`status`, then run the retained manager's `recover ROOT` explicitly. Recovery
refuses a live or unknown manager lock owner and changed integration selections.
It reverses an uncommitted operation, or confirms a completed selection, while
preserving later unrelated Pi settings and Herdr registry edits. Repeating
recovery is safe. Process interruption is tested with SIGKILL at every selection
write; power-loss durability is not claimed. No recovery starts or resumes a browser.
Upstream `upgrade` is disabled for this integration.

A running daemon and Pi extension retain their startup artifact, protocol and
process-start identity. Doctor is read-only and reports candidates, next-launch
selections and observed loaded identities separately. Unknown is not absent.
It does not scan page content, open/migrate the database, prepare graphics,
repair sockets, or run setup. Graphics stays unknown without visible terminal
evidence; an internal Chromium frame is not such evidence.

Replacing a daemon loses its open tabs and transient browser state. First get
its complete metadata-only session inventory, then obtain approval for that
exact process/build/session set:

```bash
terminal-browser daemon-status > /absolute/path/approved-daemon-status.json
terminal-browser shutdown --expect /absolute/path/approved-daemon-status.json
```

The daemon rechecks that exact state before shutdown and refuses a new-session
race. No command is replayed and no browser is automatically reopened. Legacy,
unresponsive or uncertain processes require separate inspection and explicit
recovery, not a guessed PID kill or socket deletion.

### Permanent research/browser separation

The local cutover uses only managed terminal-browser for browser control. The
Tauri workspace, browser daemon, egress service, qualification services, desktop
entries and their installation/rollback hooks are retired. Browser rollback
selects another retained **terminal-browser** release; it never reinstalls Tauri.
Do not restore a whole old Pi settings file to recover one integration.

Web search/read remains a separate service and Pi extension. The licensed source
closure in `scripts/retire-legacy/` retains the original authority, cache, content,
passage selection, SDK, audit and research schemas. Its provenance records the
original source hashes and the exact retained declarations. It contains no
browser routes, browser tools, backend selection or workspace launcher.

Build and test it independently on Linux x64 with Node 24 and pnpm 10.13.1:

```bash
pnpm --dir scripts/retire-legacy install --frozen-lockfile --ignore-workspace
pnpm --dir scripts/retire-legacy run test:run
node scripts/retire-legacy/build.mjs /absolute/new/research-output scripts/retire-legacy
```

The independent lock disables dependency lifecycle scripts. The test runner
checks the reviewed runtime manifest hash, all 70 research tests and strict
TypeScript checks. It never uses the historical checkout's dependency tree.
The `research-retention` CI job runs this same gate.

For deployment, verify every `manifest.json` file hash, then copy the complete
output to `~/.local/share/pi-web-research/releases/<manifest-sha256>/`. Do not
modify the versioned runtime files. Its extension needs the host Pi peer modules;
provide a `node_modules` link to the installed Pi host's dependency directory,
not a temporary build directory. Select that release's `webxd.mjs` in the
existing user `webxd.service`, retaining its Unix socket, working directory and
existing `WEBX_CACHE_DIR` and `WEBX_CONTENT_DIR`. Store these two environment
values in `~/.config/pi-web-research/service.env` with mode 0600. The Python
reader service, its mixed source tree and `.venv` must remain in place.
Select the release's `pi-web` launcher for research status, doctor and audit.
After the service restart and readiness, `pi-web doctor --json` must report
healthy authority, search and read capabilities.

Register the exact versioned `extension.mjs` in Pi's **extensions** array,
preserving the packages array and all other settings. Coordinate global writes
with any other maintenance session. Remove the former optional bridge file
`~/.local/share/pi-terminal-browser/pi-web-search-read/extension.mjs` only after
verifying its known ownership and replacement. This prevents duplicate research
registration. Overwriting the old bridge in place is insufficient: native ESM
imports can retain its old bytes across Pi reloads. At a settled, empty-draft
boundary, explicitly reload only the owning Pi session. Verify its loaded
research tools separately from its selected configuration. Never reload other
conversations or resume human browser control automatically.

`scripts/legacy-browser-cleanup.mjs` is the bounded local retirement tool. It
accepts a classified version-1 inventory with `candidateDeletions` records
(`path`, `inode`, `device`, `uid`, `type`, plus file `sha256` or `symlinkTarget`).
Default mode retires the fixed historical source/install roots. Inventory kind
`phase4a-runtime` removes only the fixed obsolete runtime selections after
research migration. Kind `tauri-dependencies` removes only the pinned dedicated
Tauri packages and hoisted links; first verify that retained package manifests
and reverse links have no dependency outside that deletion set.

```bash
node scripts/legacy-browser-cleanup.mjs plan --inventory /private/inventory.json --out /private/new-plan.json
node scripts/legacy-browser-cleanup.mjs apply --plan /private/new-plan.json --sha256 REVIEWED_PLAN_SHA256 --journal /private/new-journal.jsonl
```

Review the exact plan before apply. It checks all snapshots, Git changes, active
services/processes and symlink boundaries before mutation. Process inspection
can require noninteractive `sudo readlink` for protected process metadata; this
never runs the cleanup as root. It journals owner-write preparation of read-only
retired directories and every exact deletion. A failed partial plan must never
be replayed: inspect its journal and create a new plan for the verified remainder.
Original release manifests stay unchanged as historical provenance, not valid
installation manifests. Retirement markers describe the source-removal snapshot;
subsequent dependency deletion journals describe later changes to that snapshot.
Keep all journals outside the retired trees.

Preserve the shared reader/document runtime, cache/content stores, profiles,
user storage, media keys, HSTS data, downloads, modified reports and unrelated
packages. Do not delete the original repository, mixed `components/browser`,
shared `node_modules`, Python environments or system libraries wholesale.

### Build a local runtime artifact (Fedora x64)

Use the existing distribution build, after preparing the locked workspace dependencies:

```bash
TERMINAL_BROWSER_RELEASE_OUT=/var/tmp/terminal-browser-candidate pnpm build:dist
pnpm test:dist
```

Choose a fresh output directory for each candidate. The build does not replace
source `dist` directories, install packages into Pi or Herdr, run setup, or stop
running browsers. It stages the browser, CLI, N-API module, patched Electron,
AgentCursor code, legacy `agent-browser` CLI, assets, skills, license notices,
complete Pi extension package, and prebuilt Herdr plugin in
`<output>/<artifact-id>/terminal-browser/`. Host Pi, Herdr, Node (for Pi and the
Herdr action parser), and Fedora system libraries remain prerequisites; this is
not a bundled Pi or Herdr application. The optional Pi Web research provider is
not part of the browser artifact.

Electron stays at **43.3.0** and AgentCursor at commit
`b23c633c66fd240f836f5edd1034f6fcf678e237`. `upstreams.lock.json` pins the patched
Electron archive checksums and the legacy `agent-browser` v0.33.0 commit.
The release build downloads Electron into its own output and verifies its pinned
archive checksum. Native builds use locked Cargo inputs and separate target
outputs. To reuse build caches, set `TERMINAL_BROWSER_NATIVE_TARGET`,
`TERMINAL_BROWSER_AGENT_SOURCE` (a clean pinned checkout), and
`TERMINAL_BROWSER_AGENT_TARGET`; these must not be live runtime directories.

Each artifact has `build-manifest.json`: full source commit, dirty flag, exact
source-input digest, lockfile hashes, runtime and tool versions, integration
metadata, and all runtime file hashes/modes. A dirty candidate has a dirty-tree
suffix and is never presented as a clean commit build. The outer
`manifest-linux-x64.json` hashes both the archive and internal manifest. Verify
an extracted candidate before use:

```bash
node scripts/dist-manifest.mjs verify /path/to/extracted/terminal-browser /path/to/manifest-linux-x64.json
pnpm test:dist:smoke /path/to/extracted/terminal-browser
pnpm test:dist:recovery /path/to/release-output-A /path/to/release-output-B
```

The Linux x64 smoke and recovery tests use Bubblewrap with no checkout, real
home, development `node_modules`, display socket, or external network. Only the
loopback fixture is reachable. The smoke checks packaged launchers, native
SQLite/assets, and the actual packaged main daemon through private PTYs and the
CLI/companion sockets: local and delayed actions, cross-origin frame input and
capture, popup activation/input/capture, two owners, pause, and an exact-inventory
shutdown race. Internal captures are not visible terminal acceptance.
For CPU-sensitive startup failures, prefix the smoke command with `taskset -c`
and one available CPU number. Registration failures include the last bounded CLI
result or error. CI also runs the private-PTY Rust tests, including preservation
of a queued wake across the engine's nonblocking input probe.

Recovery takes two complete, separately sealed release output directories. It
stages and uses their packaged managers outside the checkout, checks interrupted
activation recovery, scoped rollback and retained state, then changes A → B → A
while the A daemon and a paused companion stay loaded. The new CLI must refuse
a mismatched mutation without replay. Pi's offline loader checks the old loaded
receipt versus the new selection, then explicit A → B → A lifecycle changes.
After an approved fixture shutdown, an explicit B launch checks that each owner
recovers only its own actual download history. These tests do not touch a real
Herdr API, visible pane, production installation, or production Pi session.

Both tests copy only the prepared Pi host dependency closure into the sandbox;
the default is workspace Pi 0.84.2. Set `TERMINAL_BROWSER_PI_ROOT` to test another
prepared compatible host, such as Pi 0.85.1. Missing host dependencies fail rather
than skip. The browser artifact still contains no Pi host or development modules.

Packaged Pi and Herdr entrypoints call their own artifact's `bin/terminal-browser`,
which establishes `TERMINAL_BROWSER_DIST_ROOT` and uses bundled Electron as the
CLI runtime. Pi's source build uses an explicit source launch mode; the release
build generates bundle mode. The packaged Herdr descriptor has no source build
step. No development symlink or runtime dependency installation is required.
The browser uses its own AgentCursor driver, not the optional OS-cursor driver.

Run installation regressions with `pnpm test:dist`. The Pi loader test uses the
same prepared host selection and checks both a fresh offline process and
A → B → A in the same SettingsManager/ResourceLoader without a global Pi install.

`pnpm test:dist:ci` builds two fresh complete releases outside the checkout and
runs the distribution, smoke and recovery gates without installation in the real
HOME. CI uses Ubuntu 24.04 x64, Node 24.18.0, pnpm 10.13.1, Rust 1.93.1, system
Python 3.12, Bubblewrap, and declared native libraries/tools. Cargo lockfiles and
upstream checksums remain enforced; actual host tool versions are logged and
recorded in each manifest. Existing workspace tests and all four native Electron
fixtures remain separate required integration gates. The upstream terminal-adapter
baseline remains non-blocking; it is not packaged runtime acceptance.

Tests must isolate HOME, all XDG directories, `TERMINAL_BROWSER_APPDATA`,
`TERMINAL_BROWSER_INTEROP_DIR`, and `PI_CODING_AGENT_DIR`, and remove inherited
Herdr/owner/production routes. Use a short private runtime path (for example,
`mktemp -d /tmp/XXXXXX`): Unix socket paths have a small fixed length limit. XDG
alone does not isolate global interop state.

### Usage
```
terminal-browser # launches the browser
terminal-browser open <url> # opens the browser at a url
terminal-browser --split right # opens the browser in a split pane to the right
terminal-browser open --ssh <user@host> <url> # performs all network requests through a remote server
terminal-browser ls # lists open browsers
terminal-browser action # an agent-browser compatible cli for interacting with open terminal-browsers
```




### Use cases:
- You can have a coding agent and website scoped to the same terminal tab
- Your agent has full access to interact with open terminal-browsers, which gives your agent the capability to use the web
- You can ask an agent to make HTML plans and then open them inside terminal-browser, which will automatically open in a split pane next to your agent
- terminal-browser works over SSH, which allows you to preview websites running on remote machines easily

### Shortcuts

| Action | macOS | Linux |
| --- | --- | --- |
| Quit | ctrl+q or ctrl+c | ctrl+q |
| New tab | cmd+t | ctrl+t |
| Edit URL | cmd+l | ctrl+l |
| Command palette | cmd+p | ctrl+k or alt+k |
| Find in page | cmd+shift+f | ctrl+shift+f |
| Next / previous match | enter / shift+enter | enter / shift+enter |
| Reload | cmd+r | ctrl+r |
| Back / forward | cmd+[ / cmd+] or ctrl+[ / ctrl+] | ctrl+[ / ctrl+] |
| Zoom in / out / reset | your terminal's zoom keybind | your terminal's zoom keybind |
| Devtools | cmd+shift+i or f12 | ctrl+shift+i or f12 |
| Devtools console | cmd+alt+j | ctrl+alt+j |
| Copy / paste / cut | cmd+c / cmd+v / cmd+x | ctrl+c / ctrl+v / ctrl+x |
| Record page (start/stop) | ctrl+r | ctrl+shift+r |
| Complete recording review | ctrl+enter | ctrl+enter |
| Start element selection (send to agent) | ctrl+g | ctrl+g |
| Close popup / overlay | escape | escape |



### How does it work?
Terminals that support the kitty graphics protocol, including ghostty, kitty, cmux, vscode and many more, allow a program running in a terminal to display pixels in your terminal. We use this capability to display pixels generated by chromium.

We use [electrons offscreen rendering API](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering) to read pixels generated by chromium directly from the GPU. This allows terminal-browser to render smoothly without dropping any frames.

After the browser engine starts and is displaying pixels in the terminal, it needs to be able to read user input for websites to actually work. terminal-browser listens to mouse clicks, mouse position, and keyboard events from the terminal, and then sends synthetic events to chromium based on that data. For any user input events that are not retrievable from the terminal, we read directly from the operating system using a background swift app to listen for input events (non intrusively). This is what allows terminal-browser to implement smooth scrolling, and listen to trackpad events (websites with infinite canvases work great inside terminal-browser!)

The outer UI of the browser is implemented using a graphics engine built on top of rust. The actual UI is defined inside react with a custom react renderer, which allows us to build the UI for the browser using typescript. The UI of the outer browser and the browser content itself is all drawn to the same shared canvas inside the rust engine, which allows us to layer UI on top of the browser.

### SSH
The recommended way to use terminal-browser over ssh is running `terminal-browser --ssh <ssh arguments>`.

The alternative is running terminal-browser directly on the machine you are shh'd into. This will work, but:
- requires every single frame drawn by the website to be sent over the network
- all user input must be sent over the network before a website can react
- misses out some [extra optimizations](https://sw.kovidgoyal.net/kitty/graphics-protocol/#local-client)

`terminal-browser --ssh` improves on this by running the website on your local device, and simply proxying all network requests made by the browser via the remote machine over ssh. This means you can load any website running on `localhost` of the remote machine on your local device.



### App Mode
terminal-browser can be used to build apps in the terminal using browser technology. You can reference `terminal-code` as a production usage example - https://github.com/zenbu-labs/terminal-code

This is accessible by using the `--app-mode` option when spawning terminal-browser, and optionally using the `preload` and `main-script` options that use electron's [preload scripts](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload) and main script under the hood. 

The following options are the full set of app related options available for `terminal-browser open`
```
  --preload=<path>      Run a script inside the context of a web page before it loads (uses electron's preload feature under the hood, runs in an isolated world).
                        terminal-browser specific api's are exposed on globalThis.terminalBrowser
                        {
                          theme: () => { background: [r,g,b], foreground: [r,g,b], ansi: ([r,g,b] | null)[] } | null, // null until the terminal reports its colors
                          onTheme: (cb: (theme: Theme) => void) => () => void, // returns unsubscribe
                          quit: () => void // closes this browser window
                        }
                        --terminal-browser-session=<key> is passed as extra arguments to the renderer process, available via process.argv
  --main-script=<path>  Run a node.js script in the same process as the browser (this is an electron main process)
  --open-tabs-in-popup-stack Links that would open a new tab open a popup over the
                        page instead.
  --allow-clipboard-read
                        Lets websites read from clipboard.
  --no-toolbar          No toolbar or tab strip
  --no-shortcuts        No browser shortcuts, keys go to the page
  --no-context-menu     No right-click menu
  --no-overlays         No toasts or HUDs drawn over the page
  --no-frame            No border or padding, the page fills the pane
  --app-mode            Shorthand for --no-toolbar --no-shortcuts
                        --no-context-menu --no-overlays --no-frame
                        --allow-clipboard-read --open-tabs-in-popup-stack
  --ssh-bundle <dir>    Install and execute a bundle on a remote server. This is useful when paired with
                        --app-mode and --ssh, allowing you to run an application server on a
                        remote machine, then view the output over ssh
  --ssh-bundle-dir <dir>
                        The path --ssh-bundle should be installed to through the ssh server. Defaults to
                        ${XDG_DATA_HOME:-~/.local/share}/terminal-browser/bundles

```

### Roadmap
- linux support ✅
- chrome extensions
- design mode

### Contributing

- PR **descriptions** must be authored by humans and explained well, otherwise we will close them
- When making a PR, the motivation must be clearly defined in the description
- Minimize the size of your PR for the best chance to get it landed

To get a local development setup of terminal-browser, the recommended way is to ask a coding agent.

### Adding enhanced support for a new terminal
`terminal-browser`'s cli includes sub commands that rely on terminal/multiplexer scripting features. 
To implement support for a terminal/multiplexer not yet supported, reference existing implementations
located here https://github.com/zenbu-labs/terminal-browser/tree/main/terminals/src/terminals

### [Discord](https://discord.gg/t3jzHHfc6z)

### Acknowledgments
- the [kitty](https://github.com/kovidgoyal/kitty) project for developing the kitty graphics protocol
- [awrit](https://github.com/chase/awrit) - the first attempt to embed chromium inside a terminal

### Native browser contexts and dialogs

The five Pi browser tools include native popup contexts. `browser_tabs` lists
stable `context_id` values, opener IDs, URLs, titles, and active state. Activate or
close a context by ID. Use `action: "wait"` with `after_context_id` from the last
list to wait for a new popup without holding the action queue. Native popups keep
`window.opener`, so OAuth-style `postMessage` and `window.close()` work.

`browser_observe` and interrupted actions return pending dialogs without running
page JavaScript. Use `browser_act` with `action: "dialog"`, the exact `dialog_id`,
an optional matching `context_id`, and explicit `accept`. Pi manages the control
epoch internally. Prompt responses can include `text`. Dialogs time out by dismissal
after 60 seconds; they never auto-accept.
Human users can use the terminal dialog card, Enter, or Escape. Switching context,
closing it, or releasing control invalidates previous observations and input.

Prompt uses a CDP debugger pause, not a network request. Its configurable accessor
ignores ordinary assignment because Electron initializes child-window prompt
after the first CDP injection. Messages and defaults are limited to 4096 characters;
response text is limited to 32768. Beforeunload cancels first and replays only a
known navigation, reload, history, or close request after explicit acceptance.
The canceled load must finish and the renderer must answer a round-trip before
replay. Unknown beforeunload requests can only be dismissed.

Run `pnpm --filter terminal-browser test:electron` for the pinned Electron native
fixtures. Linux requires an X11 display: the native Wayland dialog backend can
fail on hidden windows. The fixtures exercise the real controller and popup
runtime, opener communication, strict CSP prompts, native dialogs, stale replies,
timeouts, and beforeunload replay. The files fixture also runs a prompt → popup
return → project upload → tracked download sequence, including takeover cleanup
and two owners in the same project. The semantic fixture checks locator identity, focus, obstruction, scrolling and
cancellation using native input. CI runs these fixtures with `xvfb-run -a` on
Ubuntu; native failures fail the integration job, separate from the optional
pixel-terminals baseline. The terminal dialog card is build-checked but still
needs a visual check in a live terminal session.


### Semantic targets

The same five Pi tools accept native AgentCursor locator step arrays. Observe
first, then use exactly one `ref` or `locator` for click, type, upload or hover:

```json
{"action":"click","locator":[{"kind":"role","value":"button","name":"Save"}]}
```

Steps support `css`, `role` (optional `name` and `exact`), `label`, `text`,
`placeholder`, `testid`, `filter` (`hasText`), and `nth` (`index`, including negative
indexes). Query steps search within the preceding matches; open shadow roots are
included. Actions reject ambiguity and return up to eight candidate summaries.
Use a narrower scope or explicit `nth` selection. Arrays contain 1–16 steps;
query strings are limited to 1024 characters and each scope to 20000 elements.
Role/name matching uses DOM roles and accessible labels, not a complete browser
accessibility-tree query. Queries stay inside the selected frame; closed shadow roots are not included.

Drag uses `from_locator` / `to_locator`, or the existing ref/visual-coordinate
fields. `browser_observe.filter` narrows the element list without changing the
page-text option. `wait_for` accepts a locator and `exists`, `visible`, `text`, or
`actionable`; actionable checks stable, enabled, unobstructed pointer access.

Preparation waits for attachment, visibility, enablement, editability for typing,
and stable geometry. The actual pointer point is checked again after slow-natural
motion. A locator can resolve a replacement node only before button-down; a ref
never changes identity. Changed targets can cause bounded natural re-approach,
never an automatic retry of a dispatched click or edit. Focus is checked before
insertion. Cancellation/disconnect stops later input and releases held keys/buttons;
already dispatched side effects are not undone. Re-observe after an interrupted
action. DOM checks and native input delivery are not atomic.

CLI equivalents use `--locator-json '<steps>'`, `--from-locator-json`,
`--to-locator-json`, and observe `--filter-json`. Browser socket fields use
`locator`, `fromLocator`, `toLocator`, and `filter`. Existing ref commands remain
available. Observer execution stays injectable through `AgentPageObserver`; the
general root `runJs` path is unchanged.

### Frame selection

`browser_observe` returns up to 24 frame summaries (`ref`, `parent`, `name`, `url`,
`selected`) plus `frame` and `framesTruncated`. Select a listed friendly ref with
`{"frame":"f2"}`; use `{"frame":"main"}` to return to the main document. Omission
keeps the selection. Frame refs belong to their native context, including popups.
`browser_act.frame` can confirm the selected frame but cannot switch away from
its cached observation. Refs are scoped internally by context, frame, and document.
CLI observe uses `--frame f2` or `--frame main`.

Same-origin, cross-origin, and nested out-of-process frames support observe,
click, type, hover, wait, element capture, upload, and same-frame drag. Both drag
endpoints must belong to the selected frame. Native context navigation and URL
commands still apply to the context, not a selected child. Frame or ancestor
navigation, detach, and process swaps invalidate prior observations and release
input. Observe `main` after a selected frame disappears; there is no parent fallback.

Frame geometry uses parent-session DOM owners, content-box offsets, ancestor
clipping, and parent hit tests. Ancestor owners scroll before targets are measured
again. Element rectangles, captures, and activity use the containing root/popup
input surface. Page zoom is included; terminal display scale and device pixel ratio
are not substitutes for page zoom. Visual coordinates become stale when frame
geometry or scrolling changes. Frame-owner transforms, perspective, and CSS `zoom`
are rejected; ordinary axis-aligned owners and browser page zoom are supported.
Frame ancestry is limited to 32 levels and summaries to the first 24 live frames.

The pinned native frame fixture uses different local sites and asserts real
out-of-process sessions, nested same-origin/cross-origin frames, duplicate labels,
zoomed root/popup capture pixels, scrolling, upload, child prompts, drag delivery,
process swaps, detach, geometry rejection, and takeover without repeated effects.
It also delays owner lookup and session initialization to verify cancelled scrolling,
unrelated detach recovery, and exact-session key release. Element capture tests
include filtered noninteractive elements and refs excluded by the snapshot limit.
Electron offscreen out-of-process frames need exact-session CDP input, rather than
root `sendInputEvent`. HTML5 drag interception is on the root session; drag events
use the selected frame session. These routes stay inside the normal PageInput and
slow-natural driver, with input release and cancellation checks.

For a focused visible check, run `node browser/test/fixtures/dynamic-live.cjs`
from the checkout and open its printed loopback URL. Choose only the right card,
prepare and wait for the replaced delayed control, then select the `contact-form`
frame, fill `Contact name`, wait for `Submit embedded` to become actionable, and
capture its result. Each output counter must increase only once. Repeat the frame
step in its popup to check cursor alignment. The fixture uses only local data.

A rebuilt CLI does not replace an already-running Electron daemon. List affected
contexts before stopping the shared daemon, obtain permission for unsaved work,
and verify the old daemon exited before reopening companions. Record hashes of
the built browser files at startup and verify the new frame behavior in a fresh
Pi process; source HEAD or a new CLI PID alone is not deployment evidence.

### Agent cursor alignment

The terminal overlay uses terminal-root coordinates, including the page origin and
cursor hotspot. Edge graphics are clipped to the active surface. Popup activity
comes from the popup runtime and is drawn above its modal using the popup content
origin, including the header. Browser input coordinates are separate and unchanged.

Terminal resize recomputes the surface from the current engine dimensions and cell
size. The overlay uses that new layout and its scale on each render. Display scale
is selected at startup (explicit override, CSS-pixel terminal, or host display);
this does not detect a later move between monitors with different scale factors.
`browser/test/agent-overlay.test.js` checks component positions, clipping, resized
layouts, supplied scale changes, and popup layering. Context tests check activity
selection across popup motion, switching, and closure. A live terminal check is
still required to confirm visual alignment on a particular terminal backend.

### Project uploads and tracked downloads

Use `browser_act` with `action: "upload"`, a visible input/button `ref` from the
latest observation or a unique `locator`, and `files: ["relative/path.txt"]`. The normal slow-natural
AgentCursor click must open a native chooser in the selected frame.
Direct file inputs, button-triggered choosers, multiple files, popup contexts,
and same-origin/cross-origin frames are supported. Chooser events and backend nodes
are bound to that frame's session and document. The browser process independently
canonicalizes paths against the owning Pi project before the click and again
before assignment. Uploads accept 1–16 existing regular files, at most 32 MiB each
and 64 MiB total. Directories, special files, project escapes (including symlinks),
and conventional secret paths such as `.env`, `.ssh`, credentials and private-key
files are rejected. This is a path policy, not a file-content secret scanner.
The companion captures its canonical owning project root at launch. Changing the
Pi session or current directory does not change that root or pane ownership.
CLI relative upload paths resolve from its current directory; paths outside the
launch root fail with an instruction to reopen the companion. Close and reopen
(or restart) the companion to adopt another project. No upload contents are
logged or returned. Interception ends on success, failure,
15-second timeout, navigation, takeover, or context closure.

Use `browser_tabs` with `action: "downloads"` to list up to 64 retained transfers;
`context_id` optionally filters the owning context, including closed contexts.
`download_wait` and `download_cancel` take an exact `download_id`. Waits are
bounded by `timeout_ms` (0–60000), return the current state on timeout, run outside
the action queue, and fail on control takeover. Up to 32 transfers can be active.
One Electron-session dispatcher routes each download by its source WebContents,
not the first browser callback. Results include the captured `projectRoot`, state, byte progress, and a
project-relative `savePath` under `.terminal-browser-downloads/item-*/`. Each
transfer gets a private unique directory and a sanitized filename. Existing files
are not overwritten. Files are never auto-opened or executed. Failed path setup
has an empty save path. Closing a context or browser interrupts active transfers.
History survives CLI/Pi client reconnects and browser restart/reboot recovery:
up to 64 validated records with stable download IDs are stored in the owning
project's `.terminal-browser-downloads/history-<sha256>.json` using atomic private
(mode `0600`) writes. The filename hashes the full owning workspace/tab/pane tuple:
separate owners in the same project cannot access each other's history through
browser tools; restarting the same owner restores its history. Starts and terminal states are flushed immediately;
progress is flushed at most once per second. On restart, unfinished transfers
become `interrupted`; terminal records remain available to list and wait, but
transfers are not resumed. Malformed or unsafe metadata is ignored without
returning its contents. Tests cover graceful restart and abrupt process death
(the reboot recovery path). Unowned browser instances reject transfers.
A download-link click can report page-state invalidation before the transfer
appears; use the download list to check the actual transfer state.

CLI equivalents are `agent upload <ref> --files-json '["relative/path.txt"]'
--observation <id> --control-epoch <n>` and `companion tabs --action
downloads|download_wait|download_cancel` (wait/cancel require `--download-id`).
Pi supplies observations, epochs, and exact companion routing internally; there
are still exactly five browser tools. The pinned `test:electron` command above
also verifies direct/button/popup uploads, takeover cleanup and reuse, concurrent
owner-scoped downloads, cancellation, network interruption, and context closure.
