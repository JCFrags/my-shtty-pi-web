# Pi WebX

This Pi package is the singular model-facing facade for WebX web and browser capabilities.

It registers one extension entrypoint and one WebX skill. The facade calls only the injected WebX SDK. It does not call providers, browser services, the network, or subprocesses.

## Stable interface

Tools: `web_upgrade`, `web_search`, `web_research`, `web_recall`, `web_recall_get`, `web_recall_forget`, `web_read`, `browser_open`, `browser_tabs`, `browser_observe`, `browser_act`, `browser_debug`, and `artifact_read`.

Commands: `/web` and `/browser`.

Shortcut: `ctrl+alt+g`.

The default mode is `read`. `/web off` cannot be overridden by `web_upgrade`. Browser capability activation is additive and keeps tools from other extensions active.

## Integration seam

`src/sdk.ts` defines the temporary typed SDK seam. The default client fails closed until the integration owner binds the generated SDK. Tests inject a mock SDK through `createPiWebxExtension()`.

The facade rejects an API major mismatch, a daemon outage, an untrusted project, and any browser capability list other than `agent-browser/chrome` and `pinchtab/chrome`. It never starts a daemon or falls back to direct access.

## Checks

```bash
npm run check
```
