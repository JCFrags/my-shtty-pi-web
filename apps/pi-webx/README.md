# Pi WebX

This Pi package is the singular model-facing facade for WebX web and browser capabilities.

It registers one extension entrypoint and one WebX skill. The facade calls only the injected WebX SDK. It does not call providers, browser services, the network, or subprocesses.

## Stable interface

Tools: `web_upgrade`, `web_search`, `web_research`, `web_recall`, `web_recall_get`, `web_recall_forget`, `web_read`, `browser_open`, `browser_tabs`, `browser_observe`, `browser_act`, `browser_debug`, and `artifact_read`.

Commands: `/web` and `/browser`.

Shortcut: `ctrl+alt+g`.

The default mode is `read`. `/web off` cannot be overridden by `web_upgrade`. Browser capability activation is additive and keeps tools from other extensions active.

## Integration seam

`src/sdk.ts` defines the typed SDK seam. The default client binds the vendored WebX SDK facade to the same-user Webxd Unix socket. Tests can inject a controlled SDK through `createPiWebxExtension()`.

The facade rejects an API major mismatch, a daemon outage, an untrusted project, and any browser capability list other than `agent-browser/chrome` and `pinchtab/chrome`. It never starts a daemon or falls back to direct access.

## Qualification wiring

The package archive includes `pi-webx-qualification`. This NDJSON executable runs the shipped `WebxFacadeClient` over its Unix SDK transport into deterministic Webxd and Browserd contract fixtures. It checks harness wiring, package identity, refusal behavior, lifecycle, and cleanup. It sets `shippedEntrypoint: false`. It is not product acceptance evidence because it does not connect to the actual shipped Webxd process, frozen Browserd process, Chromium engines, or the two real adapters.

The retained PNG is the imported public workspace fixture with SHA-256 `54901651bfc44362bac3f289b2c7499ff974f467dbb9b237a2ea39e47105e715`. It is not a fresh actual-engine capture. The executable does not register the package or issue reload.

The mock under `packages/test-fixtures/complete` is also wiring-only. Neither fixture can pass the shipped-entrypoint gate.

## Checks

```bash
npm run check
```
