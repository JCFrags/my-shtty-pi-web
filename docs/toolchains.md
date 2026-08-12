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

## Component lock preparation

`deploy/component-catalog.json` is the reviewed input. `deploy/component-lock.json` is deterministic generated output. Run `make component-lock-check` to reject drift.

Development mode records unresolved browser and image sets. Release mode rejects every enabled unresolved, floating, or invalid component. Optional models stay disabled until an operator selects and reviews exact local model files and licenses.
