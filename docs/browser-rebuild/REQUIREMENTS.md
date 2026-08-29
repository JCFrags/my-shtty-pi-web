# Browser rebuild requirements

## Initial release acceptance criteria

| ID | Criterion | Acceptance test |
|---|---|---|
| BR-01 | Each active Pi agent can own an isolated browser session. | Create two agent owners. Confirm each receives a different browser host ID, process ID, profile directory, debugging endpoint, session ID, and target ID. |
| BR-02 | Agents can act concurrently without cross-session effects. | Run interleaved and concurrent clicks and typing. Confirm each fixture state contains only its owner’s values. Reject a valid target used with the wrong owner. |
| BR-03 | A desktop workspace can list and switch between agent sessions. | The workspace lists both owners, selects either explicit session, shows its latest frame and status, and does not change control ownership when selection changes. |
| BR-04 | Perception is screenshot-first. | The primary observe result contains an image and frame metadata. DOM or accessibility data appears only after an explicit fallback request. |
| BR-05 | Every visual observation has binding metadata. | Return an observation ID, owner, browser session, tab/target, URL, title, capture time, CSS viewport, device-pixel ratio, scroll offset, media type, bytes or controlled artifact, SHA-256, document generation, viewport generation, and increasing frame sequence. |
| BR-06 | Coordinate input is observation-bound. | Reject a coordinate action when its observation is missing, too old, owned by another session, for another target, from another document or viewport generation, at a changed scale/scroll position, or outside the viewport. |
| BR-07 | The virtual mouse behaves as one persistent person per session. | Preserve position and one seeded persona across move, hover, click, double-click, drag, and wheel actions. Record multiple timed path samples. Do not teleport. |
| BR-08 | The virtual mouse is visible. | Inject a pointer-events-none overlay. Confirm it appears in captured screenshots and moves along the input path. |
| BR-09 | Keyboard and browser controls use explicit targets. | Support text input, key press, navigation, screenshot, tab create/list/focus/close, and cancellation with an explicit owner, browser session, and tab/target. |
| BR-10 | The browser is real and headed. | Launch supported Google Chrome or Chromium without headless mode. Use one private isolated profile and one Chrome process per agent session. Never use the normal user profile. |
| BR-11 | The runtime is persistent. | After session creation, execute warm observations and actions without starting Node, MCP, CLI, or browser processes. |
| BR-12 | The Pi interface is native. | Register browser tools from `apps/pi-webx` and call the local authority through the SDK. Do not add MCP to the request path. |
| BR-13 | Identity is explicit. | No browser operation can resolve authority from the active OS window, active Chrome tab, workspace selection, or last caller. |
| BR-14 | DOM fallback is bounded and document-scoped. | An explicit fallback returns role, accessible name, value/state, bounds when available, and a generation-scoped handle or locator description. Navigation makes old handles stale. |
| BR-15 | The workspace is a viewer, not a remote web embed. | Tauri renders local application UI and screenshot frames. It does not embed arbitrary remote websites. No control token appears in a URL. |
| BR-16 | Lifecycle failure is visible and contained. | Detect Chrome startup failure, browser exit, CDP disconnect, target close, and navigation replacement. Stop affected operations. Do not fall back to another agent’s browser. |
| BR-17 | Cleanup is reliable. | Normal close, cancellation, process exit, and failed startup close Chrome, disconnect CDP, and remove only the owned temporary profile. |
| BR-18 | Security controls remain enabled. | Keep the Chrome sandbox, web security, certificate validation, and site isolation enabled. Bind CDP to loopback and protect the production authority with same-user local transport. |
| BR-19 | Deployment is configurable and diagnosed. | Prefer Google Chrome when installed. Permit a configured Chromium executable. Report executable and version. Fedora installation checks display session, binary, writable private directories, and runtime socket permissions. |
| BR-20 | Performance is measured. | Report startup, warm screenshot, warm CDP round trip, intentional path duration, post-path click completion, frame update latency, CPU, and memory for two browsers at the chosen frame rate. |

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
