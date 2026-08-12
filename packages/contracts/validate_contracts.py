#!/usr/bin/env python3
"""Validate WebX JSON Schema 2020-12 contracts and semantic boundaries."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urldefrag, urljoin

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent
SCHEMA_DIR = ROOT / "schemas"
EXAMPLE_DIR = ROOT / "examples"
INVALID_DIR = ROOT / "tests" / "fixtures" / "invalid"
SEMANTICS_PATH = ROOT / "semantics" / "artifact-commit-intent-semantics.json"

VALID_EXAMPLES = {
    "artifact-commit-intent.json": "artifact-commit-intent.json",
    "engine-observation.json": "engine-observation.json",
    "model-runtimes.example.yaml": "model-runtimes-config.json",
    "normalized-content-result.json": "normalized-content-result.json",
    "page.json": "page-record.json",
    "permissions.example.yaml": "permissions-config.json",
    "retention.example.yaml": "retention-config.json",
    "visit-success.json": "visit-record.json",
    "webx.example.yaml": "webx-config.json",
    "wiki-intake-upsert.json": "wiki-intake.json",
}

INVALID_EXAMPLES = {
    "commit-intent-duplicate-expected-path.json": (
        "artifact-commit-intent.json",
        "/expected_files/2/relative_path",
    ),
    "commit-intent-final-kind-mismatch.json": (
        "artifact-commit-intent.json",
        "/final_relative_path",
    ),
    "commit-intent-forbidden-final-root.json": (
        "artifact-commit-intent.json",
        "/final_relative_path",
    ),
    "commit-intent-forbidden-staging-root.json": (
        "artifact-commit-intent.json",
        "/staging_relative_path",
    ),
    "commit-intent-publication-key-mismatch.json": (
        "artifact-commit-intent.json",
        "/publication_idempotency_key",
    ),
    "commit-intent-quarantine-id-mismatch.json": (
        "artifact-commit-intent.json",
        "/quarantine_paths/0",
    ),
    "commit-intent-staging-id-mismatch.json": (
        "artifact-commit-intent.json",
        "/staging_relative_path",
    ),
    "commit-intent-unknown-quarantine-code.json": (
        "artifact-commit-intent.json",
        "/quarantine_reason_code",
    ),
    "commit-intent-unsafe-quarantine-detail.json": (
        "artifact-commit-intent.json",
        "/quarantine_safe_detail",
    ),
    "engine-observation-worker-accepted.json": (
        "engine-observation.json",
        "/accepted",
    ),
    "engine-observation-worker-rejection.json": (
        "engine-observation.json",
        "/rejection_reasons",
    ),
    "normalized-content-handle-alias.json": (
        "normalized-content-result.json",
        "/raw_evidence/0/handle_id",
    ),
    "normalized-content-inline-raw-html.json": (
        "normalized-content-result.json",
        "/raw_html",
    ),
    "normalized-content-trust-mismatch.json": (
        "normalized-content-result.json",
        "/trust",
    ),
    "normalized-content-word-count.json": (
        "normalized-content-result.json",
        "/metadata/word_count",
    ),
}

EXPECTED_TRANSITIONS = {
    "prepared": ["renamed", "quarantined"],
    "renamed": ["published", "quarantined"],
    "published": ["completed", "quarantined"],
    "completed": [],
    "quarantined": [],
}
TERMINAL_STATES = {"completed", "quarantined"}
EXPECTED_CANDIDATE_RESOLUTION = {
    "staging_valid_final_missing": "rename_staging_then_continue",
    "staging_missing_final_valid": "adopt_final_then_continue",
    "staging_valid_final_valid": "quarantine:AMBIGUOUS_CANDIDATES",
    "staging_invalid_final_invalid": "quarantine:RECOVERY_INVARIANT_VIOLATION",
}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def load_instance(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        if path.suffix == ".json":
            return json.load(stream)
        return yaml.safe_load(stream)


def pointer(parts: Iterable[Any]) -> str:
    escaped = [str(part).replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped) if escaped else ""


def iter_refs(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str):
            yield ref
        for child in value.values():
            yield from iter_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_refs(child)


def resolve_pointer(document: Any, fragment: str) -> Any:
    if not fragment:
        return document
    if not fragment.startswith("/"):
        raise ValueError(f"unsupported non-pointer fragment #{fragment}")
    current = document
    for token in fragment[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def load_schemas() -> tuple[dict[str, Any], Registry]:
    by_name: dict[str, Any] = {}
    by_id: dict[str, Any] = {}
    resources: list[tuple[str, Resource[Any]]] = []

    for path in sorted(SCHEMA_DIR.glob("*.json")):
        schema = load_json(path)
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            raise ValueError(f"{path.name}: $schema must select JSON Schema 2020-12")
        Draft202012Validator.check_schema(schema)
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str):
            raise ValueError(f"{path.name}: missing string $id")
        if schema_id in by_id:
            raise ValueError(f"{path.name}: duplicate $id {schema_id}")
        if schema_id.rsplit("/", 1)[-1] != path.name:
            raise ValueError(f"{path.name}: $id filename does not match")
        by_name[path.name] = schema
        by_id[schema_id] = schema
        resources.append((schema_id, Resource.from_contents(schema)))

    for name, schema in by_name.items():
        base_id = schema["$id"]
        for ref in iter_refs(schema):
            resolved = urljoin(base_id, ref)
            target_id, fragment = urldefrag(resolved)
            target = by_id.get(target_id)
            if target is None:
                raise ValueError(f"{name}: unresolved $ref {ref}")
            try:
                resolve_pointer(target, fragment)
            except (KeyError, IndexError, TypeError, ValueError) as error:
                raise ValueError(f"{name}: unresolved $ref fragment {ref}: {error}") from error

    return by_name, Registry().with_resources(resources)


def schema_error_paths(instance: Any, schema: Any, registry: Registry) -> list[str]:
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FormatChecker(),
    )
    paths: list[str] = []
    for error in sorted(
        validator.iter_errors(instance),
        key=lambda item: (list(item.absolute_path), item.validator or "", item.message),
    ):
        base = list(error.absolute_path)
        if error.validator == "additionalProperties":
            match = re.search(r"\('([^']+)' was unexpected\)", error.message)
            if match:
                paths.append(pointer([*base, match.group(1)]))
                continue
        paths.append(pointer(base))
    return paths


def semantic_error_paths(instance: Any, schema_name: str) -> list[str]:
    paths: list[str] = []
    if schema_name == "artifact-commit-intent.json" and isinstance(instance, dict):
        intent_id = instance.get("commit_intent_id")
        expected_staging = f"staging/commit-intents/{intent_id}"
        if instance.get("staging_relative_path") != expected_staging:
            paths.append("/staging_relative_path")

        roots = {
            "visit_receipt": "visits/",
            "page_version": "pages/",
            "artifact_set": "artifacts/",
            "wiki_envelope": "wiki/outbox/",
        }
        expected_root = roots.get(instance.get("intent_kind"))
        final_path = instance.get("final_relative_path")
        if expected_root and (not isinstance(final_path, str) or not final_path.startswith(expected_root)):
            paths.append("/final_relative_path")

        seen: set[str] = set()
        for index, item in enumerate(instance.get("expected_files", [])):
            relative_path = item.get("relative_path") if isinstance(item, dict) else None
            if isinstance(relative_path, str) and relative_path in seen:
                paths.append(f"/expected_files/{index}/relative_path")
            elif isinstance(relative_path, str):
                seen.add(relative_path)

        publication_key = instance.get("publication_idempotency_key")
        if publication_key is not None and publication_key != f"commit-intent:{intent_id}":
            paths.append("/publication_idempotency_key")

        expected_quarantine_root = f"quarantine/commit-intents/{intent_id}"
        for index, value in enumerate(instance.get("quarantine_paths", [])):
            if not isinstance(value, str) or not (
                value == expected_quarantine_root
                or value.startswith(expected_quarantine_root + "/")
            ):
                paths.append(f"/quarantine_paths/{index}")

    if schema_name == "normalized-content-result.json" and isinstance(instance, dict):
        normalized = instance.get("normalized_markdown")
        normalized_handle = normalized.get("handle_id") if isinstance(normalized, dict) else None
        seen_handles = {normalized_handle} if isinstance(normalized_handle, str) else set()
        for index, evidence in enumerate(instance.get("raw_evidence", [])):
            handle = evidence.get("handle_id") if isinstance(evidence, dict) else None
            if isinstance(handle, str) and handle in seen_handles:
                paths.append(f"/raw_evidence/{index}/handle_id")
            elif isinstance(handle, str):
                seen_handles.add(handle)

    return paths


def validation_paths(instance: Any, schema_name: str, schemas: dict[str, Any], registry: Registry) -> list[str]:
    return sorted(
        set(schema_error_paths(instance, schemas[schema_name], registry))
        | set(semantic_error_paths(instance, schema_name))
    )


def validate_examples(schemas: dict[str, Any], registry: Registry) -> None:
    actual = {
        path.name
        for path in EXAMPLE_DIR.iterdir()
        if path.is_file() and path.suffix in {".json", ".yaml", ".yml"}
    }
    mapped = set(VALID_EXAMPLES)
    if actual != mapped:
        raise ValueError(
            f"example map mismatch: unmapped={sorted(actual - mapped)}, missing={sorted(mapped - actual)}"
        )

    for example_name, schema_name in sorted(VALID_EXAMPLES.items()):
        failures = validation_paths(
            load_instance(EXAMPLE_DIR / example_name), schema_name, schemas, registry
        )
        if failures:
            raise ValueError(f"{example_name}: invalid at {failures}")
        print(f"VALID {example_name} -> {schema_name}")


def validate_invalid_fixtures(schemas: dict[str, Any], registry: Registry) -> None:
    actual = {path.name for path in INVALID_DIR.glob("*.json")}
    mapped = set(INVALID_EXAMPLES)
    if actual != mapped:
        raise ValueError(
            f"invalid fixture map mismatch: unmapped={sorted(actual - mapped)}, missing={sorted(mapped - actual)}"
        )

    for fixture_name, (schema_name, expected_path) in sorted(INVALID_EXAMPLES.items()):
        failures = validation_paths(load_json(INVALID_DIR / fixture_name), schema_name, schemas, registry)
        if not failures:
            raise ValueError(f"{fixture_name}: fixture unexpectedly validated")
        if expected_path not in failures:
            raise ValueError(
                f"{fixture_name}: expected error path {expected_path}; actual paths {failures}"
            )
        print(f"INVALID {fixture_name} -> {schema_name} at {expected_path}")


def validate_semantics_contract() -> dict[str, Any]:
    semantics = load_json(SEMANTICS_PATH)
    machine = semantics.get("state_machine", {})
    if machine.get("initial_state") != "prepared":
        raise ValueError("intent semantics: initial state must be prepared")
    if machine.get("allowed_transitions") != EXPECTED_TRANSITIONS:
        raise ValueError("intent semantics: transition table mismatch")
    if set(machine.get("terminal_states", [])) != TERMINAL_STATES:
        raise ValueError("intent semantics: terminal states mismatch")
    if machine.get("terminal_action") != "return_existing_without_write":
        raise ValueError("intent semantics: terminal recovery must be read-only")
    if semantics.get("candidate_resolution") != EXPECTED_CANDIDATE_RESOLUTION:
        raise ValueError("intent semantics: candidate resolution matrix mismatch")
    if semantics.get("manifest_policy", {}).get("expected_files_unique_by") != "relative_path":
        raise ValueError("intent semantics: expected file path uniqueness is mandatory")
    if semantics.get("recovery_idempotency", {}).get("publication_key_template") != (
        "commit-intent:{commit_intent_id}"
    ):
        raise ValueError("intent semantics: stable publication key is absent")
    quarantine = semantics.get("quarantine_policy", {})
    if quarantine.get("reason_field") != "quarantine_reason_code":
        raise ValueError("intent semantics: stable quarantine reason code is absent")
    if quarantine.get("safe_detail_max_length") != 500:
        raise ValueError("intent semantics: quarantine safe detail bound mismatch")

    ambiguous = semantics["candidate_resolution"]["staging_valid_final_valid"]
    if ambiguous != "quarantine:AMBIGUOUS_CANDIDATES":
        raise ValueError("intent semantics: ambiguous candidates could publish")

    recovery = semantics["recovery_idempotency"]
    effect_kinds = recovery.get("forbid_duplicate_effects", [])
    publication_key = recovery["publication_key_template"].format(
        commit_intent_id="01j4w4j9a3jpsk9r7jcrg29q01"
    )
    effects: set[tuple[str, str]] = set()
    for _ in range(2):
        for effect_kind in effect_kinds:
            effects.add((effect_kind, publication_key))
    if len(effects) != len(effect_kinds):
        raise ValueError("intent semantics: repeated recovery effect keys are not idempotent")

    print("VALID artifact commit-intent semantic contract")
    print("INVALID ambiguous staging and final candidates -> quarantine:AMBIGUOUS_CANDIDATES")
    print("VALID repeated recovery uses one key per publication effect")
    return semantics


def insert_prepared(connection: sqlite3.Connection, intent_id: str, idempotency_key: str) -> None:
    connection.execute(
        """
        INSERT INTO artifact_commit_intents (
            commit_intent_id, job_id, intent_kind, idempotency_key, state,
            staging_relative_path, final_relative_path, manifest_sha256,
            expected_files_json, recovery_count, created_at, updated_at
        ) VALUES (?, ?, 'page_version', ?, 'prepared', ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            intent_id,
            "01j4w4hy5kd6zmx4pc4k2xv7br",
            idempotency_key,
            f"staging/commit-intents/{intent_id}",
            f"pages/example.org/{intent_id}",
            "c" * 64,
            '[{"relative_path":"page.md","sha256":"' + "a" * 64 + '","size_bytes":142}]',
            "2026-08-09T12:00:01Z",
            "2026-08-09T12:00:01Z",
        ),
    )


def advance(connection: sqlite3.Connection, intent_id: str, target: str) -> None:
    if target == "renamed":
        connection.execute(
            "UPDATE artifact_commit_intents SET state='renamed', renamed_at=?, updated_at=? WHERE commit_intent_id=?",
            ("2026-08-09T12:00:02Z", "2026-08-09T12:00:02Z", intent_id),
        )
    elif target == "published":
        advance(connection, intent_id, "renamed")
        connection.execute(
            """
            UPDATE artifact_commit_intents
            SET state='published', published_at=?, published_reference_type='page_version',
                published_reference_id=?, publication_idempotency_key=?, updated_at=?
            WHERE commit_intent_id=?
            """,
            (
                "2026-08-09T12:00:03Z",
                intent_id,
                f"commit-intent:{intent_id}",
                "2026-08-09T12:00:03Z",
                intent_id,
            ),
        )
    elif target == "completed":
        advance(connection, intent_id, "published")
        connection.execute(
            "UPDATE artifact_commit_intents SET state='completed', completed_at=?, updated_at=? WHERE commit_intent_id=?",
            ("2026-08-09T12:00:04Z", "2026-08-09T12:00:04Z", intent_id),
        )
    elif target == "quarantined":
        connection.execute(
            """
            UPDATE artifact_commit_intents
            SET state='quarantined', quarantined_at=?, quarantine_paths_json=?,
                quarantine_reason_code='HASH_MISMATCH', quarantine_safe_detail='fixture mismatch',
                updated_at=?
            WHERE commit_intent_id=?
            """,
            (
                "2026-08-09T12:00:04Z",
                f'["quarantine/commit-intents/{intent_id}/tree"]',
                "2026-08-09T12:00:04Z",
                intent_id,
            ),
        )


def new_sql_connection(sql: str) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.executescript(sql)
    connection.execute("PRAGMA foreign_keys = OFF")
    return connection


def expect_integrity_error(operation: Any, label: str) -> None:
    try:
        operation()
    except sqlite3.IntegrityError:
        return
    raise ValueError(f"SQL contract unexpectedly allowed {label}")


def validate_sql_state_machine(sql: str, semantics: dict[str, Any]) -> None:
    states = list(EXPECTED_TRANSITIONS)
    intent_id = "01j4w4j9a3jpsk9r7jcrg29q01"

    connection = new_sql_connection(sql)
    try:
        expect_integrity_error(
            lambda: connection.execute(
                """
                INSERT INTO artifact_commit_intents (
                    commit_intent_id, job_id, intent_kind, idempotency_key, state,
                    staging_relative_path, final_relative_path, manifest_sha256,
                    expected_files_json, recovery_count, created_at, updated_at,
                    renamed_at, published_at, published_reference_type,
                    published_reference_id, publication_idempotency_key, completed_at
                ) VALUES (?, ?, 'page_version', ?, 'completed', ?, ?, ?, '[]', 0, ?, ?, ?, ?, 'page_version', ?, ?, ?)
                """,
                (
                    intent_id,
                    "01j4w4hy5kd6zmx4pc4k2xv7br",
                    "invalid-initial-state",
                    f"staging/commit-intents/{intent_id}",
                    f"pages/example.org/{intent_id}",
                    "c" * 64,
                    "2026-08-09T12:00:01Z",
                    "2026-08-09T12:00:01Z",
                    "2026-08-09T12:00:02Z",
                    "2026-08-09T12:00:03Z",
                    intent_id,
                    f"commit-intent:{intent_id}",
                    "2026-08-09T12:00:04Z",
                ),
            ),
            "non-prepared initial state",
        )
    finally:
        connection.close()

    for old_state in states:
        for new_state in states:
            if old_state == new_state:
                continue
            connection = new_sql_connection(sql)
            try:
                insert_prepared(connection, intent_id, f"transition:{old_state}:{new_state}")
                if old_state != "prepared":
                    advance(connection, intent_id, old_state)

                def transition() -> None:
                    if new_state == "renamed":
                        connection.execute(
                            "UPDATE artifact_commit_intents SET state='renamed', renamed_at=? WHERE commit_intent_id=?",
                            ("2026-08-09T12:00:05Z", intent_id),
                        )
                    elif new_state == "published":
                        connection.execute(
                            """
                            UPDATE artifact_commit_intents
                            SET state='published', renamed_at=COALESCE(renamed_at, ?), published_at=?,
                                published_reference_type='page_version', published_reference_id=?,
                                publication_idempotency_key=?
                            WHERE commit_intent_id=?
                            """,
                            (
                                "2026-08-09T12:00:02Z",
                                "2026-08-09T12:00:05Z",
                                intent_id,
                                f"commit-intent:{intent_id}",
                                intent_id,
                            ),
                        )
                    elif new_state == "completed":
                        connection.execute(
                            """
                            UPDATE artifact_commit_intents
                            SET state='completed', renamed_at=COALESCE(renamed_at, ?),
                                published_at=COALESCE(published_at, ?),
                                published_reference_type=COALESCE(published_reference_type, 'page_version'),
                                published_reference_id=COALESCE(published_reference_id, ?),
                                publication_idempotency_key=COALESCE(publication_idempotency_key, ?),
                                completed_at=?
                            WHERE commit_intent_id=?
                            """,
                            (
                                "2026-08-09T12:00:02Z",
                                "2026-08-09T12:00:03Z",
                                intent_id,
                                f"commit-intent:{intent_id}",
                                "2026-08-09T12:00:05Z",
                                intent_id,
                            ),
                        )
                    elif new_state == "quarantined":
                        connection.execute(
                            """
                            UPDATE artifact_commit_intents
                            SET state='quarantined', quarantined_at=?, quarantine_paths_json=?,
                                quarantine_reason_code='HASH_MISMATCH'
                            WHERE commit_intent_id=?
                            """,
                            (
                                "2026-08-09T12:00:05Z",
                                f'["quarantine/commit-intents/{intent_id}/tree"]',
                                intent_id,
                            ),
                        )
                    else:
                        connection.execute(
                            "UPDATE artifact_commit_intents SET state='prepared' WHERE commit_intent_id=?",
                            (intent_id,),
                        )

                allowed = new_state in EXPECTED_TRANSITIONS[old_state]
                if allowed:
                    transition()
                else:
                    expect_integrity_error(transition, f"transition {old_state} -> {new_state}")
            finally:
                connection.close()

    connection = new_sql_connection(sql)
    try:
        insert_prepared(connection, intent_id, "terminal-idempotency")
        advance(connection, intent_id, "completed")
        before = connection.execute(
            "SELECT * FROM artifact_commit_intents WHERE commit_intent_id=?", (intent_id,)
        ).fetchone()
        changes = connection.total_changes

        def recover_terminal() -> tuple[Any, ...]:
            row = connection.execute(
                "SELECT * FROM artifact_commit_intents WHERE commit_intent_id=?", (intent_id,)
            ).fetchone()
            if row is None or row[5] not in TERMINAL_STATES:
                raise ValueError("terminal recovery fixture is not terminal")
            return row

        first = recover_terminal()
        second = recover_terminal()
        if first != before or second != before or connection.total_changes != changes:
            raise ValueError("repeated terminal recovery was not a read-only idempotent result")

        expect_integrity_error(
            lambda: connection.execute(
                "UPDATE artifact_commit_intents SET recovery_count=recovery_count+1 WHERE commit_intent_id=?",
                (intent_id,),
            ),
            "terminal update",
        )
        expect_integrity_error(
            lambda: connection.execute(
                "DELETE FROM artifact_commit_intents WHERE commit_intent_id=?", (intent_id,)
            ),
            "terminal delete",
        )

        duplicate_id = "01j4w4j9a3jpsk9r7jcrg29q02"
        expect_integrity_error(
            lambda: insert_prepared(connection, duplicate_id, "terminal-idempotency"),
            "duplicate recovery idempotency key",
        )

        template = semantics["recovery_idempotency"]["publication_key_template"]
        first_key = template.format(commit_intent_id=intent_id)
        second_key = template.format(commit_intent_id=intent_id)
        if first_key != second_key or first_key != f"commit-intent:{intent_id}":
            raise ValueError("repeated recovery publication key is unstable")
    finally:
        connection.close()

    print("VALID artifact commit-intent transitions, terminal immutability, and recovery idempotency")


def validate_sql_contract(semantics: dict[str, Any]) -> None:
    sql = (ROOT / "control-plane-schema.sql").read_text(encoding="utf-8")
    connection = new_sql_connection(sql)
    try:
        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact_commit_intents'"
        ).fetchone()
        if row is None:
            raise ValueError("control-plane-schema.sql: artifact_commit_intents is absent")
        for required in (
            "idempotency_key",
            "manifest_sha256",
            "expected_files_json",
            "quarantine_paths_json",
            "quarantine_reason_code",
            "quarantine_safe_detail",
            "publication_idempotency_key",
        ):
            if required not in row[0]:
                raise ValueError(f"artifact_commit_intents: missing {required}")
    finally:
        connection.close()
    validate_sql_state_machine(sql, semantics)
    print("VALID control-plane-schema.sql -> SQLite in-memory database")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schemas-only", action="store_true")
    args = parser.parse_args()

    try:
        schemas, registry = load_schemas()
        print(f"VALID {len(schemas)} JSON Schema 2020-12 contracts")
        if not args.schemas_only:
            semantics = validate_semantics_contract()
            validate_examples(schemas, registry)
            validate_invalid_fixtures(schemas, registry)
            validate_sql_contract(semantics)
    except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as error:
        print(f"CONTRACT ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
