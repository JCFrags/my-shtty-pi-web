# WebX contracts

This package contains the WebX JSON Schema 2020-12 contracts and canonical public and worker OpenAPI 3.1 documents. It also contains the reference SQLite control-plane contract and mandatory semantic contracts.

## Validation

Run the focused check from the repository root:

```bash
packages/contracts/check.sh
```

The check does these operations:

- checks every schema against the JSON Schema 2020-12 meta-schema;
- resolves every local `$ref` without network access;
- validates every mapped valid JSON or YAML example with format checks enabled;
- validates all 86 public and 10 worker OpenAPI operations, local references, major identity, metadata, and path parameters;
- checks the strict normalized-content result in worker completion and rejects worker acceptance authority;
- runs the mandatory commit-intent semantic validator;
- rejects all mapped negative fixtures at exact JSON Pointer paths;
- builds the reference SQL in an in-memory SQLite database;
- tests every allowed and forbidden commit-intent state transition;
- tests terminal row immutability and repeated recovery idempotency;
- runs a restart-boundary SQL/application recovery harness for five publication effects.

The root `pnpm-lock.yaml` and `uv.lock` pin the selected generators and their transitive dependencies. `generator-lock.json` records generator licenses, sources, and immutable registry artifact identities.

## Generated types

`generated/typescript/` and `generated/python/` contain deterministic types for all 16 canonical JSON Schemas. Do not edit these files. Do not create hand-written duplicate data transfer objects.

Run generation and drift checks from the repository root:

```bash
python3 packages/contracts/scripts/generate_types.py
python3 packages/contracts/scripts/generate_types.py --check
python3 packages/contracts/tests/generated/check_generated.py
```

The selected generators are:

- `json-schema-to-typescript` 15.0.4, MIT;
- `jsonschema-gentypes` 2.12.0, BSD-2-Clause.

`generated/traceability.json` maps each canonical schema and SHA-256 to one TypeScript output and one Python output. The focused check runs two isolated generations, checks clean regeneration, verifies a seeded drift failure and exact diagnostic, compiles the TypeScript smoke, imports every Python module, and checks protected fields.

## Generated OpenAPI operation stubs

`openapi.yaml` is the canonical public 1.x API. `worker-openapi.yaml` is the canonical internal 1.x worker and egress protocol. Every operation has a stable `operationId`, scope metadata, request and response byte limits, and an operation example.

`scripts/generate_openapi.py` creates deterministic TypeScript client/server interfaces and Python client protocols in `generated/openapi/`. It also creates operation descriptors and `generated/openapi/traceability.json`. The trace records canonical document hashes, all operation IDs, and the JSON Schema hashes used by generated TypeScript schema mappings.

Run generation and drift checks from the repository root:

```bash
uv run --no-project --with 'pyyaml==6.0.3' python packages/contracts/scripts/generate_openapi.py
uv run --no-project --with 'pyyaml==6.0.3' python packages/contracts/scripts/generate_openapi.py --check
```

The OpenAPI stubs do not create duplicate DTOs. External schema references use the existing JSON-Schema-generated TypeScript types. The compatibility disposition and operation-gap traceability are in `compatibility/openapi-1x-closure.md`.

## Worker observation authority

`schemas/engine-observation.json` is worker-produced evidence. It has no final admission field.

The corrected contract rejects `accepted` and `rejection_reasons`. Only `webxd` can record final admission after it validates worker evidence and normalized content. The compatibility disposition is in `compatibility/engine-observation-authority.md`.

The `engine_observations.accepted` SQLite field remains daemon-owned post-admission state. A worker value must never populate it.

## Inert normalized content

`schemas/normalized-content-result.json` defines the strict, versioned result between an isolated hostile-content worker and `webxd`.

The contract has these boundaries:

- The normalized Markdown is an immutable daemon-controlled staging handle.
- The result contains only inert metadata, links, quality facts, provenance, labels, warnings, and evidence handles.
- Raw HTML and other hostile bytes remain referenced as staged evidence.
- The trusted daemon can verify and commit normalized text. It must not parse raw HTML.
- `additionalProperties: false` rejects an undeclared active-content, authority, visibility, or raw-body field.
- Every normalized result keeps the `untrusted_external_source` trust label.
- A normalized Markdown handle cannot also identify raw evidence.

This contract does not make a worker authoritative. `webxd` decides acceptance, visibility, identity, commit, indexing, and wiki work.

## Durable artifact commit intent

`schemas/artifact-commit-intent.json`, `semantics/artifact-commit-intent-semantics.json`, and `control-plane-schema.sql` define the journal that bridges filesystem rename and SQLite publication.

### Allowed paths

The contract binds each path to a daemon-owned root:

- staging: `staging/commit-intents/<commit_intent_id>`;
- visit receipt final tree: `visits/`;
- page version final tree: `pages/`;
- general artifact final tree: `artifacts/`;
- wiki envelope final tree: `wiki/outbox/`;
- quarantine: `quarantine/commit-intents/<commit_intent_id>/`.

The mandatory semantic validator also binds the staging and quarantine path IDs to `commit_intent_id`. It rejects a duplicate `expected_files.relative_path` before persistence or recovery.

### State machine

The only state changes are:

```text
prepared  -> renamed | quarantined
renamed   -> published | quarantined
published -> completed | quarantined
completed -> no state
quarantined -> no state
```

`completed` and `quarantined` rows are terminal and immutable. SQLite triggers reject skipped, reverse, and terminal writes. The application must apply the same state table before a write.

Repeated terminal recovery returns the existing state and publication without a write. Each recovery uses the existing intent `idempotency_key`. Each publication effect uses `commit-intent:<commit_intent_id>`. A repeated recovery must not create another visit receipt, page version, artifact, index projection, or wiki delivery.

`tests/repeated_publication_recovery.py` is the representative SQL/application-contract harness. It commits all five effects and the `published` intent state in one transaction. It closes the database before intent completion to simulate process loss. It opens the database again and replays recovery twice. It asserts one stable row, effect ID, and publication key for every effect.

### Quarantine diagnostics

Quarantine uses a stable `quarantine_reason_code`. Allowed codes are:

- `STAGING_MISSING`;
- `FINAL_MISSING`;
- `HASH_MISMATCH`;
- `MANIFEST_MISMATCH`;
- `PATH_CONFLICT`;
- `AMBIGUOUS_CANDIDATES`;
- `UNSAFE_PATH`;
- `PUBLICATION_CONFLICT`;
- `RECOVERY_INVARIANT_VIOLATION`.

`quarantine_safe_detail` is optional. It has a 500-character limit and rejects control characters. It must not contain source bodies, tokens, credentials, or private path data.

### Commit order

1. Write, validate, hash, and `fsync` one same-filesystem staging tree.
2. Persist `prepared` with the final relative path, manifest hash, and unique expected file paths.
3. Atomically rename the verified staging tree and persist `renamed`.
4. Publish receipt or page facts and projection outbox rows in one short SQLite transaction. Persist `published` in that transaction.
5. Persist `completed`.
6. On restart, verify the staging and final candidates against the intent. Adopt one fully valid tree and continue the lifecycle. Quarantine an invalid or ambiguous candidate with a stable reason code.
7. Return an existing terminal result without a write when recovery repeats.

A filesystem rename is not treated as part of a SQLite rollback.

## Traceability

- Backlog: `WX-M0-003`
- Accepted plan closures: strict normalized-content result and durable artifact commit intent
- Requirements: `FR-051`, `FR-052`, `FR-063`, `NFR-M-003`, `NFR-C-004`, `NFR-S-007`
- Accepted decisions: ADR-0004, ADR-0011, ADR-0015
- Worker authority correction: `compatibility/engine-observation-authority.md`
- Follow-on generation: `WX-M0-004`
- API and worker protocol integration: `WX-M0-005`
- OpenAPI closure disposition: `compatibility/openapi-1x-closure.md`

Generated JSON Schema and OpenAPI outputs are deterministic. Do not edit generated files by hand.
