# Maintenance scripts

- `pi-web-stage`: creates one isolated release at `~/.local/lib/pi-web-tools-releases/COMMIT`. It uses locked dependencies and does not change the installed stack.
- `pi-web-smoke.ts`: runs the deterministic candidate gate. Add `--live` to run the finite live core checks after the deterministic checks.
- `pi-web-cutover`: supports `--plan`, `--apply`, and `--rollback RUN_ID`. It records exact prior paths and user-service state.
- `pi-web-doctor.mjs`: checks core authority capabilities.
- `pi-web-audit.mjs`: lists, displays, and prunes real `web_search` and `web_read` audit records.
- `live-web-acceptance.ts`: runs the broader installed-stack live acceptance suite with `pnpm test:live`.
- `pi-package-stage` and `pi-package-cutover`: low-level Pi extension package helpers. They do not replace the full product staging and cutover tools.

Run M7 contract tests without changing the installed stack:

```bash
node --test scripts/m7-contract.test.mjs
```

See [`docs/operations-fedora.md`](../docs/operations-fedora.md) for exact staging, smoke, cutover, verification, and rollback commands.
