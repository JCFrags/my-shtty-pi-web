# ADR-011: browserd trusts only webxd in production

Status: accepted for Phase 2 design.

## Context

`browserd` uses an owner-only Unix socket, an owner-only descriptor, and a random binding secret. These controls prevent access by another Unix user. They do not isolate one process from hostile code that already runs under the same Unix user ID.

The Pi model and tool layer must not obtain the browserd descriptor, binding secret, profile path, or CDP endpoint. Actor fields asserted by an arbitrary same-user client are not cryptographic proof of an actor.

## Decision

- Production `browserd` accepts only the trusted `webxd` broker as its client.
- `webxd` authenticates and scopes the Pi connection before it supplies actor identity to `browserd`.
- Pi model and tool requests do not receive the browserd descriptor or binding secret.
- The Pi extension does not connect directly to `browserd`.
- Direct browserd access remains a local administrator and developer capability.
- Hostile code under the same Unix user ID is outside this protection boundary.
- A later design can add a separate Unix user, sandbox, or equivalent process boundary if hostile same-user code becomes in scope.

## Consequences

Phase 2 must connect `webxd` to `browserd` through one private service route. It must keep search and read independent from browser failures. It must not describe the shared same-user binding secret as actor authentication.

The current Phase 1.1 daemon remains unrouted. This decision does not weaken its actor-, connection-, session-, tab-, epoch-, operation-, subscription-, or artifact-scoped checks.
