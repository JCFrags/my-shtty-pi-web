# Maintenance scripts

- `live-web-acceptance.ts`: live capability acceptance harness. Run it with `pnpm test:live`.
- `pi-web-audit.mjs`: lists, displays, and prunes real `web_search` and `web_read` audit records through `pi-web audit`.
- `pi-package-stage`: stages the Pi extension package.
- `pi-package-cutover`: activates a staged Pi extension package.

Use the root installer for normal installation. The staging scripts are low-level maintenance helpers.
