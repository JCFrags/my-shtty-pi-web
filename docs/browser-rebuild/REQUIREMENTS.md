# Browser rebuild requirements

## Initial release acceptance criteria

| ID | Criterion | Acceptance test |
|---|---|---|
| BR-01 | Each active Pi agent can own an isolated browser session. | Bind two connections to different principal and Pi agent-session pairs. Confirm each gets a different process, temporary profile, CDP endpoint, browser session, and target. |
| BR-02 | Agents can act concurrently without cross-session effects. | Run interleaved and concurrent clicks and typing. Confirm each fixture state contains only its owner’s values. Reject a valid target used with the wrong owner. |
| BR-03 | A desktop workspace can list and switch between agent sessions. | The workspace lists both owners, selects either explicit session, shows its latest frame and status, and does not change control ownership when selection changes. |
| BR-04 | Perception is screenshot-first. | The primary observe result contains an image and frame metadata. DOM or accessibility data appears only after an explicit fallback request. |
| BR-05 | Every agent visual observation has binding metadata. | Return an observation ID, connection-bound actor, browser session, tab/target, URL, title, wall and monotonic capture time, CSS viewport, device-pixel ratio, scroll offset, media type, bounded inline bytes or controlled artifact, SHA-256, document generation, viewport generation, and increasing frame sequence. Do not retain a duplicate full image in metadata. |
| BR-06 | Coordinate input is observation-bound and revalidated. | Reject a coordinate action when its observation is missing, too old, foreign, for another target, from another document or viewport generation, at a changed scale or scroll position, or outside the viewport. Repeat these checks immediately before press, drag press, or wheel dispatch. |
| BR-07 | The virtual mouse behaves as one persistent person per browser session. | Preserve one position, persona, path sequence, and input lane across tabs in the same browser session. Serialize cross-tab pointer work in that session. Let different browser sessions act concurrently. Do not teleport. |
| BR-08 | The virtual mouse is visible. | Inject a pointer-events-none overlay. Confirm it appears in captured screenshots and moves along the input path. |
| BR-09 | Keyboard and browser controls use explicit targets. | Support text input, key press, navigation, screenshot, tab create/list/focus/close, and cancellation under the connection-bound actor with an explicit browser session and tab/target. |
| BR-10 | The browser is real and headed. | Launch supported Google Chrome or Chromium without headless mode. Use one private isolated profile and one Chrome process per browser session. Never use the normal user profile. |
| BR-11 | The runtime is persistent. | After session creation, execute warm observations and actions without starting Node, MCP, CLI, or browser processes. |
| BR-12 | The Pi interface is native. | Register browser tools from `apps/pi-webx` and call the local authority through the SDK. Do not add MCP to the request path. |
| BR-13 | Identity is explicit. | No browser operation can resolve authority from the active OS window, active Chrome tab, workspace selection, or last caller. |
| BR-14 | DOM fallback is bounded and document-scoped. | An explicit fallback returns role, accessible name, value/state, bounds when available, and a generation-scoped handle or locator description. Navigation makes old handles stale. |
| BR-15 | The workspace is a viewer, not a remote web embed. | Tauri renders local application UI and screenshot frames. It does not embed arbitrary remote websites. No control token appears in a URL. |
| BR-16 | Lifecycle failure is visible and contained. | Detect Chrome startup failure, browser exit, CDP disconnect, target close, and target crash. Stop affected work without fallback. Keep actor-scoped operation status and cancel available after the tab or browser fails. |
| BR-17 | Cleanup is reliable. | Normal close, cancellation, process exit, and failed startup close Chrome, disconnect CDP, and remove only the owned temporary profile. |
| BR-18 | Security controls remain enabled. | Keep the Chrome sandbox, web security, certificate validation, and site isolation enabled. Use a separate `browserd` Unix service with a `0700` runtime directory, `0600` descriptor and socket, a per-start secret, one-time connection binding, and bounded frames. |
| BR-19 | Deployment is configurable and diagnosed. | Prefer Google Chrome when installed. Permit a configured Chromium executable. Report executable and version. Fedora installation checks display session, binary, writable private directories, and runtime socket permissions. |
| BR-20 | Performance is measured. | Run a genuine 30-minute two-browser soak. Report startup, screenshot, CDP round trip, path, frame publication, event-loop, CPU, process count, profile disk, artifact and operation bounds, and memory slopes. Use Linux process-tree PSS as the primary memory metric. |
| BR-21 | Actor identity is connection-bound. | Bind once with the protocol version and per-start secret. Reject rebind. Confirm ordinary request schemas have no principal or agent-session selector and foreign ownership returns the same not-found shape. |
| BR-22 | Agent observations and workspace frames are separate bounded products. | Create observations only on explicit requests. Run idle, selected, and active-burst frame scheduling with one capture in flight and latest-frame backpressure. Confirm frames do not create observation records. |
| BR-23 | Production navigation fails closed. | Start the runtime without `NavigationAuthorization` and reject navigation. Permit only deterministic loopback fixture URLs in live tests. |
| BR-24 | Browser failures cannot disable search and read. | Run `browserd` as a separate process from `webxd`. Kill Chrome and `browserd` while independent search/read service tests remain healthy. |

## Phase 2A route acceptance criteria

| ID | Criterion | Acceptance test |
|---|---|---|
| BR-25 | Trusted webxd is the only production browserd client. | Verify descriptor modes and process identity. Bind one persistent browserd connection per authenticated actor. Confirm Pi receives no descriptor, secret, socket, profile, proxy, or CDP value. |
| BR-26 | Backend selection is immutable and reversible. | Start webxd in `legacy` and `agentcursor` modes. Confirm the default is `legacy`, each mode reports only its own path, and no request can select, fall back, or retry on the other backend. |
| BR-27 | The public browser contract is coherently versioned. | Confirm WebX API and browser protocol major 3 across SDK, webxd, Pi schemas, tests, and guidance. Confirm the new path is exactly `agentcursor/chrome`. |
| BR-28 | Pi receives a real screenshot image. | Run native `browser_observe`. Confirm one bounded text item and one real PNG or JPEG image item. Verify bytes, size, digest, and media type. Confirm no base64 in text or compact details. |
| BR-29 | Image coordinates work at non-1 DPR. | Capture at DPR 2, point at image pixel `[380,252]`, convert from exact `760x520` image and `380x260` CSS dimensions, and click CSS `[190,126]`. Cover DPR 1, 1.25, 2, fractional viewport, bounds, stale observation, and drag. |
| BR-30 | Public egress is fail closed. | Require a healthy structured loopback proxy before session creation. Deny local, private, reserved, and mixed DNS destinations. Keep redirects, clicks, forms, scripts, and popups on the validated proxy path. |
| BR-31 | Browserd replacement is truthful. | Restart browserd. Reject every old session without recreation or remapping. Reconnect only for new work. Confirm search and read remain healthy while browserd is absent. |
| BR-32 | The complete native route is isolated and bounded. | Run two Pi actors through SDK, webxd, browserd, and headed Chromium. Confirm distinct processes, profiles, sessions, personas, and tabs; explicit DOM fallback; tabs; cancellation; retry truth; no warm process spawn; and complete cleanup. |
| BR-33 | The actual routed workload passes for 30 minutes. | Run two actors through repeated screenshot, image action, DOM fallback, tab, retry, pool eviction, artifact, search, and read work. Record separate Chrome process-tree PSS/private dirty, route latency, combined test-process heap, counts, profile bytes, and cleanup. Do not claim this resolves ADR-012. |

## Phase 1 delivery boundary

Phase 1 implements BR-01, BR-02, BR-04 through BR-11, BR-13, BR-14, BR-16 through BR-23 in the parallel runtime. Phase 2A adds BR-12, BR-24, and BR-25 through BR-33 behind the non-default reversible startup switch. BR-03 and BR-15 remain Phase 3 Tauri workspace gates.

## Required pointer operations

The first release supports move, hover, click, double-click, drag, vertical and horizontal wheel, persistent cursor state, text input, key press, navigation, and screenshot through the page-targeted CDP driver. The cursor is a visible page virtual mouse. The product must not describe it as the Linux OS cursor.

## Later optional Linux OS-level mouse support

These items are not gates for the first release:

- A Linux input driver that sends real trusted desktop events.
- Wayland compositor or portal integration for pointer control.
- X11 XTest integration.
- Exact browser-content to global-screen coordinate mapping across multiple monitors.
- Fractional-scale correction for an OS pointer.
- Automatic foreground-window control and safe user handoff for OS input.

Any OS driver must implement the same target-aware action contract. It must require explicit user enablement. It must not silently replace CDP input.

## Explicit non-goals

- AgentCursor MCP in the production path.
- AgentCursor’s stock active-tab extension architecture.
- A process or CLI invocation for each action.
- Browser control through whichever tab or window is active.
- Use of the user’s normal Chrome profile.
- Broad sandbox, site-isolation, certificate, or web-security disablement.
- Hidden failover from one owner’s browser to another.
- Claiming bot-detection immunity or fully trusted events from CDP.
- Embedding arbitrary remote pages in Tauri.
- Browser file upload or download in the initial release.
- Polishing or preserving the current browser stack because it exists.
- Replacing general search and direct read with browser automation.
