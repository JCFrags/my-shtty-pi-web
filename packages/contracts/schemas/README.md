# JSON Schema catalog

All schemas use JSON Schema 2020-12. Schema IDs are stable under `https://webx.local/schemas/v1/`.

| File | Contract |
|---|---|
| `artifact-commit-intent.json` | Durable filesystem and SQLite commit journal; requires the package semantic contract |
| `artifact-result.json` | Common artifact-producing operation result |
| `common.json` | Shared IDs, hashes, timestamps, visibility, warnings, and references |
| `engine-observation.json` | Worker evidence only; final admission is absent and daemon-owned |
| `error.json` | Stable problem-details error envelope |
| `event.json` | Versioned event envelope |
| `job.json` | Durable job record |
| `model-runtimes-config.json` | Local model runtime configuration |
| `normalized-content-result.json` | Strict inert hostile-worker normalized-content result |
| `page-record.json` | Canonical page record |
| `permissions-config.json` | Permission configuration |
| `retention-config.json` | Retention configuration |
| `search-hit.json` | Normalized search result |
| `visit-record.json` | Top-level visit record |
| `webx-config.json` | Main WebX configuration |
| `wiki-intake.json` | Wiki source delivery envelope |

Run the package validator documented in `../README.md`. The validator resolves references from the local schema registry. It does not fetch a schema from the network.

JSON Schema cannot compare prior and next database rows. It also cannot require uniqueness by one object property. The mandatory rules for those cases are in `../semantics/artifact-commit-intent-semantics.json`. The focused validator applies and tests them.
