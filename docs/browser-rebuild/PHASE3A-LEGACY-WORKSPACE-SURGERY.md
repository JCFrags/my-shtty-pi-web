# Phase 3A legacy workspace surgery

## Baseline

- Requested Phase 3A baseline: `d6e42db04a3f0b0227c2211093cfcbdac76847d4`
- Preserved pre-existing service correction: `37a0c4b2008479b62cbdb8a8f3095347d41f79dc`
- Working Phase 3A base approved by the user: `37a0c4b2008479b62cbdb8a8f3095347d41f79dc`

The implementation below `components/browser/apps/workspace/` is replaced rather than adapted. Its frontend directly requested a browserd descriptor, exposed workspace authority to JavaScript, used HTTP and WebSocket workspace endpoints, transferred image bytes as base64, implemented viewport leases and exact screenshot-SHA input guards, and exposed human input, takeover, cancellation, and legacy fixture state. Those concepts are incompatible with the Phase 3A read-only trust boundary.

## Files removed

The following legacy implementation files are deleted rather than wrapped:

- `components/browser/apps/workspace/src/lib/rpc.ts`
- `components/browser/apps/workspace/src/fixtures.ts`
- `components/browser/apps/workspace/src/model.ts`
- `components/browser/apps/workspace/src/components/Viewport.tsx`
- `components/browser/apps/workspace/test/model.test.mjs`
- `components/browser/apps/workspace/test/contract.test.mjs`

The old contents of these files are also removed or replaced completely:

- `components/browser/apps/workspace/src/App.tsx`
- `components/browser/apps/workspace/src/styles.css`
- `components/browser/apps/workspace/src-tauri/src/lib.rs`
- `components/browser/apps/workspace/src-tauri/capabilities/default.json`
- `components/browser/apps/workspace/src-tauri/tauri.conf.json`
- `components/browser/apps/workspace/package.json`
- `components/browser/apps/workspace/src-tauri/Cargo.toml`

Removed concepts include `WorkspaceRpc`, `browserd_descriptor`, `workspaceToken`, browserd descriptor fields in JavaScript, frontend `fetch`, frontend `WebSocket`, synthetic interval events, legacy scope IDs, viewport leases, screenshot-SHA human-input guards, direct input handlers, takeover and return controls, operation cancellation, base64 frame payloads, the old fixture query mode, `agent-browser/chrome`, and the old workspace protocol dependency.

## Assets and configuration retained

The following stable shell and product assets remain where useful:

- application path and package identity `components/browser/apps/workspace/` / `@pi-web/workspace`;
- Tauri desktop shell and `src-tauri/src/main.rs` entry point;
- single-instance product behavior, reimplemented with bounded fixed actions;
- React/Vite application entry files `index.html` and `src/main.tsx`;
- application icons under `src-tauri/icons/`;
- product name and application identifier;
- canvas-based screenshot presentation as a concept, with a new bounded binary renderer.

## Replacement boundary

The replacement path is:

```text
React frontend
  -> narrow Tauri command/channel API
  -> Rust workspace client
  -> private authenticated webxd workspace Unix socket
  -> webxd workspace gateway
  -> browserd workspace-broker role
  -> BrowserRuntime frame scheduler
```

JavaScript receives only sanitized workspace state, frame metadata, and binary frame bytes. It receives no descriptor, binding secret, socket path, browserd endpoint, Chrome profile, CDP identity, proxy configuration, or raw actor credentials. Phase 3A remains read-only and contains no browser input, takeover, mutation, or model-facing workspace tool.
