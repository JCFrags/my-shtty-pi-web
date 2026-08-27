# Pi WebX

This Pi extension presents the repository's internet capabilities as one small, strict tool set.

## Tool selection

- `web_read`: read a known public URL, API, feed, PDF, or document. It supports full main content, section selection, structured JSON rows, item pagination, reported continuations, explicit linked crawling, and one-page Markdown export.
- `web_search`: send one complete query for ranked links, or set `output: "extracts"` for a few short passages read from selected pages.
- `browser_open`: open an owned browser only when direct reading cannot provide required dynamic state, interaction, DOM evidence, or pixels.
- `browser_tabs`: list or close owned browser tabs and sessions.
- `browser_observe`: inspect current browser text, semantic controls, DOM state, changes, or screenshot-bound pixels.
- `browser_act`: perform one action based on the latest observation.
- `browser_debug`: request bounded advanced diagnostics in explicit debug mode.

The tool descriptions, field descriptions, active-tool prompt guidelines, and WebX system guidance use the same routing rules. Schema descriptions state parameter purpose, defaults, continuation rules, and incompatible uses. Strict schemas reject unknown fields and unsupported browser operations.

## Important behavior

A normal `web_read` returns complete extracted main content up to the source limit. Omit `maxChars` for a full read. Structured API projections return one object per collection row. Use continuation values only when the prior result reports them. `contentOffset` applies to direct single-page reading and cannot be combined with linked crawling. An explicit `save` writes one normal or focused extraction below `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` and returns compact file metadata. Saved reads do not support structured projection or linked crawling.

Search needs only `query`. It returns links by default. Optional `output: "extracts"` reads a bounded set of top pages concurrently and returns up to four short passages. Optional `domains` are strict host requirements. The Pi tool row shows the exact submitted query, output form, and strict domains, so the user can always see what WebX searched for. WebX sends the complete query without product-specific or generic suffix variants. It uses one narrow recovery retry when a `site:` query returns no eligible result. Search removes tracking parameters and duplicate URLs. Link snippets come from search discovery. Extract passages come only from successful page reads. Extracts remain separate by source and do not synthesize a conclusion. Search never follows page links. Read crawling follows linked pages.

Browser work follows open, observe, act, observe, and close. Semantic refs are preferred. Coordinate actions bind to the latest visual observation. The exposed browser schema does not support upload or download.

Only the user changes modes. Run `/web` with no options to open one settings menu for capability modes and browser workspace controls. Direct forms remain under the same command: `/web mode off|read|browser|debug` and `/web workspace show|hide|list|attach|takeover|return [sessionId]`. Browser tools are available by default. There is no separate browser slash command or model-facing upgrade tool.

Repeated searches and reads use a short-lived RAM and SSD traffic cache. It is not a durable research library or a recall tool.

The extension also writes a separate user-only audit record for each real `web_search` and `web_read` call. A record contains sanitized input, the structured result, final agent-visible output, duration, and failure state. Records remain for at most 90 days and 10 GiB. Inspect them with `pi-web audit list` and `pi-web audit show RECORD_ID`. Audit history is not a Pi tool and is not automatic model recall.

The extension calls the local WebX SDK over a same-user Unix socket. It does not call websites, browser providers, or subprocesses directly. It fails closed when the local daemon is unavailable.
