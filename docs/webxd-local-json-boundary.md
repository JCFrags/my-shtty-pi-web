# Webxd local JSON boundary

Status: accepted for WP1-M1 and WP1-M2.

Webxd uses one bounded JSON client for its loopback SearXNG and reader calls. The client accepts only credential-free HTTP URLs on `localhost`, `127.0.0.1`, or `::1`. It combines the caller signal with an internal deadline. It reads the response stream through a byte counter before it parses JSON.

The frozen operation limits are:

| Operation | Deadline | Maximum response body |
| --- | ---: | ---: |
| SearXNG query | 15 seconds | 2 MiB |
| Reader request | 45 seconds | 4 MiB |
| SearXNG health | 2 seconds | 2 MiB |
| Reader health | 2 seconds | 2 MiB |

SearXNG capability health sends one bounded local `GET /config` request. This route returns JSON without dispatching a search. A capability request never calls `/search`. Webxd reports search as unhealthy for a non-2xx response, an empty or malformed JSON response, a timeout, or a connection failure. Caller cancellation cancels the complete capability request. Real search requests still use the query limit and preserve provider degradation from SearXNG responses.

Reader health remains an independent bounded call to the reader `/health` route. Browser health remains independent. A failure in one capability does not change another capability's health result.

This change does not alter public request or response shapes. It does not alter reader destination checks, DNS pinning, redirect checks, or source acquisition limits. Those controls remain in the reader service.
