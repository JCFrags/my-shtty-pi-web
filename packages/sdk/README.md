# WebX SDK

The SDK provides strict API-major-3 types and one stable client for the local WebX API.

It includes:

- API-major negotiation;
- bounded responses and cancellation;
- required mutation idempotency;
- search, bounded read, ordered batch read for 1 to 5 direct-read items, exact or focused stored-content retrieval, and guarded one-page Markdown export;
- internal artifact transfer support for bounded component results;
- explicit browser session and tab create, list, get, observe, frame, act, cancel, close-tab, and close-session operations;
- the new `agentcursor/chrome` path and the temporary legacy `agent-browser/chrome` rollback path;
- a real Node Unix NDJSON connector;
- an exact singular-facade operation adapter and inventory.

The public versions are `WEBX_API_VERSION = 3.0.0`, `WEBX_API_MAJOR = 3`, and `BROWSER_PROTOCOL_VERSION = 3.0.0`. The private browserd wire protocol has its own `browser.v1` version.

The facade can save one extracted read below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports`. It uses private directories and files, protects existing destinations by default, and returns compact metadata instead of the body.

The browser contract exposes explicit session and tab identities. A screenshot observation contains the real browserd observation ID, document and viewport generations, CSS and image dimensions, DPR, scroll, digest, media type, cursor, and validity. Coordinate actions cite that observation and use `imagePixels` or `cssViewport`. Explicit DOM fallback returns bounded opaque document-scoped handles.

The facade verifies the complete browser image and moves it through `artifactPayload`. Pi presentation emits one bounded text item and one actual image item. Image base64 does not appear in model text or compact details.

Capabilities come from the backend that webxd selected at startup. `agentcursor/chrome` does not advertise workspace, safe debug, control, upload, or download operations. The SDK has no per-request backend selector and no silent fallback.

`FACADE_OPERATION_INVENTORY` states each facade mapping and each explicit gap. Discard and restore remain unavailable because Pi has no safe equivalent in this product.
