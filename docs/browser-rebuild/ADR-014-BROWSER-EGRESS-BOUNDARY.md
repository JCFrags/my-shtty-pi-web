# ADR-014: Browser navigation and egress boundary

Status: accepted and hardened by Phase 2B

## Context

Browser pages can navigate through an explicit API, redirects, links, script, forms, and popups. URL checks on the explicit WebX request cannot constrain later page-driven network connections. Chrome must use a network path that checks and pins every destination connection.

Browserd must also reject forged explicit navigation from another actor, operation, daemon instance, URL, or egress route. Pi must not receive the signing secret, browserd descriptor, proxy configuration secret, socket, profile, or CDP endpoint.

## Decision

Public browser navigation uses two related controls.

First, trusted webxd applies public destination policy to every initial URL, explicit navigation, and URL-bearing new tab. It normalizes public HTTP or HTTPS syntax, resolves the destination, and rejects local, private, loopback, link-local, reserved, or mixed DNS answers.

Webxd then creates a short-lived signed browser authorization. The token binds:

- browserd runtime instance;
- authenticated principal and Pi agent session;
- stable operation ID;
- normalized URL;
- configured egress binding ID;
- expiration;
- nonce.

Browserd verifies the signature and every binding before it dispatches explicit navigation. The descriptor carries the owner-only broker signing secret from browserd to trusted webxd. The Pi extension and model do not receive it.

Second, production Chrome uses the reviewed forward proxy in `components/browser/scripts/secure_egress_proxy.py`. Browserd accepts only a structured loopback proxy host and port from service configuration. It does not accept request-provided Chrome flags.

Chrome launches with:

- an explicit HTTP proxy server;
- loopback removed from Chrome's implicit proxy bypass list;
- QUIC disabled;
- non-proxied WebRTC UDP disabled.

The proxy accepts only a literal loopback listener address and a valid port. It owns a deterministic local health endpoint at `http://webx-egress.invalid/.well-known/webx-egress-health`. A valid probe returns exact status 204, an empty body, and `WebX-Egress-Proxy: secure-egress/1`. Webxd applies a bounded timeout and small health cache and requires browserd's egress binding ID to match its own. A successful TCP connection or unrelated HTTP response is unhealthy. Session creation calls readiness independently of cached capability health.

For each HTTP request or HTTPS CONNECT, the proxy rejects credentials and local names. CONNECT uses strict authority-form parsing. It resolves the destination and rejects the complete answer set if any address is non-public. It connects directly to one validated IP address from that answer set. Public IPv6 literals are bracketed when constructing HTTP Host fields. This connection pin prevents DNS rebinding between policy validation and connection setup.

Each redirect, link navigation, form, script navigation, and popup network request goes through a new proxy request or connection and receives the same destination checks. Production session creation calls the destination authority readiness check before Chrome starts. Browser capability health also depends on configured egress. A missing or unreachable proxy fails closed.

Browserd monitors top-level target URLs as a second boundary. It permits public HTTP or HTTPS, `about:blank`, and a bounded Chromium error URL. It closes and removes tabs that commit a file or unsupported external protocol. Unknown targets are not adopted. A popup is adopted only when its opener is an owned tab and registration completes transactionally.

Downloads are denied in Chrome, not only omitted from the API. Browser startup requires `Browser.setDownloadBehavior` with `behavior: "deny"` and events enabled. A download start emits a bounded typed denial, requests `Browser.cancelDownload`, and fails the host closed if cancellation cannot be enforced. No request can select a writable download path. Unsupported browser versions fail capability/startup instead of silently allowing downloads. Chrome sandboxing, site isolation, certificate validation, and web security remain enabled.

## Trust boundary

Trusted webxd is the only production browserd client. The browserd Unix directory uses mode `0700`; its descriptor and request socket use mode `0600`. Browserd binds each connection once to the actor that webxd derived from authenticated authority context.

The forward proxy is a network confinement control for browser connections. It is not an identity service for arbitrary same-user processes. Hostile code already running as the service Unix user remains outside the ADR-011 protection boundary.

## Test-only loopback fixtures

Production destination policy never permits loopback browsing. The headed route test uses separate source-level `LoopbackFixtureAuthorization` and `LoopbackDestinationAuthority` fixtures. These fixtures exist only in the opt-in test harness. Production service configuration has no switch that enables them.

The test browser still uses an explicit loopback proxy. That proxy forwards only to the deterministic local fixture. This proves the complete native Pi route without weakening the production destination policy.

## Failure and restart behavior

A browser authorization expires after 15 seconds. It cannot be used with another actor, operation, runtime instance, normalized URL, or egress binding.

Browserd replacement changes both runtime identity and descriptor secrets. Webxd detects that change, closes old actor connections, and rejects old sessions. It signs new work only against the replacement descriptor.

Browserd or functional proxy failure, malformed or stalled health response, or egress binding disagreement makes browser capability unavailable. Proxy restart is reflected after the bounded health-cache interval. It does not make WebX search, direct read, content, cache, or artifact services unhealthy.

## Consequences

A broker authorization is necessary but is not sufficient. Production browsing is unavailable without a healthy connection-bound proxy route.

A proxy destination check is necessary for every connection because page-driven navigation does not carry a WebX operation token. Top-level target quarantine is defense in depth after commit; it is not a substitute for network denial before connection.

The branded local probe proves that the expected reviewed service is responding. It is not cryptographic protection against hostile code running as the same Unix user.

Production-default `agentcursor` routing remains disabled after Phase 2B. Operators must configure and supervise the reviewed proxy before a later staged deployment can select this backend.
