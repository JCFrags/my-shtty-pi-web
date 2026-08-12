# `@webx/artifacts`

Reusable WebX artifact primitives.

The package supplies lowercase SHA-256 digests, safe relative artifact paths, a backend-neutral content-addressed store, integrity verification with quarantine, bounded UTF-8 excerpts, and actor-bound one-use upload/download handles. `MemoryArtifactBackend` is a deterministic reference backend. A durable service backend must implement the same write-if-absent and move operations with atomic filesystem behavior.

Transfer handles are consumed before payload validation. A rejected cross-owner, wrong-purpose, oversized, expired, or corrupt transfer cannot retry with the same handle.

```bash
pnpm --dir packages/artifacts typecheck
pnpm --dir packages/artifacts test
```
