# ADR 0004: Stream browser frames into one workspace shell

- Status: accepted
- Date: 2026-07-27

## Context

Opening normal Chrome windows per agent fragments the experience and cannot present one coherent agent/session tree. Loading target websites inside Tauri WebKit would create a second browser environment and break Chromium profiles, extensions, and CDP semantics.

## Decision

Run one single-instance Tauri workspace. Render the selected agent-browser JPEG viewport stream into a canvas and send mouse, keyboard, and touch input back over its WebSocket protocol. Tauri provides navigation, tabs, ownership, activity, downloads, and debug panels; Chromium or Lightpanda remains the website runtime.

## Consequences

Workspace restarts do not restart browsers. Background streams are subscribed only when visible. Extension or browser-native UI that cannot appear in the page stream may use an optional headed full-window/Xpra compatibility mode after the extension feasibility spike; this is not mandatory architecture.
