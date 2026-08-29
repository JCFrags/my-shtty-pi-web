# Repository surgery plan

This classification uses product fit, not sunk cost. Phase 0 does not delete production browser code.

## Retain substantially

These paths already form useful non-browser or boundary code. They need normal protocol updates, not structural retention of the old browser engine.

- `apps/pi-webx/src/audit.ts`
- `apps/pi-webx/src/modes.ts`
- `apps/pi-webx/src/output.ts`
- `apps/pi-webx/src/sdk.ts`
- `apps/pi-webx/tests/audit.test.ts`
- `apps/webxd/src/cache.ts`
- `apps/webxd/src/content-store.ts`
- `apps/webxd/src/destination-authority.ts`
- `apps/webxd/src/local-json-client.ts`
- `apps/webxd/src/passage-selector.ts`
- `apps/webxd/test/cache.test.ts`
- `apps/webxd/test/content-store.test.ts`
- `apps/webxd/test/destination-authority.test.ts`
- `apps/webxd/test/local-json-client.test.ts`
- `apps/webxd/test/passage-selector.test.ts`
- `packages/artifacts/`
- `packages/policy/`
- `packages/test-fixtures/`
- `components/browser/services/reader/`
- `components/browser/services/crawl/`
- `components/browser/services/docling/`
- `components/browser/benchmarks/extraction/`
- `components/browser/tests/reader/`
- `components/browser/tests/docling/`
- `components/browser/scripts/secure_egress_proxy.py`
- Search, read, document, cache, installation-profile, and operation documents under `docs/` that do not prescribe the old browser adapter.

## Retain the concept but rewrite

These paths own the right product boundary or UI concept. Their browser portions should target the new protocol and screenshot-first model.

- `apps/pi-webx/src/index.ts`: retain the native Pi extension. Rewrite browser tool guidance and request fields around screenshot-first observe, explicit fallback, explicit IDs, operations, and cancellation.
- `apps/pi-webx/src/schemas.ts`: replace browser schemas. Keep search/read schemas.
- `apps/pi-webx/skills/webx/SKILL.md`: change browser flow from semantic-first to screenshot-first.
- `apps/pi-webx/README.md`: update browser contract.
- `apps/webxd/src/authority.ts`: retain one local authority concept. Move browser authority to the persistent TypeScript runtime.
- `apps/webxd/src/runtime.ts`: integrate browser runtime health without tying search/read health to Chrome.
- `apps/webxd/src/main.ts`, `apps/webxd/src/index.ts`, and matching tests: expose the new internal protocol.
- `apps/webxd/src/browser-daemon-port.ts`: replace the Rust daemon adapter with direct runtime ownership or a small in-process module boundary.
- `packages/sdk/src/client.ts`, `packages/sdk/src/facade.ts`, `packages/sdk/src/types.ts`, and SDK tests: retain the canonical client. Replace browser request and event types.
- `components/browser/apps/workspace/`: retain a Tauri desktop workspace, but rewrite its model and viewport to render explicit screenshot frames. Keep Tauri as a shell only.
- `components/browser/fixtures/`: retain useful fixture ideas. Move browser-runtime fixtures to a TypeScript-owned test package and make screenshot/cursor assertions deterministic.
- `components/browser/tests/workspace/human-control-contract.test.mjs`: retain takeover intent. Rewrite around control epochs and explicit frame identity.
- `install/profiles/browser.json`, browser portions of `install/profiles/full.json`, `install-fedora.sh`, `uninstall-fedora.sh`, and `scripts/pi-web-doctor.mjs`: replace Rust/adapter dependencies with Node runtime, Chrome, and workspace checks.
- `components/browser/deploy/desktop/pi-browser-workspace.desktop`: retain launcher concept after workspace replacement.
- `components/browser/LICENSE`: retain repository licensing where still applicable. Add AgentCursor notice beside the port.

## Delete after replacement gates pass

These paths implement the disposable adapter/coordinator architecture or duplicate the future TypeScript runtime. Delete them only after the Phase 1–4 gates in `IMPLEMENTATION-PLAN.md` pass.

- `components/browser/crates/browserd/`
- `components/browser/crates/protocol/`
- `components/browser/crates/backend-core/`
- `components/browser/crates/backend-agent-browser/`
- `components/browser/crates/backend-pinchtab/`
- `components/browser/crates/artifact-store/` after the retained TypeScript artifact package covers browser frame needs.
- `components/browser/crates/reader-client/` after `webxd` owns the retained reader client directly.
- `components/browser/packages/browserd-reference/`
- `components/browser/packages/protocol-ts/` after the new runtime protocol package replaces it.
- `components/browser/packages/result-format/` if no non-browser caller remains.
- `components/browser/packages/test-fixtures/` after fixtures move to the new runtime or root fixture package.
- `components/browser/scripts/lib/agent-browser.mjs`
- `components/browser/scripts/lib/pinchtab.mjs`
- `components/browser/scripts/benchmark-agent-browser.mjs`
- `components/browser/tests/backends/agent-browser-contract.test.mjs`
- `components/browser/tests/backends/agent-browser-cua.test.mjs`
- `components/browser/tests/backends/agent-browser-real.test.mjs`
- `components/browser/tests/backends/pinchtab-contract.test.mjs`
- `components/browser/tests/multi-agent/reference-boundary.test.mjs` after equivalent explicit-target tests pass.
- `components/browser/tests/observations/contracts.test.mjs` and `components/browser/tests/observations/corpus.json` after screenshot-first observation tests replace them.
- `components/browser/tools/stream-viewer/` after the rewritten Tauri workspace passes frame switching.
- `components/browser/schema/protocol.schema.json` and `components/browser/schema/conformance-fixtures.json` after the new TypeScript protocol schema and conformance tests are authoritative.
- Browser-only entries in `components/browser/Cargo.toml`, `components/browser/Cargo.lock`, `components/browser/rust-toolchain.toml`, `components/browser/VERSION_PINS.toml`, `components/browser/deploy/profiles.toml`, and `components/browser/deploy/versions.env`.
- Old browser sections in `components/browser/docs/architecture.md`, `components/browser/docs/protocol.md`, `components/browser/docs/upstream.md`, and `components/browser/README.md` after the rebuild documents become current operational documents.

Do not retain PinchTab as an initial alternate browser authority. It adds a second behavior model and weakens the one-path acceptance gate. A later adapter can return only through the same explicit protocol and tests.

## Unrelated to the browser rebuild

Do not move or rewrite these because of this project:

- `.github/workflows/ci.yml`, except to add the new package’s test command.
- `FUTURE_FEATURES.md`
- General search/read portions of `README.md`.
- `docs/canonical-content-record.md`
- `docs/reader-runtime-boundaries.md`
- `docs/webxd-local-json-boundary.md`
- `packages/policy/storage.mjs` and storage declarations, except for a reviewed browser artifact limit.
- `scripts/live-web-acceptance.ts`
- `scripts/storage-policy-contract.test.mjs`
- SearXNG files under `components/browser/deploy/searxng/` and `components/browser/deploy/quadlet/pi-web-searxng.container`.
- Extraction corpus and reports.

## Smallest clean final structure

```text
apps/
  pi-webx/                    # native Pi extension
  webxd/                      # search/read authority and runtime composition
  browser-workspace/          # Tauri shell + local frame UI
packages/
  sdk/                        # canonical client and public types
  policy/                     # destination and storage policy
  artifacts/                  # controlled artifacts
  browser-protocol/           # internal schemas, events, errors
  browser-runtime/            # lifecycle, registry, operations, CDP, frames
    src/agentcursor-port/      # pinned selective MIT port
  test-fixtures/              # deterministic local fixtures
services/
  reader/
  crawl/
  docling/
docs/browser-rebuild/
install/
spikes/screenshot-first-browser/  # retained until production parity, then archived or removed
```

`webxd` can import `browser-runtime` in-process at first. Split it into another Node service only if crash containment or packaging measurements justify the extra process. Do not create a Rust daemon, MCP server, CLI adapter, extension bridge, or alternate browser backend by default.

## Deletion gate

Delete old production browser code only when the new runtime passes explicit ownership, two-browser concurrency, screenshot observation, pointer overlay, DOM fallback, cancellation, takeover, crash cleanup, workspace switching, Fedora install, and native Pi end-to-end tests. Make one focused deletion commit. The rollback is the prior commit and service selection, not permanent parallel stacks.
