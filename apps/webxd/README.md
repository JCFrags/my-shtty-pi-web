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

## Search recipes

Every search request selects `links` or `extracts` and `fast` or `quality`. SearXNG's `/search` JSON response is the only discovery source. Search does not use browser automation, scrape a search-results page, call a provider API directly, inject known URLs, or apply product-specific domain promotion. The local SearXNG setup uses DuckDuckGo Web as its primary general engine and low-weight Bing as a fallback; engines that repeatedly return CAPTCHA failures are disabled in `components/browser/deploy/searxng/settings.yml.in`. Fast sends the caller's query verbatim to SearXNG once and keeps its result order. Quality sends that same query plus two plain variants that append `official` and `guide`, then merges, deduplicates, and reranks only the returned JSON results. WebX does not rewrite `site:` operators or add domain terms before discovery. Explicit domain constraints are checked only after SearXNG responds. `links` never fetches result pages. All topics use the same ordinary SearXNG discovery path. WebX does not send `time_range` to SearXNG. A requested freshness window is a soft local quality-reranking signal when SearXNG supplies a usable publication date. Missing, malformed, or unreliable dates never exclude a result. Links return URL discovery results. Extracts first discover URLs through SearXNG, then read only the selected result pages to return separate query-focused passages, with a useful SearXNG excerpt as fallback when a selected page cannot provide one. Search never follows links or synthesizes a cross-source answer. If all providers fail and no result remains, the operation reports the unavailable engines instead of returning a false successful empty result.

## Short-lived cache

Search results use a 15-minute cache. Extracted page reads use a six-hour cache. The cache keeps up to 512 recent entries in RAM and up to 10 GiB on SSD. Files default to `$XDG_CACHE_HOME/pi-web/responses` with user-only permissions. `WEBX_CACHE_DIR` can select another directory. Cache failures never block a live request.

This cache reduces repeated search-provider and website traffic. It is not a durable research archive and has no Pi-facing recall operations.

## Public routes

The Pi-facing authority covers search, read, research, capabilities, browser workspace, and browser create/list/get/observe/frame/act/debug/control/cancel/close-session/close-tab. Page-library functions are reserved for a future separate research-archive extension. Internal artifact routes support bounded component transfers and are not Pi tools.

Page history search returns explicit `501 unavailable`. Safe browser debug permits `console`, `network`, `html`, `pdf`, `record-start`, and `record-stop`. Secret-bearing `evaluate`, `cookies`, and `storage` operations are refused.
