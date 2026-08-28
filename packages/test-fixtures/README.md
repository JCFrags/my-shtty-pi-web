# WebX deterministic fixture origin

This package implements `WX-M0-006` and `WX-M0-007`. It supplies one licensed local origin and one deterministic adversarial corpus for repeatable HTTP, policy, parser, and later browser tests. It uses only Node.js built-in modules. It does not need public network access.

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

- stable origin and adversarial manifest versions and hashes across starts;
- literal loopback-only listening;
- representative HTML, SPA, redirect, malformed, bounds, robots, auth, crawl, feed, API, and failure routes;
- web-only slow, endless, oversized, compressed-expansion, redirect-loop, special-redirect, mixed-DNS, bad-charset, and partial-body cases;
- reason-coded SSRF, encoded-address, DNS-rebinding, redirect, and browser-subresource inputs;
- a protected counter of exactly zero for every denial harness input;
- generated archive traversal, absolute-path, symlink, compression-ratio, and malformed-document fixtures without expansion;
- synthetic canary detection across log, receipt, Markdown, event, index, wiki, screenshot, trace, diagnostic, and evidence surfaces;
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
| `/failure/endless` | sends one stable prefix and waits until the client cancels |
| `/failure/partial-body` | sends 23 of 64 declared bytes and closes the response |
| `/failure/disconnect` | connection termination |
| `/protected/counter` | current protected access count |
| `/protected/resource` | increments the protected access count once per request |
| `POST /protected/reset` | resets the protected counter for an isolated test |

## Web failure fixture discovery

`GET /web/manifest.json` returns a stable manifest for web-reader and fetch-policy tests. These fixtures use only the loopback origin. Redirect targets use private, link-local, or non-HTTP values, but the fixture tests inspect each `Location` header without following it. Mixed DNS cases use `.invalid` hostnames and documentation addresses. They do not query or change DNS.

Main web failure routes:

| Route | Purpose |
|---|---|
| `/bounds/large` | oversized response with exact length and stable hash |
| `/bounds/compressed` | small gzip wire body with exact expanded bytes |
| `/redirect/loop/a`, `/redirect/loop/b` | two-hop redirect loop |
| `/redirect/private-address` | redirect candidate to an RFC 1918 address |
| `/redirect/link-local` | redirect candidate to the metadata link-local address |
| `/redirect/non-http` | redirect candidate with a `file:` scheme |
| `/encoding/unknown` | unknown declared charset with stable UTF-8 bytes |
| `/encoding/mismatch` | ASCII declaration with stable UTF-8 bytes |
| `/encoding/malformed-utf8` | UTF-8 declaration with one invalid byte sequence |

`src/web.mjs` exports ordered mixed-DNS answers and all expected outcomes. The endless response ends only when the client cancels or the fixture stops. The fixture stop operation destroys all open loopback sockets.

## Adversarial fixture discovery

`GET /security/manifest.json` returns the stable `WX-M0-007` manifest. The manifest contains only generated or documentation-reserved data. Hostnames use `.invalid`. Public-looking address evidence uses documentation ranges. DNS rebinding is represented as an ordered answer sequence. Tests do not change host DNS.

Main security routes:

| Route | Purpose |
|---|---|
| `/security/manifest.json` | adversarial case IDs, limits, license, and hashes |
| `/security/redirect/start` | first local redirect hop |
| `/security/redirect/private` | redirect candidate to the protected route |
| `/security/browser-subresources` | inert page with private and metadata subresource candidates |

`src/adversarial.mjs` exports the exact denial inputs and `runZeroPacketDenialHarness()`. The harness reads the protected counter before and after all decisions. It calls the supplied transport only after an allow decision. A denial check passes only when the transport call count and protected packet count both stay at zero.

The archive files are generated in memory and are never expanded by the focused tests. The secret values use the `WEBX_TEST_SECRET_` prefix. They are synthetic test inputs. `scanSecretCanaries()` scans nested strings and buffers. Its allowlist is only for the exact protected input path in a scanner test. Do not add output paths to that allowlist.

Keep all listeners loopback-only. Do not use these fixtures with public traffic, host DNS changes, private data, browser profiles, or real credentials.
