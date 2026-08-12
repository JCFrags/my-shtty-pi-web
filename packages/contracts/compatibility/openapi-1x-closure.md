# OpenAPI 1.x closure

## Disposition

WebX 1.x uses two canonical OpenAPI 3.1 documents:

- `openapi.yaml` defines the public API for the SDK, CLI, Pi package, and local integrations.
- `worker-openapi.yaml` defines the internal worker and egress protocol.

The public contract now has one stable `operationId` for each normative HTTP operation. It has 97 operations. This includes system, search, retrieval, browser, crawl, document, media, upload, artifact, page, visit, archive, monitoring, job, index, wiki, corpus, backup, restore, audit, and configuration operations.

The canonical document includes the 20 routes shipped by the daemon and SDK facade. These routes use the shipped camel-case data shapes. All request and response objects reject unknown fields. Each mutation requires `Idempotency-Key`. The route metadata fixes the enforced scope and byte limits. The version response fixes API major 1 and browser protocol 2. The capability catalog fixes exactly `agent-browser/chrome` and `pinchtab/chrome` in that order.

The worker contract has 10 stable operations. Its completion request can reference `schemas/normalized-content-result.json` through `normalized_content_result`.

## Version identity

The public path major is `/v1`. The public document uses `info.version: 1.0.0` and `x-webx-api-major: 1`.

The worker server path is `/internal/v1`. The worker document uses `info.version: 1.0.0` and `x-webx-protocol-major: 1`.

Minor releases can add optional operations and fields. A required-field addition, field meaning change, removal, or incompatible path change needs a new major version.

## Authority boundary

A worker completion is evidence. It is not final admission.

`normalized_content_result` references a strict inert schema. Raw HTML stays in staged evidence handles. The result keeps the `untrusted_external_source` trust label. It cannot select visibility, canonical identity, final artifact paths, index work, or wiki work.

Worker-produced schemas do not contain `accepted` or `rejection_reasons`. Only `webxd` decides final admission after it verifies the observation, normalized content, staged bytes, and policy snapshot.

## Generated clients and handlers

`scripts/generate_openapi.py` reads both canonical documents. It generates:

- TypeScript client and server handler interfaces;
- Python client protocols;
- stable operation descriptors;
- canonical JSON Schema type mappings for TypeScript;
- document and schema hashes in `generated/openapi/traceability.json`.

The operation stubs do not define duplicate data transfer objects. Canonical external schema references map to the existing JSON-Schema-generated TypeScript types.

## Compatibility and drift checks

`validate_openapi.py` checks:

- OpenAPI 3.1 and major identity;
- the complete normative operation inventory;
- the exact 20-route shipped inventory, scopes, idempotency, limits, strict objects, and browser identities;
- unique stable `operationId` values;
- exact path parameter declarations;
- local reference resolution;
- operation scopes, request limits, and examples;
- the normalized-content boundary;
- absence of worker acceptance authority.

`tests/generated/check_openapi_generated.py` checks every generated operation, document and schema hashes, two-run determinism, clean regeneration, seeded drift failure, and Python imports. The TypeScript smoke compiles public and worker client/server interfaces together with canonical JSON-Schema-generated types.

## Traceability

- Backlog: `WX-M0-005`
- Dependencies: `WX-M0-003`, `WX-M0-004`
- Accepted plan closure: normative 1.x OpenAPI operation gap
- Requirements: `FR-001`, `FR-002`, `FR-003`, `FR-150`, `NFR-C-003`, `NFR-C-004`, `NFR-M-003`, `NFR-M-004`
- Accepted decisions: ADR-0001, ADR-0002, ADR-0012
