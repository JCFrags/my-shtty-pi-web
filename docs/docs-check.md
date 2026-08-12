# Documentation validation

Run the deterministic documentation gate from the repository root:

```sh
make docs-check
```

The command uses only the Python standard library. It does not contact the network or change repository files.

## Validation scope

The gate validates:

- repository-local inline Markdown links;
- Markdown heading and explicit HTML anchors;
- references to functional requirement, non-functional requirement, ADR, acceptance, and backlog IDs;
- the accepted backlog CSV header and row fields;
- unique and well-formed backlog IDs;
- milestone, priority, size, and status values;
- requirement and acceptance references in backlog rows;
- missing, duplicate, self, later-milestone, and cyclic backlog dependencies;
- the accepted acceptance-matrix CSV header, IDs, and required fields.

The link and ID scans cover Markdown that exists in the repository. They do not require documents assigned to a later milestone.

## Normative fixtures

`scripts/docs_fixtures/normative/` contains read-only validation fixtures copied or derived from the accepted specification:

- `backlog.csv` is an LF-normalized copy of the accepted executable backlog;
- `acceptance-matrix.csv` is an LF-normalized copy of the accepted acceptance registry;
- `id-catalog.json` records accepted requirement and ADR IDs, source paths, source hashes, and the accepted plan hash.

Update these fixtures only when the accepted specification changes through its owning process. Do not derive validity from IDs that appear only in implementation prose.

## Diagnostics

Each failure names its path and line when available. The command returns status 1 for validation failures and status 2 for an invalid validator configuration or unreadable required fixture.

The Make target also runs seeded tests for a broken link, a missing anchor, a duplicate backlog ID, an unknown dependency, a dependency cycle, a self-dependency, and an unknown reference ID. Run the tests directly with:

```sh
python3 scripts/docs_check_test.py
```
