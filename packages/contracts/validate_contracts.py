#!/usr/bin/env python3
"""Validate WebX JSON Schema 2020-12 contracts and deterministic fixtures."""

from __future__ import annotations

import argparse
import json
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

VALID_EXAMPLES = {
    "artifact-commit-intent.json": "artifact-commit-intent.json",
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
    "normalized-content-word-count.json": (
        "normalized-content-result.json",
        "/metadata/word_count",
    ),
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


def load_schemas() -> tuple[dict[str, Any], dict[str, Any], Registry]:
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

    return by_name, by_id, Registry().with_resources(resources)


def errors_for(instance: Any, schema: Any, registry: Registry) -> list[Any]:
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FormatChecker(),
    )
    return sorted(
        validator.iter_errors(instance),
        key=lambda error: (list(error.absolute_path), error.validator or "", error.message),
    )


def validate_examples(schemas: dict[str, Any], registry: Registry) -> None:
    actual = {
        path.name
        for path in EXAMPLE_DIR.iterdir()
        if path.is_file() and path.suffix in {".json", ".yaml", ".yml"}
    }
    mapped = set(VALID_EXAMPLES)
    if actual != mapped:
        missing = sorted(actual - mapped)
        stale = sorted(mapped - actual)
        raise ValueError(f"example map mismatch: unmapped={missing}, missing={stale}")

    for example_name, schema_name in sorted(VALID_EXAMPLES.items()):
        failures = errors_for(load_instance(EXAMPLE_DIR / example_name), schemas[schema_name], registry)
        if failures:
            first = failures[0]
            raise ValueError(
                f"{example_name}: {pointer(first.absolute_path) or '/'}: {first.message}"
            )
        print(f"VALID {example_name} -> {schema_name}")


def validate_invalid_fixtures(schemas: dict[str, Any], registry: Registry) -> None:
    actual = {path.name for path in INVALID_DIR.glob("*.json")}
    mapped = set(INVALID_EXAMPLES)
    if actual != mapped:
        missing = sorted(actual - mapped)
        stale = sorted(mapped - actual)
        raise ValueError(f"invalid fixture map mismatch: unmapped={missing}, missing={stale}")

    for fixture_name, (schema_name, expected_path) in sorted(INVALID_EXAMPLES.items()):
        failures = errors_for(load_json(INVALID_DIR / fixture_name), schemas[schema_name], registry)
        paths = [pointer(failure.absolute_path) for failure in failures]
        if not failures:
            raise ValueError(f"{fixture_name}: fixture unexpectedly validated")
        if expected_path not in paths:
            raise ValueError(
                f"{fixture_name}: expected error path {expected_path}; actual paths {paths}"
            )
        print(f"INVALID {fixture_name} -> {schema_name} at {expected_path}")


def validate_sql_contract() -> None:
    sql = (ROOT / "control-plane-schema.sql").read_text(encoding="utf-8")
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(sql)
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
            "quarantined",
        ):
            if required not in row[0]:
                raise ValueError(f"artifact_commit_intents: missing {required}")
    finally:
        connection.close()
    print("VALID control-plane-schema.sql -> SQLite in-memory database")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schemas-only", action="store_true")
    args = parser.parse_args()

    try:
        schemas, _, registry = load_schemas()
        print(f"VALID {len(schemas)} JSON Schema 2020-12 contracts")
        if not args.schemas_only:
            validate_examples(schemas, registry)
            validate_invalid_fixtures(schemas, registry)
            validate_sql_contract()
    except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as error:
        print(f"CONTRACT ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
