# WebX SDK

The SDK provides strict types and one stable client for the local WebX API.

It includes:

- API-major negotiation;
- bounded responses and cancellation;
- required mutation idempotency;
- search, read, and guarded one-page Markdown export;
- internal artifact transfer support for bounded component results;
- browser create, list, get, observe, frame, act, safe debug, workspace, control, cancel, close-tab, and close-session;
- exactly `agent-browser/chrome` and `pinchtab/chrome`;
- a real Node Unix NDJSON connector;
- an exact singular-facade operation adapter and inventory.

The facade can save one extracted read below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports`. It uses private directories and files, protects existing destinations by default, and returns compact metadata instead of the body.

`FACADE_OPERATION_INVENTORY` states each facade mapping and each explicit gap. Visual observe captures a frame and returns an owner/session-scoped `observationId` and `viewportId`. A later visual action consumes that binding and creates the exact SDK visual guard. Browser workspace show, hide, list, attach, takeover, and return are mapped. Browser tab close works. Discard and restore remain unavailable because Pi 0.84.1 has no safe equivalent in this product. There is no silent fallback.
