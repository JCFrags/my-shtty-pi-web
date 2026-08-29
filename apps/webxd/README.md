# webxd

`webxd` is the single local WebX authority and runnable same-user Unix API.

## Runtime

Build and start it with:

```bash
pnpm --dir apps/webxd start
```

The runtime requires `XDG_RUNTIME_DIR`. It listens at `$XDG_RUNTIME_DIR/pi-web/webxd.sock` by default. `WEBXD_SOCKET` can replace that path.

`WEBX_BROWSER_BACKEND` is read once at startup. It accepts `legacy` or `agentcursor` and defaults to `legacy`. Legacy mode uses `BROWSERD_SOCKET` or `$XDG_RUNTIME_DIR/pi-web/browserd.sock`. AgentCursor mode securely reads `BROWSERD_DESCRIPTOR` or `$XDG_RUNTIME_DIR/pi-browserd/browserd.json` inside `BROWSERD_RUNTIME_DIR`. It never falls back to the other backend.

The server:

- creates `WebxAuthority`;
- accepts only bounded JSON lines on a mode `0600` Unix socket;
- uses socket mode `0600` for the same-UID boundary;
- issues one random runtime binding secret during facade start;
- requires the binding ID and secret on later requests;
- rejects forged binding secrets and does not let one request change actor identity;
- uses one persistent browser connection per bound actor;
- uses legacy actor registration only in legacy mode;
- binds AgentCursor browserd connections once from authenticated authority identity;
- reconnects for new work after a browser daemon replacement but never recreates or remaps old sessions;
- removes its Unix socket and closes upstream connections during shutdown;
- fails closed. It has no direct browser-provider fallback.

Browser operations use only `BrowserDaemonPort`. The selected backend reports only its own path and actions. `agentcursor/chrome` uses explicit sessions and tabs, screenshot observations, image-pixel or CSS-viewport coordinates, explicit DOM fallback, and bounded cancellation. It does not expose legacy workspace, debug, upload, or download operations.

For `agentcursor`, webxd applies destination policy and signs a short-lived browser authorization bound to the actor, operation, runtime, normalized URL, and configured egress route. Browser session creation fails closed unless the destination authority reports a healthy proxy. Search, read, content, cache, and artifacts remain independent of browserd.

## Search

A search request needs one complete query. SearXNG's `/search` JSON response is the discovery source. Search does not use browser automation, scrape a search-results page, inject known URLs, or apply product-specific routing. The local SearXNG setup runs its enabled engines for the same query. WebX does not invent query suffixes. It normally sends one SearXNG request. If a query with `site:` returns no eligible result, WebX retries once without that operator while retaining the same strict host constraint.

Optional `domains` and query `site:` values are intersected. Conflicting constraints fail before discovery. Every returned URL must satisfy the resolved host set. WebX removes fragments, default ports, common tracking parameters, canonical URL duplicates, and exact same-host title or substantive snippet duplicates. It combines provider order with small title, URL, and snippet relevance adjustments. Link output returns up to ten discovery results and does not fetch result pages.

Optional `output: "extracts"` reads top distinct pages in groups of four. It tries at most eight pages and returns at most four short contiguous query-focused passages. A passage is returned only after a successful page read. A search-engine snippet is never substituted for a failed extract. Failed reads are skipped and reported through partial metadata. Search never follows page links or synthesizes a cross-source answer. A total provider failure is a retryable error. A healthy search with no result remains a successful empty result.

## Normalized-content store

Direct reads store only normalized extracted text. They never store original response bytes or document base64 as the normalized artifact. Content IDs are random and opaque. The store has positive limits for total bytes, entry count, item bytes, and retention. It prunes on insertion and startup. Files default to `$XDG_CACHE_HOME/pi-web/content`; `WEBX_CONTENT_DIR` can select another directory.

The `/v1/read-batch` route accepts 1 to 5 direct-read items. Batch items do not accept crawl or save controls. It runs at most three reads at once. It returns ordered separate success or failure envelopes. Each success uses the same normalized-content storage behavior as `/v1/read`.

The `/v1/content` route supports exact offset retrieval and focused `findText` or `query` retrieval. These modes are mutually exclusive. The route reads only the store and never fetches a URL.

## Short-lived cache

Search responses, including extract output, use a 15-minute cache. Direct `web_read` results use a six-hour cache. Read metadata reports when the source was fetched and validated, its cache age in milliseconds, and a `hit`, `miss`, or `revalidated` cache state. `refresh: true` bypasses a fresh read-cache hit. Stale or refreshed reads use bounded ETag and Last-Modified validators when the canonical record is still available. An HTTP 304 result reuses the same canonical content and content ID, then updates validation metadata. Refresh work has separate idempotency and coalescing identity from ordinary reads.

The cache keeps up to 256 entries and 32 MiB in RAM. It keeps up to 2,048 entries and 512 MiB on SSD. One serialized response can use at most 4.3 MB. Oversized entries are not cached. Disk scans and pruning keep bounded in-memory state. Files default to `$XDG_CACHE_HOME/pi-web/responses` with user-only permissions. `WEBX_CACHE_DIR` can select another directory. Cache failures never block a live request.

Identical eligible search and read work is coalesced under at most 256 in-flight keys. Each caller keeps independent cancellation. The shared operation stops only when no waiter remains.

Successful mutation idempotency records expire after 15 minutes. They use at most 1,024 entries and 16 MiB. Browser screenshot responses do not put multi-megabyte image base64 in this general cache. AgentCursor screenshot bytes come from verified bounded browserd artifact reads and move through the facade image payload.

This cache reduces repeated search-provider and website traffic. It is not a durable research archive and has no Pi-facing recall operations. When a change alters cached search semantics, update the search cache format version so an older response cannot mask the new behavior.

## Public routes

The Pi-facing authority covers search, read, stored normalized content, capabilities, and browser create/list/get/observe/frame/act/cancel/close-session/close-tab. Legacy backend capabilities can also expose workspace, debug, and control. The AgentCursor backend does not. Page-library functions are reserved for a future separate research-archive extension. Internal artifact routes support bounded component transfers and are not Pi tools.

Page history search returns explicit `501 unavailable`. Safe browser debug permits `console`, `network`, `html`, `pdf`, `record-start`, and `record-stop`. Secret-bearing `evaluate`, `cookies`, and `storage` operations are refused.
