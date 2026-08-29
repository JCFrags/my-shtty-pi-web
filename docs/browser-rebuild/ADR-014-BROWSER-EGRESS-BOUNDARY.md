# ADR-014: Browser navigation and egress boundary

Status: accepted for Phase 2A development

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

The proxy accepts only a literal loopback listener address and a valid port. For each HTTP request or HTTPS CONNECT, it rejects credentials and local names. It resolves the destination and rejects the complete answer set if any address is non-public. It connects directly to one validated IP address from that answer set. This connection pin prevents DNS rebinding between policy validation and connection setup.

Each redirect, link navigation, form, script navigation, and popup network request goes through a new proxy request or connection and receives the same destination checks. Production session creation calls the destination authority readiness check before Chrome starts. Browser capability health also depends on configured egress. A missing or unreachable proxy fails closed.

Browserd monitors top-level target URLs as a second boundary. It permits public HTTP or HTTPS, `about:blank`, and a bounded Chromium error URL. It closes and removes tabs that commit a file or unsupported external protocol. Unknown targets are not adopted. A popup is adopted only when its opener is an owned tab and registration completes transactionally.

Downloads remain disabled by contract in Phase 2A. Chrome sandboxing, site isolation, certificate validation, and web security remain enabled.

## Trust boundary

Trusted webxd is the only production browserd client. The browserd Unix directory uses mode `0700`; its descriptor and request socket use mode `0600`. Browserd binds each connection once to the actor that webxd derived from authenticated authority context.

The forward proxy is a network confinement control for browser connections. It is not an identity service for arbitrary same-user processes. Hostile code already running as the service Unix user remains outside the ADR-011 protection boundary.

## Test-only loopback fixtures

Production destination policy never permits loopback browsing. The headed route test uses separate source-level `LoopbackFixtureAuthorization` and `LoopbackDestinationAuthority` fixtures. These fixtures exist only in the opt-in test harness. Production service configuration has no switch that enables them.

The test browser still uses an explicit loopback proxy. That proxy forwards only to the deterministic local fixture. This proves the complete native Pi route without weakening the production destination policy.

## Failure and restart behavior

A browser authorization expires after 15 seconds. It cannot be used with another actor, operation, runtime instance, normalized URL, or egress binding.

Browserd replacement changes both runtime identity and descriptor secrets. Webxd detects that change, closes old actor connections, and rejects old sessions. It signs new work only against the replacement descriptor.

Browserd or proxy failure makes browser capability unavailable. It does not make WebX search, direct read, content, cache, or artifact services unhealthy.

## Consequences

A broker authorization is necessary but is not sufficient. Production browsing is unavailable without a healthy connection-bound proxy route.

A proxy destination check is necessary for every connection because page-driven navigation does not carry a WebX operation token. Top-level target quarantine is defense in depth after commit; it is not a substitute for network denial before connection.

Production-default `agentcursor` routing remains disabled in Phase 2A. Operators must configure and supervise the reviewed proxy before a later staged deployment can select this backend.
