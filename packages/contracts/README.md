# WebX contracts

This package contains the WebX JSON Schema 2020-12 contracts. It also contains the reference SQLite control-plane contract.

## Validation

Run the focused check from the repository root:

```bash
packages/contracts/check.sh
```

The check does these operations:

- checks every schema against the JSON Schema 2020-12 meta-schema;
- resolves every local `$ref` without network access;
- validates every mapped valid JSON or YAML example with format checks enabled;
- rejects the seeded invalid fixture at the exact JSON Pointer `/metadata/word_count`;
- builds the reference SQL in an in-memory SQLite database;
- confirms that the durable artifact commit-intent table is present.

The check script pins its focused validation dependencies. The M0 integration owner retains ownership of project manifests and lockfiles.

## M0 contract closure proposal

### Inert normalized content

`schemas/normalized-content-result.json` defines the strict, versioned result between an isolated hostile-content worker and `webxd`.

The contract has these boundaries:

- The normalized Markdown is an immutable daemon-controlled staging handle.
- The result contains only inert metadata, links, quality facts, provenance, labels, warnings, and evidence handles.
- Raw HTML and other hostile bytes remain referenced as staged evidence.
- The trusted daemon can verify and commit normalized text. It must not parse raw HTML.
- `additionalProperties: false` rejects an undeclared active-content or raw-body field.
- Every accepted result keeps the `untrusted_external_source` trust label.

This closes the plan gap without making a worker authoritative. `webxd` still decides acceptance, visibility, identity, commit, indexing, and wiki work.

### Durable artifact commit intent

`schemas/artifact-commit-intent.json` and `control-plane-schema.sql` define the journal that bridges filesystem rename and SQLite publication.

The lifecycle is:

```text
prepared -> renamed -> published -> completed
                    \-> quarantined
prepared ----------------> quarantined
renamed -----------------> quarantined
```

The writer must use this order:

1. Write, validate, hash, and `fsync` one same-filesystem staging tree.
2. Persist `prepared` with the final relative path, manifest hash, and expected file hashes.
3. Atomically rename the verified staging tree and persist `renamed`.
4. Publish receipt or page facts and projection outbox rows in one short SQLite transaction. Persist `published` in that transaction.
5. Persist `completed`.
6. On restart, verify the staging and final candidates against the intent. Adopt one fully valid tree and continue the lifecycle. Quarantine an invalid or ambiguous candidate.
7. Repeated recovery uses the unique idempotency key and final path. It must not create another page version or outbox item.

A filesystem rename is not treated as part of a SQLite rollback.

## Traceability

- Backlog: `WX-M0-003`
- Accepted plan closures: strict normalized-content result and durable artifact commit intent
- Requirements: `FR-051`, `FR-052`, `FR-063`, `NFR-M-003`, `NFR-C-004`, `NFR-S-007`
- Accepted decisions: ADR-0004, ADR-0011, ADR-0015
- Follow-on generation: `WX-M0-004`
- Follow-on API and worker protocol integration: `WX-M0-005`

Generated TypeScript and Python types are not hand-written in this item. The generation owner must consume these schemas after this contract is merged.
