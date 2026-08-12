# WebX toolchains

`toolchain.lock.yaml` is the exact development-tool authority for this checkout.

WebX uses Node.js 24 active LTS. It uses Python 3.14 on the declared host. Python code keeps a 3.12 compatibility baseline through `requires-python`, Ruff, and mypy settings.

TypeScript 6.0.3 is intentional. TypeScript 7.0.2 was current during resolution, but `typescript-eslint` 8.67.0 supports TypeScript versions below 6.1. The supported set is pinned until that compatibility limit changes.

## Bootstrap

Install the runtime and package-manager versions from the lock through a trusted host package or version manager. Then run:

```sh
make bootstrap
```

Bootstrap checks Node, Python, pnpm, and uv before it changes the workspace. It then runs frozen pnpm and uv synchronization and checks each lint, type, and test executable.

Corepack is optional when the exact pinned pnpm executable is present. No bootstrap command uses a remote shell script.

Use `make toolchain-check` for a read-only full version check. A mismatch prints the expected and installed versions and exits with status 2.

## Component lock

`deploy/component-catalog.json` is the reviewed input. `deploy/component-lock.json` is deterministic generated output. Run `make component-lock-check` to reject drift.

The resolver accepts lowercase SHA-256 digests and npm SHA-512 integrity values. It rejects repository path escape, duplicate component or artifact IDs, floating names, invalid digests, and enabled unresolved components in release mode. It records license, source, compatibility, health fixture, and rollback state.

Official metadata resolves these dependency-closed components:

| Component | Selection | Immutable metadata |
|---|---|---|
| Pi coding agent | 0.84.1 | npm SHA-512 integrity |
| Node.js | 24.18.0 | official Linux x64/arm64 and macOS arm64 SHA-256 values |
| Python | 3.14.6 | official source archive SHA-256 values; code baseline remains Python 3.12 |
| pnpm | 10.13.1 | npm SHA-512 integrity |
| uv | 0.12.0 | official Linux x64/arm64 and checksum-file SHA-256 values |
| Playwright | 1.62.1 Noble image | npm integrity, OCI index and Linux platform digests, and bundled browser revisions |
| Meilisearch CE | v1.53.0 | OCI index and Linux x64/arm64 digests |
| SearXNG | 2026.8.12-54613defc | OCI index and Linux x64/arm64 digests |
| Node and Python package sets | current frozen locks | local lockfile SHA-256 values |
| Native host compatibility | Fedora 44 reference host | `toolchain.lock.yaml` SHA-256 and exact observed versions |

Metadata came only from the upstream npm registry, Node distribution checksum list, Python download API, GitHub release API or source repository, Microsoft Container Registry, and the publishers' Docker Hub repositories. Resolution did not pull an image or start a container or browser.

`schema-generator-set` is resolved by `WX-M0-004` with pinned, licensed TypeScript and Python generators. Release mode remains red for `remaining-deployment-image-set`, which depends on the final service set owned by `WX-M0-012`. Optional models remain safely disabled until `WX-M10-001` and operator license review.
