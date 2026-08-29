# Pi WebX

This Pi extension presents the repository's internet capabilities as one small, strict tool set.

## Tool selection

- `web_read`: read a known public URL, API, feed, PDF, or document. It returns a bounded passage, an opaque content ID, and exact continuation metadata.
- `web_read_batch`: read 1 to 5 selected direct-read items with maximum concurrency 3 and separate ordered result envelopes.
- `web_content`: retrieve an exact continuation or a focused passage from stored normalized content without a network request.
- `web_search`: send one complete query for ranked links. The deprecated `output: "extracts"` form remains during a compatibility period and returns migration metadata.
- `browser_open`: open an owned browser only when direct reading cannot provide required dynamic state, interaction, DOM evidence, or pixels.
- `browser_tabs`: create, list, focus, or close explicit owned tabs and sessions when the selected backend supports them.
- `browser_observe`: receive a screenshot by default or request explicit bounded DOM fallback.
- `browser_act`: perform one screenshot-bound, DOM-bound, text, key, or navigation action on an explicit session and tab.
- `browser_debug`: request bounded advanced diagnostics only when the selected backend advertises them.

The tool descriptions, field descriptions, active-tool prompt guidelines, and WebX system guidance use the same routing rules. Schema descriptions state parameter purpose, defaults, continuation rules, and incompatible uses. Strict schemas reject unknown fields and unsupported browser operations.

## Important behavior

Use one normal multi-source research route: `web_search` -> select 1 to 5 sources -> `web_read_batch` -> `web_content`. Use `web_content` for focus or continuation. Each normal `web_read` returns at most 30,000 content characters inside the single 40,000-character agent-output ceiling. WebX stores canonical normalized text and returns an opaque content ID. Direct query reads and stored queries use one deterministic passage selector over that canonical text. Structured API projections return one object per collection row. Use `contentOffset` only for a reported source continuation after the stored body ends. An explicit `save` writes one normal or focused extraction below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` and returns compact file metadata. Saved reads do not support structured projection or linked crawling.

The default model schema does not contain `maxPages`, `maxDepth`, or `sameDomain`. The daemon and SDK continue to accept these deprecated public fields during the compatibility period. Their removal requires a separate announced contract change. An administrator can explicitly restore them to the model schema with `PI_WEBX_ADVANCED_LINKED_READ=1`. This advanced route is not the normal research route.

Search needs only `query`. It returns links by default. Optional `output: "extracts"` is deprecated. It reads a bounded set of top pages, applies the canonical passage selector, returns up to four short passages, and includes migration metadata. Optional `domains` are strict host requirements. The Pi tool row shows the exact submitted query, output form, and strict domains, so the user can always see what WebX searched for. WebX sends the complete query without product-specific or generic suffix variants. It uses one narrow recovery retry when a `site:` query returns no eligible result. Search removes tracking parameters and duplicate URLs. Link snippets come from search discovery. Extract passages come only from successful page reads. Extracts remain separate by source and do not synthesize a conclusion. Search never follows page links. Read crawling follows linked pages.

Browser work follows open, screenshot observe, one bound action, observe again, and close. Use explicit DOM fallback only when the screenshot is not sufficient. Coordinate actions cite the real browser observation ID and use image-pixel coordinates by default. Pi receives the verified screenshot as one multimodal image item. Image base64 does not appear in model text or compact details. The exposed browser schema does not support upload or download.

Public browser API major 3 supports the new `agentcursor/chrome` route. Backend selection occurs once in webxd. Pi requests cannot select or fall back to another backend. The legacy route can remain selected for rollback, and production still defaults to it.

Only the user changes modes. Run `/web` with no options to open one settings menu for capability modes and browser workspace controls. Direct forms remain under the same command: `/web mode off|read|browser|debug` and `/web workspace show|hide|list|attach|takeover|return [sessionId]`. Browser tools are available by default. There is no separate browser slash command or model-facing upgrade tool.

Repeated searches and reads use a short-lived RAM and SSD traffic cache. Read results report fetch and validation timestamps, cache age in milliseconds, and a `hit`, `miss`, or `revalidated` cache state. Set `refresh: true` only when current source validation is required. Refresh bypasses a fresh read-cache hit. WebX can use bounded origin validators and reuse unchanged canonical content after an HTTP 304 response. The cache is not a durable research library or a recall tool.

The extension also writes a separate user-only audit record for each real `web_search`, `web_read`, and `web_read_batch` call. New records contain sanitized bounded inputs and result metadata only. They include actor scope, timestamps, duration, outcome, error class, cache and coalescing state, content IDs, digests, counts, and sizes when available. They do not contain fetched bodies, source bytes, snippets, passages, or final agent-visible output. Existing files are not migrated. New audit history uses a 30-day and 100 MiB policy with a bounded prune scan. Inspect them with `pi-web audit list` and `pi-web audit show RECORD_ID`. Audit history is not a Pi tool and is not automatic model recall.

The extension calls the local WebX SDK over a same-user Unix socket. It does not call websites, browser providers, or subprocesses directly. It fails closed when the local daemon is unavailable.
