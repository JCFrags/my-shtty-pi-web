# AgentCursor assessment

## Source reviewed

- Repository: <https://github.com/kumard3/agentcursor>
- Version: `0.3.0`
- Pinned commit: `b23c633c66fd240f836f5edd1034f6fcf678e237`
- License: MIT, copyright 2026 Deepanshu Kumar
- Phase 0 attribution and license: `spikes/screenshot-first-browser/third_party/agentcursor/`
- Phase 1 production attribution: `packages/browser-runtime/third_party/agentcursor/`
- Phase 1 port: `packages/browser-runtime/src/vendor/agentcursor/`

The production runtime selectively ports source from `src/path-engine/*` and `src/persona/*`. Imports and reduced local protocol types were adapted for this repository. `UPSTREAM.md` records exact source paths and changes. No AgentCursor package is installed. No AgentCursor MCP or extension code runs.

## Reusable parts

### Reuse now

- `src/path-engine/index.ts`: sampled move generation, long-move overshoot and correction, curved approach, jitter, off-center point selection, dwell, and press timing.
- `src/path-engine/geometry.ts`: distance, clamp, cubic Bézier, and easing helpers.
- `src/path-engine/profile.ts`: Fitts-law duration and sample-count policy.
- `src/path-engine/rng.ts`: seeded random generator used for deterministic personas and tests.
- `src/persona/index.ts`: one stable speed, curvature, jitter, overshoot, precision, dwell, press, typing, reaction, and handedness profile per session.
- `src/persona/typing.ts`: human-timed typing schedule with corrected mistakes.

These modules are small, transport-independent, tested, and directly support the product requirement.

### Reuse as a design, then adapt

- `src/drivers/driver.ts`: the `BrowserDriver` boundary is correct. The production interface must add explicit owner/browser/tab/target identity, observation binding, document and viewport generations, control epoch, operation ID, deadline, cancellation, and lifecycle status.
- `src/action/service.ts`: the separation between target resolution, persona/path generation, and low-level delivery is useful. The stock service caches a page snapshot and cursor in ways that assume one current page. Production should adapt the action orchestration so each operation is addressed to one registered target and coordinate actions always cite an observation.
- Action timing and target-width concepts can be retained. Active-tab resolution and implicit snapshot refresh cannot.

## Parts not to reuse

- `src/server/*` and all MCP stdio startup.
- AgentCursor’s WebSocket extension bridge.
- `src/drivers/extension-driver.ts` because it resolves a normal user tab through extension state and supports active-tab fallbacks.
- The stock Chrome extension and `chrome.debugger` path.
- The SDK lifecycle that attaches to a browser already using a normal profile.
- The macOS OS-cursor driver and optional `@nut-tree-fork/nut-js` dependency.
- Locator behavior that makes DOM inspection the normal first step.
- Any fallback from focused window to another active or HTTP tab.

The product needs an isolated Chrome host created by our runtime. Raw CDP already supplies page input, screenshots, accessibility, target discovery, and lifecycle events. Phase 0 found no capability that requires the extension.

## Option evaluation

### 1. Stock AgentCursor SDK plus extension

**Benefits**

- Lowest initial path-engine integration work.
- Existing content overlay, locators, action service, and Chrome debugger delivery.
- Existing programmatic facade.

**Conflicts**

- The SDK attaches to a running Chrome with the extension loaded. Launch support is not its current lifecycle.
- The extension architecture uses active-tab discovery and can fall back to a tab in another window. This violates explicit target authority.
- It is designed to work with a real user profile. This conflicts with one disposable profile per agent.
- It adds an extension bridge and another reconnecting transport where raw CDP is sufficient.
- Its documented normal flow begins with page/DOM reading rather than screenshot-first perception.
- Stable Chrome extension-loading behavior creates packaging and policy risk.

**Decision:** reject for production.

### 2. AgentCursor core plus custom CDP BrowserDriver

**Benefits**

- Reuses the strongest and smallest MIT modules.
- Keeps one persistent runtime and direct explicit CDP sessions.
- Allows screenshot observations, accessibility fallback, overlay, lifecycle, cancellation, and ownership to use one authority model.
- Avoids MCP and extension packaging.
- Keeps a future OS-input driver possible behind one explicit interface.

**Costs**

- We own CDP target mapping and overlay reliability.
- Stock `ActionService` needs adaptation rather than blind import.
- We must maintain tests against Chrome changes.

**Phase 0 and Phase 1 evidence:** two headed Chromium processes used separate profiles and endpoints. A custom CDP driver performed concurrent sampled cursor paths, visible overlay updates, clicks, typing, screenshots, navigation, keys, wheel, drag support, and explicit accessibility fallback. Cross-session target use was rejected. No warm action launched a process.

**Decision:** preferred.

### 3. Fully custom implementation

**Benefits**

- No upstream coupling.
- Exact local APIs and smaller initial source set are possible.

**Costs**

- Recreates tested human-path and persona behavior without product benefit.
- Requires new tuning and provenance for behavioral models.
- Increases risk of simplistic teleporting or uniform movement.

**Decision:** do not choose while the small MIT core remains suitable.

## Source management recommendation

Use a **selective vendored port** pinned to the reviewed commit, not an npm dependency, Git dependency, or full fork.

Reasons:

- The published package includes MCP, extension, WebSocket, validation, and optional native-driver concerns that this runtime must not load.
- A selective port keeps production dependency and startup surfaces small.
- We need local type and interface changes for explicit target identity and cancellation.
- The MIT license permits the port when notice is retained.

Keep an `UPSTREAM.md` or the existing `third_party/agentcursor/README.md` with repository URL, exact commit, source paths, local changes, and update procedure. Keep the MIT license beside the port. Review upstream changes manually. Do not update from a floating branch or semver range.

A fork is justified only if local changes become large enough to benefit AgentCursor upstream. An exact Git dependency is not recommended because it still imports package-level code and complicates builds. A full vendored tree is unnecessary.

## Phase 2A integration evidence

The selected AgentCursor path and persona port now runs behind the truthful public path `agentcursor/chrome`. Trusted webxd connects to the separate long-lived browserd process. The native Pi extension does not connect to AgentCursor, MCP, Chrome, or CDP directly.

The full headed route proves:

- one stable persona and visible sampled virtual cursor per browser session;
- real screenshot delivery to Pi as a multimodal image;
- image-pixel grounding with conversion inside browserd;
- screenshot move, click, double-click, drag, and wheel through the human motor;
- explicit DOM pointer actions through the same motor;
- no Node, MCP, CLI, or browser process launch for warm actions;
- two isolated actors with separate Chrome processes, profiles, sessions, personas, and tabs.

The integration still does not import or install the AgentCursor package. It does not use AgentCursor server, MCP, extension, transport, macOS driver, active-tab lookup, or selector-first action service.

## Extension decision

Do not use the AgentCursor extension in Phase 2A. Reconsider only after a deterministic fixture reproduces a required capability that CDP cannot implement cleanly. The decision must name that capability and compare an extension with a smaller CDP or preload-script solution. Current evidence does not show such a gap.
