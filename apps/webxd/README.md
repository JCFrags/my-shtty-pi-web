# webxd

`webxd` is the single local WebX authority and runnable same-user Unix API.

## Runtime

Build and start it with:

```bash
pnpm --dir apps/webxd start
```

The runtime requires `XDG_RUNTIME_DIR`. It listens at `$XDG_RUNTIME_DIR/pi-web/webxd.sock` by default. It connects to `$XDG_RUNTIME_DIR/pi-web/browserd.sock` by default. `WEBXD_SOCKET` and `BROWSERD_SOCKET` can replace these paths.

The server:

- creates `WebxAuthority`;
- accepts only bounded JSON lines on a mode `0600` Unix socket;
- uses socket mode `0600` for the same-UID boundary;
- issues one random runtime binding secret during facade start;
- requires the binding ID and secret on later requests;
- rejects forged binding secrets and does not let one request change actor identity;
- uses one persistent browser connection per bound actor;
- sends `agent.register` once before protected browser RPCs;
- reconnects after a browser daemon outage;
- removes its Unix socket and closes upstream connections during shutdown;
- fails closed. It has no direct browser-provider fallback.

Browser operations use only `BrowserDaemonPort`. Semantic actions use the frozen `browser.act` shape. Visual CUA uses the frozen scoped workspace lease, frame, control, and input methods.

## Search

A search request needs one complete query. SearXNG's `/search` JSON response is the discovery source. Search does not use browser automation, scrape a search-results page, inject known URLs, or apply product-specific routing. The local SearXNG setup runs its enabled engines for the same query. WebX does not invent query suffixes. It normally sends one SearXNG request. If a query with `site:` returns no eligible result, WebX retries once without that operator while retaining the same strict host constraint.

Optional `domains` and query `site:` values are intersected. Conflicting constraints fail before discovery. Every returned URL must satisfy the resolved host set. WebX removes fragments, default ports, common tracking parameters, canonical URL duplicates, and exact same-host title or substantive snippet duplicates. It combines provider order with small title, URL, and snippet relevance adjustments. Link output returns up to ten discovery results and does not fetch result pages.

Optional `output: "extracts"` reads top distinct pages in groups of four. It tries at most eight pages and returns at most four short contiguous query-focused passages. A passage is returned only after a successful page read. A search-engine snippet is never substituted for a failed extract. Failed reads are skipped and reported through partial metadata. Search never follows page links or synthesizes a cross-source answer. A total provider failure is a retryable error. A healthy search with no result remains a successful empty result.

## Normalized-content store

Direct reads store only normalized extracted text. They never store original response bytes or document base64 as the normalized artifact. Content IDs are random and opaque. The store has positive limits for total bytes, entry count, item bytes, and retention. It prunes on insertion and startup. Files default to `$XDG_CACHE_HOME/pi-web/content`; `WEBX_CONTENT_DIR` can select another directory.

The `/v1/content` route supports exact offset retrieval and focused `findText` or `query` retrieval. These modes are mutually exclusive. The route reads only the store and never fetches a URL.

## Short-lived cache

Search responses, including extract output, use a 15-minute cache. Direct `web_read` results use a six-hour cache. The cache keeps up to 512 recent entries in RAM and up to 10 GiB on SSD. Files default to `$XDG_CACHE_HOME/pi-web/responses` with user-only permissions. `WEBX_CACHE_DIR` can select another directory. Cache failures never block a live request.

This cache reduces repeated search-provider and website traffic. It is not a durable research archive and has no Pi-facing recall operations. When a change alters cached search semantics, update the search cache format version so an older response cannot mask the new behavior.

## Public routes

The Pi-facing authority covers search, read, stored normalized content, capabilities, browser workspace, and browser create/list/get/observe/frame/act/debug/control/cancel/close-session/close-tab. Page-library functions are reserved for a future separate research-archive extension. Internal artifact routes support bounded component transfers and are not Pi tools.

Page history search returns explicit `501 unavailable`. Safe browser debug permits `console`, `network`, `html`, `pdf`, `record-start`, and `record-stop`. Secret-bearing `evaluate`, `cookies`, and `storage` operations are refused.
