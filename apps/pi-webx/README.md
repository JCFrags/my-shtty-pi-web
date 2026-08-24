# Pi WebX

This Pi extension presents the repository's internet capabilities as one small, strict tool set.

## Tool selection

- `web_read`: read a known public URL, API, feed, PDF, or document. It supports full main content, section selection, structured JSON rows, item pagination, reported continuations, and explicit linked crawling.
- `web_search`: choose URL discovery (`links`) or separate sourced passages (`extracts`), with a fixed `fast` or `quality` recipe.
- `web_research`: synthesize and validate bounded evidence from multiple sources.
- `browser_open`: open an owned browser only when direct reading cannot provide required dynamic state, interaction, DOM evidence, or pixels.
- `browser_tabs`: list or close owned browser tabs and sessions.
- `browser_observe`: inspect current browser text, semantic controls, DOM state, changes, or screenshot-bound pixels.
- `browser_act`: perform one action based on the latest observation.
- `browser_debug`: request bounded advanced diagnostics in explicit debug mode.

The tool descriptions, field descriptions, active-tool prompt guidelines, and WebX system guidance use the same routing rules. Schema descriptions state parameter purpose, defaults, continuation rules, and incompatible uses. Strict schemas reject unknown fields and unsupported browser operations.

## Important behavior

A normal `web_read` returns complete extracted main content up to the source limit. Omit `maxChars` for a full read. Structured API projections return one object per collection row. Use continuation values only when the prior result reports them. `contentOffset` applies to direct single-page reading and cannot be combined with linked crawling.

Search has four fixed recipes from its required `operation` and `effort` axes. Fast uses one search. Quality uses bounded conservative fan-out, deduplication, verification, and reranking. Search never follows links. Extracts remain separate by source and do not synthesize a conclusion. Read crawling follows linked pages. Research crawling follows linked evidence.

Browser work follows open, observe, act, observe, and close. Semantic refs are preferred. Coordinate actions bind to the latest visual observation. The exposed browser schema does not support upload or download.

Only the user changes modes with `/web off|read|browser|debug`. Browser tools are available by default. There is no model-facing upgrade tool.

Repeated searches and reads use a short-lived RAM and SSD traffic cache. It is not a durable research library or a recall tool.

The extension calls the local WebX SDK over a same-user Unix socket. It does not call websites, browser providers, or subprocesses directly. It fails closed when the local daemon is unavailable.
