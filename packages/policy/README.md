# `@webx/policy`

Reusable WebX policy primitives.

The package validates public HTTP/HTTPS destinations after DNS resolution. It rejects private, loopback, link-local, carrier-grade NAT, multicast, unspecified, reserved, metadata, encoded IPv4, and IPv4-mapped IPv6 targets. Callers must run the validation for each redirect and must still use `egressd` for connection-time DNS pinning.

It also supplies strict owner checks, visibility-lattice operations, and finite approval descriptors. An approval descriptor describes a possible human approval. It does not grant access by itself.

```bash
pnpm --dir packages/policy typecheck
pnpm --dir packages/policy test
```
