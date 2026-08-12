# Quality targets and selectors

`WX-M0-010` supplies four stable, check-only Make targets:

```sh
make format
make lint
make typecheck
make test-unit
```

The targets call one fixed dispatcher. They stop at the first failed check. They do not retry or rewrite source.

## AREA selector

Use one optional lowercase `AREA` value:

```sh
make lint AREA=contracts
```

Accepted values are:

- `all` (default);
- `typescript`;
- `python`;
- `sql`;
- `shell`;
- `docs`;
- `contracts`;
- `fixtures`;
- `compose`;
- `tooling`.

Unknown, path-like, option-like, whitespace-bearing, comma-separated, or shell-like values fail before a tool starts. A selected target with no applicable project fails. It does not silently pass.

`AC` and `PROFILE` are reserved for later acceptance orchestration. A non-empty value fails in these four targets. `WX-M0-013` owns their future registry.

## Routing

- TypeScript and JavaScript use pinned ESLint, TypeScript, and Node/Vitest-compatible fixture tests.
- Python uses pinned Ruff, mypy, pytest, and unittest. Pre-existing validators keep narrow, named Ruff or mypy boundary exceptions while their executable validation suites remain mandatory.
- SQL uses first-party deterministic format rules and SQLite parsing.
- Shell uses check-only format rules, the declared shell syntax parser, and an unquoted-expansion security rule.
- Markdown uses check-only format, heading, fence, and release-marker rules.
- Contract checks include canonical schema and OpenAPI validation, deterministic schema/OpenAPI drift, generated TypeScript compile, generated Python import, SQLite, and recovery checks.
- Compose checks include Ruff lint, named mypy boundary checks, profile and safety validation, and five focused tests with seven negative fixtures. The merged Compose Python files are not yet in canonical Ruff format, so format applies the common check-only text rules without rewriting them.
- Generated source is not formatted or linted directly. Both contract generators check its exact bytes.

The first-party common rules implement `WX-M0-010`. They require UTF-8 text, a final newline, no trailing whitespace, and no release-critical `TODO` or `FIXME` without a `WX-Mn-NNN` backlog ID.

## Seeded negative proof

`scripts/quality_check_test.py` creates isolated temporary violations. It covers TypeScript, Python, SQL, shell, Markdown, selectors, type failures, unit failures, release markers, schema-generated drift, and OpenAPI-generated drift. It verifies that each test leaves repository status unchanged.
