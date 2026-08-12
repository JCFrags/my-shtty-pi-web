# WebX deterministic fixture origin

This package implements `WX-M0-006`. It supplies one licensed local origin for repeatable HTTP and later browser tests. It uses only Node.js built-in modules. It does not need public network access.

## Safety boundary

The origin accepts only the literal loopback addresses `127.0.0.1` and `::1`. The default is `127.0.0.1` with an operating-system-selected port. It rejects wildcard addresses and hostnames. All credentials and content are synthetic. Generated fixture content uses CC0-1.0.

Do not put real credentials, private profile data, user corpus data, or host paths in this package.

## Run

```bash
pnpm --filter @webx/test-fixtures start
```

The first standard-output line is JSON. It includes the selected origin and deterministic fixture version. Stop with `SIGINT` or `SIGTERM`.

Optional settings:

```bash
WEBX_FIXTURE_HOST=127.0.0.1 WEBX_FIXTURE_PORT=0 pnpm --filter @webx/test-fixtures start
```

## Test

```bash
pnpm --filter @webx/test-fixtures test
```

The focused suite proves:

- stable manifest version and hashes across starts;
- literal loopback-only listening;
- representative HTML, SPA, redirect, malformed, bounds, robots, auth, crawl, feed, API, and failure routes;
- a protected counter of zero before access and the exact count after access;
- clean cancellation and shutdown.

## Fixture discovery

`GET /manifest.json` returns the versioned capability manifest. Each route has a stable ID, method, path, content type, license/source statement, and a content hash when its bytes are static. `GET /health` returns the fixture version.

Main routes:

| Route | Purpose |
|---|---|
| `/html/static` | canonical static page and validator |
| `/html/changed/v1`, `/html/changed/v2` | stable meaningful content versions |
| `/spa` | shell with deterministic local JavaScript subresource |
| `/redirect/static` | fixed relative redirect |
| `/html/malformed` | deterministic malformed markup |
| `/bounds/large` | stable seeded large body |
| `/bounds/compressed` | stable gzip expansion case |
| `/robots.txt` | allow and crawl-private deny rules |
| `/auth/basic` | synthetic basic-auth canary |
| `/subresources/app.js`, `/subresources/style.css` | browser subresources |
| `/crawl/`, `/crawl/a`, `/crawl/b` | finite graph with cycles and a duplicate target |
| `/feeds/rss.xml`, `/feeds/atom.xml` | stable feed inputs |
| `/api/items` | stable JSON API |
| `/failure/status/503` | fixed status and retry metadata |
| `/failure/slow?ms=N` | bounded deterministic delay from 0 to 2000 ms |
| `/failure/disconnect` | connection termination |
| `/protected/counter` | current protected access count |
| `/protected/resource` | increments the protected access count once per request |
| `POST /protected/reset` | resets the protected counter for an isolated test |

`WX-M0-007` can extend the protected fixture with adversarial DNS and policy scenarios. It must preserve this local-only listener and the counter semantics.
