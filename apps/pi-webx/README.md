# Pi WebX

This Pi extension presents the repository's internet capabilities as one small, strict tool set.

## Tool selection

- `web_read`: read a known public URL, API, feed, PDF, or document. It returns a bounded passage, an opaque content ID, and exact continuation metadata.
- `web_read_batch`: read 1 to 5 selected direct-read items with maximum concurrency 3 and separate ordered result envelopes.
- `web_content`: retrieve an exact continuation or a focused passage from stored normalized content without a network request.
- `web_search`: send one complete query for ranked links, or set `output: "extracts"` for a few short passages read from selected pages.
- `browser_open`: open an owned browser only when direct reading cannot provide required dynamic state, interaction, DOM evidence, or pixels.
- `browser_tabs`: list or close owned browser tabs and sessions.
- `browser_observe`: inspect current browser text, semantic controls, DOM state, changes, or screenshot-bound pixels.
- `browser_act`: perform one action based on the latest observation.
- `browser_debug`: request bounded advanced diagnostics in explicit debug mode.

The tool descriptions, field descriptions, active-tool prompt guidelines, and WebX system guidance use the same routing rules. Schema descriptions state parameter purpose, defaults, continuation rules, and incompatible uses. Strict schemas reject unknown fields and unsupported browser operations.

## Important behavior

Normal multi-source research uses `web_search` and then `web_read_batch` for selected sources. Linked crawl is explicit advanced legacy-compatible behavior, not the normal research path. A normal `web_read` returns at most 30,000 content characters inside the single 40,000-character agent-output ceiling. WebX stores the normalized extracted body and returns an opaque content ID. Use `web_content` with the reported stored offset for exact continuation, or use `findText` or `query` for focused retrieval. It does not refetch. Structured API projections return one object per collection row. Use `contentOffset` only for a reported source continuation after the stored body ends. An explicit `save` writes one normal or focused extraction below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` and returns compact file metadata. Saved reads do not support structured projection or linked crawling.

Search needs only `query`. It returns links by default. Optional `output: "extracts"` reads a bounded set of top pages concurrently and returns up to four short passages. Optional `domains` are strict host requirements. The Pi tool row shows the exact submitted query, output form, and strict domains, so the user can always see what WebX searched for. WebX sends the complete query without product-specific or generic suffix variants. It uses one narrow recovery retry when a `site:` query returns no eligible result. Search removes tracking parameters and duplicate URLs. Link snippets come from search discovery. Extract passages come only from successful page reads. Extracts remain separate by source and do not synthesize a conclusion. Search never follows page links. Read crawling follows linked pages.

Browser work follows open, observe, act, observe, and close. Semantic refs are preferred. Coordinate actions bind to the latest visual observation. The exposed browser schema does not support upload or download.

Only the user changes modes. Run `/web` with no options to open one settings menu for capability modes and browser workspace controls. Direct forms remain under the same command: `/web mode off|read|browser|debug` and `/web workspace show|hide|list|attach|takeover|return [sessionId]`. Browser tools are available by default. There is no separate browser slash command or model-facing upgrade tool.

Repeated searches and reads use a short-lived RAM and SSD traffic cache. Read results report fetch and validation timestamps. Set `refresh: true` only when current source validation is required. Refresh bypasses a fresh read-cache hit. WebX can use bounded origin validators and reuse unchanged canonical content after an HTTP 304 response. The cache is not a durable research library or a recall tool.

The extension also writes a separate user-only audit record for each real `web_search`, `web_read`, and `web_read_batch` call. New records contain sanitized bounded inputs and result metadata only. They include actor scope, timestamps, duration, outcome, error class, cache and coalescing state, content IDs, digests, counts, and sizes when available. They do not contain fetched bodies, source bytes, snippets, passages, or final agent-visible output. Existing files are not migrated. New audit history uses a 30-day and 100 MiB policy with a bounded prune scan. Inspect them with `pi-web audit list` and `pi-web audit show RECORD_ID`. Audit history is not a Pi tool and is not automatic model recall.

The extension calls the local WebX SDK over a same-user Unix socket. It does not call websites, browser providers, or subprocesses directly. It fails closed when the local daemon is unavailable.
