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
- uses one persistent browser connection per bound actor with persistent UTF-8 decoding and independent pending, subscription, frame, incomplete-byte, and outbound bounds;
- uses legacy actor registration only in legacy mode;
- binds AgentCursor browserd connections once from authenticated authority identity;
- removes each transient actor binding when its issuing Pi socket closes while browserd-owned sessions survive;
- rehydrates actor-owned sessions after webxd restart when the browserd runtime is unchanged;
- reconnects for new work after a browser daemon replacement, purges old local metadata, and never recreates or remaps old sessions;
- removes its Unix socket and closes upstream connections during shutdown;
- fails closed. It has no direct browser-provider fallback.

Browser operations use only `BrowserDaemonPort`. The selected backend reports only its own path and actions. `agentcursor/chrome` uses explicit sessions and tabs, screenshot observations, image-pixel or CSS-viewport coordinates, explicit DOM fallback, and bounded cancellation. It does not expose legacy workspace, debug, upload, or download operations.

For `agentcursor`, webxd applies destination policy and signs a short-lived browser authorization bound to the actor, operation, runtime, normalized URL, and configured egress route. Signing and dispatch use one pinned browserd runtime connection. Capability health performs a bounded branded proxy probe and requires matching egress binding IDs. Browser session creation probes independently and fails closed unless the route is functional. Search, read, content, cache, and artifacts remain independent of browserd.

Browserd screenshot and DOM observation lifetimes default separately to 60 seconds and are configured on browserd with `BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS` and `BROWSERD_DOM_OBSERVATION_TTL_MS`. Each accepts 10,000 through 120,000 ms. Runtime expiry is monotonic and public results include exact wall `validUntil`.

AgentCursor screenshot POST returns metadata only. Webxd then serves the exact image GET by session, tab, and real observation ID. It verifies canonical base64, complete byte count, digest, media type, and decoded dimensions. It retains bounded observation metadata and no full screenshot buffer. Frame subscriptions are internal trusted primitives with idle/selected interest, active-action burst, latest-frame-only backpressure, and deterministic connection cleanup. They are not model-facing tools.

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

Successful durable-mutation idempotency records expire after 15 minutes. They use at most 1,024 entries and 16 MiB. Screenshot and DOM observations are ephemeral and exact image reads are uncached; neither enters this general map. Diagnostics report entries and bytes by policy and require image bytes retained to remain zero. AgentCursor screenshot bytes come from verified bounded browserd artifact reads and exist in webxd only for immediate facade image presentation.

This cache reduces repeated search-provider and website traffic. It is not a durable research archive and has no Pi-facing recall operations. When a change alters cached search semantics, update the search cache format version so an older response cannot mask the new behavior.

## Public routes

The Pi-facing authority covers search, read, stored normalized content, capabilities, and browser create/list/get/observe/frame/act/cancel/close-session/close-tab. Legacy backend capabilities can also expose workspace, debug, and control. The AgentCursor backend does not. Page-library functions are reserved for a future separate research-archive extension. Internal artifact routes support bounded component transfers and are not Pi tools.

Page history search returns explicit `501 unavailable`. Safe browser debug permits `console`, `network`, `html`, `pdf`, `record-start`, and `record-stop`. Secret-bearing `evaluate`, `cookies`, and `storage` operations are refused.

## Phase 3A private workspace gateway

In AgentCursor mode, webxd is also the only browserd workspace-broker client. It reads the separate browserd workspace secret, receives sanitized aggregate snapshots and exact subscribed frames, and publishes `workspace.v1` under `$XDG_RUNTIME_DIR/pi-web/workspace/`. The directory is `0700`; the descriptor and unique socket are `0600`; descriptor publication and cleanup are instance-safe.

The gateway accepts only bounded bind, snapshot, local selection, clear, ping, and close commands. State records are non-droppable. Screenshot records use bounded length-prefixed JSON plus raw payload bytes and latest-only backpressure. Tauri Rust receives the descriptor and secret; JavaScript does not. Webxd restart reconnects to a surviving browserd. Browserd replacement clears old subscriptions and sessions. The gateway is read-only and is not part of the Pi model contract.
