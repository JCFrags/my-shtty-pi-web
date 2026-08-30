# ADR-013: Public screenshot-first browser contract

Status: accepted and corrected by Phase 2B; capture delivery qualified by Phase 2B.1

## Context

The old public browser contract used semantic and workspace concepts from the legacy browser stack. The replacement runtime uses explicit browser sessions, tabs, screenshot observations, and bounded DOM fallback. The two contracts are not shape-compatible.

The model must point into the exact image that it received. Image pixels can differ from CSS viewport pixels. The public response must also deliver the image as a Pi multimodal image item. It must not place image base64 in model text or compact details.

## Decision

Phase 2A uses these public versions:

- `WEBX_API_VERSION = 3.0.0`
- `WEBX_API_MAJOR = 3`
- `BROWSER_PROTOCOL_VERSION = 3.0.0`

The private browserd wire protocol remains `browser.v1`. It is a separate internal contract.

The new truthful path ID is `agentcursor/chrome`. It means headed Chrome or Chromium, explicit CDP targets, selectively ported AgentCursor path and persona logic, screenshot-first perception, and explicit DOM fallback. It does not mean AgentCursor MCP or its stock extension.

The legacy path ID `agent-browser/chrome` remains public only while the service-level rollback switch exists. A running webxd instance reports only the path for its selected backend.

## Public model

A browser session contains:

- `browserSessionId`;
- `pathId`;
- `controlEpoch`;
- state;
- optional persona and CSS cursor summary;
- explicit tabs.

A tab contains its public `tabId`, URL, title, state, document generation, viewport generation, and frame sequence. The public contract does not expose CDP target IDs, sockets, profiles, descriptors, or secrets.

`browser_observe` defaults to `screenshot`. Its result contains the real browserd observation ID and bounded metadata for the exact session and tab. It includes CSS viewport dimensions, image pixel dimensions, device-pixel ratio, capture scale, scroll, generations, digest, media type, cursor, and validity time.

POST observation returns metadata only. The Pi facade uses a separate authenticated GET for the exact actor/session/tab/observation image, verifies the complete browserd artifact, and moves the bytes through `artifactPayload`. Pi presentation emits one bounded text item and one image item. Image base64 does not appear in the text item or compact details.

`browser_observe` accepts `mode: dom` only as an explicit fallback. A DOM observation contains bounded document-scoped opaque handles. DOM pointer actions still use the human-style browser motor.

Coordinate actions cite the real screenshot observation ID. Their default coordinate space is `imagePixels`. Browserd resolves the cited observation and converts each point with its exact recorded dimensions:

```text
cssX = imageX * cssViewportWidth / imagePixelWidth
cssY = imageY * cssViewportHeight / imagePixelHeight
```

Browserd applies the same conversion to both drag endpoints. It validates source bounds and performs normal post-path observation checks before irreversible input.

## Supported operations

Phase 2A exposes only implemented operations:

- screenshot-bound move, click, double-click, drag, and wheel;
- explicit text input, key press, and navigation;
- explicit DOM click, double-click, hover, type, fill, and key press;
- explicit tab create, list, focus, and close;
- session close and operation cancellation.

It does not expose selectors as the normal action model. It does not expose arbitrary JavaScript, upload, download, broad debug, recording, workspace, or human takeover operations.

## Resource and retry rules

WebX uses its idempotency key as the stable source for browserd mutation identity. Each wire attempt has a separate request ID. Exact retries reuse one operation result while its referenced resource remains valid. Conflicting semantics fail with a conflict.

Phase 2A intended screenshot bytes to stay outside general idempotency, but its all-successful-POST policy did not enforce that. Phase 2B classifies routes explicitly. Durable small mutations use the bounded 15-minute map. Screenshot and DOM observations and exact image reads bypass it. Diagnostics require zero retained image bytes.

Webxd reads bounded browserd artifact chunks, verifies canonical base64, byte count, media type, SHA-256, and decoded PNG or JPEG dimensions. It retains bounded exact-observation metadata and no full screenshot buffer. The bytes exist only during the exact request and immediate Pi image presentation.

A cached response cannot revive an expired observation, artifact, handle, or changed document. A webxd restart rehydrates actor-owned sessions from the same browserd runtime. A browserd restart does not recreate sessions. An old session fails with `BROWSER_INSTANCE_REPLACED` or a non-enumerating not-found result. The agent must open a new session.

## Consequences

The bundled SDK and native Pi extension must move with public API major 3. Old browser callers are not source-compatible.

Image-grounded actions remain valid at non-1 DPR because the conversion occurs inside browserd against the cited observation. Public cursor coordinates remain CSS viewport coordinates.

The contract is smaller than the legacy browser surface. Unsupported legacy workspace and debug tools are not active for `agentcursor/chrome`.

Phase 2B.1 adds internal session capture arbitration without changing this public contract. Production-default routing stays disabled. The immutable startup switch still defaults to `legacy`. ADR-016 is authoritative for screenshot transfer and idempotency lifetimes; ADR-017 is authoritative for internal capture concurrency and timeout recovery.
