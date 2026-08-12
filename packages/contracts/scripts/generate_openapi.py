#!/usr/bin/env python3
"""Generate deterministic TypeScript and Python operation stubs from WebX OpenAPI."""

from __future__ import annotations

import argparse
import hashlib
import json
import pprint
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "generated" / "openapi"
DOCUMENTS = (("public", ROOT / "openapi.yaml"), ("worker", ROOT / "worker-openapi.yaml"))
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def class_name(name: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in re.split(r"[^A-Za-z0-9]+", name) if part)


def iter_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        if isinstance(value.get("$ref"), str):
            refs.append(value["$ref"])
        for child in value.values():
            refs.extend(iter_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(iter_refs(child))
    return refs


def canonical_schema_imports(document: dict[str, Any]) -> list[tuple[str, str, str]]:
    imports: list[tuple[str, str, str]] = []
    for reference in sorted(set(iter_refs(document))):
        match = re.fullmatch(r"\./schemas/([^/#]+)\.json", reference)
        if match is None:
            continue
        stem = match.group(1)
        schema = json.loads((ROOT / "schemas" / f"{stem}.json").read_text(encoding="utf-8"))
        title = schema.get("title")
        if not isinstance(title, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", title):
            raise ValueError(f"canonical schema {stem}.json has no importable title")
        imports.append((reference, stem, title))
    return imports


def operations(document: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in sorted(document["paths"]):
        path_item = document["paths"][path]
        for method in HTTP_METHODS:
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            request_schema = None
            content = operation.get("requestBody", {}).get("content", {})
            for media_type in sorted(content):
                schema = content[media_type].get("schema")
                if isinstance(schema, dict):
                    request_schema = schema.get("$ref") or "inline"
                    break
            response_schemas: list[str] = []
            for status, response in sorted(operation.get("responses", {}).items()):
                if "$ref" in response:
                    response_schemas.append(f"{status}:{response['$ref']}")
                    continue
                for media_type, media in sorted(response.get("content", {}).items()):
                    schema = media.get("schema", {})
                    response_schemas.append(f"{status}:{media_type}:{schema.get('$ref', 'inline')}")
            result.append(
                {
                    "operationId": operation["operationId"],
                    "method": method.upper(),
                    "path": path,
                    "scopes": operation["x-webx-scopes"],
                    "requestSchema": request_schema,
                    "responseSchemas": response_schemas,
                }
            )
    return sorted(result, key=lambda value: value["operationId"])


def typescript(
    api: str, values: list[dict[str, Any]], schema_imports: list[tuple[str, str, str]]
) -> str:
    title = class_name(api) + "Api"
    operation_ids = " | ".join(json.dumps(value["operationId"]) for value in values)
    descriptors = json.dumps(values, indent=2, sort_keys=True)
    imports = "\n".join(
        f"import type {{ {schema_title} }} from '../../typescript/{stem}.js';"
        for _, stem, schema_title in schema_imports
    )
    schema_map = "\n".join(
        f"  readonly {json.dumps(reference)}: {schema_title};"
        for reference, _, schema_title in schema_imports
    )
    methods = "\n".join(
        f"  {value['operationId']}(request: OperationRequest, signal?: AbortSignal): "
        "Promise<OperationResponse>;"
        for value in values
    )
    return f"""// Generated from {api} OpenAPI. Do not edit.
{imports}

export interface {title}CanonicalSchemas {{
{schema_map}
}}

export type {title}CanonicalSchemaRef = keyof {title}CanonicalSchemas;
export type {title}CanonicalSchema<R extends string> =
  R extends {title}CanonicalSchemaRef ? {title}CanonicalSchemas[R] : unknown;

export type {title}OperationId = {operation_ids};

export interface OperationRequest {{
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}}

export interface OperationResponse {{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}}

export interface OperationDescriptor {{
  readonly operationId: {title}OperationId;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly scopes: readonly string[];
  readonly requestSchema: string | null;
  readonly responseSchemas: readonly string[];
}}

export const {api}Operations = {descriptors} as const satisfies readonly OperationDescriptor[];

export interface {title}Client {{
{methods}
}}

export type {title}ServerHandlers = {{
  readonly [K in {title}OperationId]: (
    request: OperationRequest,
    signal: AbortSignal,
  ) => Promise<OperationResponse>;
}};
"""


def python(api: str, values: list[dict[str, Any]]) -> str:
    title = class_name(api) + "Api"
    descriptors = pprint.pformat(values, sort_dicts=True, width=100)
    methods = "\n".join(
        f"    async def {value['operationId']}(self, request: OperationRequest) "
        "-> OperationResponse: ..."
        for value in values
    )
    return f"""# Generated from {api} OpenAPI. Do not edit.
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, TypedDict


class OperationRequest(TypedDict, total=False):
    path: Mapping[str, str | int]
    query: Mapping[str, str | int | bool | tuple[str, ...]]
    headers: Mapping[str, str]
    body: Any


class OperationResponse(TypedDict, total=False):
    status: int
    headers: Mapping[str, str]
    body: Any


@dataclass(frozen=True)
class OperationDescriptor:
    operation_id: str
    method: str
    path: str
    scopes: tuple[str, ...]
    request_schema: str | None
    response_schemas: tuple[str, ...]


_raw_operations: list[dict[str, Any]] = {descriptors}
OPERATIONS = tuple(
    OperationDescriptor(
        operation_id=value["operationId"],
        method=value["method"],
        path=value["path"],
        scopes=tuple(value["scopes"]),
        request_schema=value["requestSchema"],
        response_schemas=tuple(value["responseSchemas"]),
    )
    for value in _raw_operations
)


class {title}Client(Protocol):
{methods}
"""


def generate(output: Path) -> None:
    ts_dir = output / "typescript"
    py_dir = output / "python"
    ts_dir.mkdir(parents=True)
    py_dir.mkdir(parents=True)
    trace: dict[str, Any] = {"schema_version": "1.0", "documents": []}
    for api, path in DOCUMENTS:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        values = operations(document)
        schema_imports = canonical_schema_imports(document)
        ts_path = ts_dir / f"{api}-api.ts"
        py_path = py_dir / f"{api}_api.py"
        ts_path.write_text(typescript(api, values, schema_imports), encoding="utf-8")
        py_path.write_text(python(api, values), encoding="utf-8")
        trace["documents"].append(
            {
                "document": path.name,
                "document_sha256": sha256(path),
                "operation_count": len(values),
                "operation_ids": [value["operationId"] for value in values],
                "canonical_schema_refs": [
                    {
                        "ref": reference,
                        "schema": f"schemas/{stem}.json",
                        "schema_sha256": sha256(ROOT / "schemas" / f"{stem}.json"),
                        "typescript_type": schema_title,
                    }
                    for reference, stem, schema_title in schema_imports
                ],
                "typescript": f"typescript/{ts_path.name}",
                "python": f"python/{py_path.name}",
            }
        )
    (py_dir / "__init__.py").write_text(
        '"""Generated WebX OpenAPI operation stubs."""\n', encoding="utf-8"
    )
    (output / "traceability.json").write_text(
        json.dumps(trace, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def generated_files(root: Path) -> dict[Path, Path]:
    return {
        path.relative_to(root): path
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def compare(expected: Path, actual: Path) -> list[str]:
    expected_files = generated_files(expected)
    actual_files = generated_files(actual)
    failures: list[str] = []
    for path in sorted(expected_files.keys() | actual_files.keys()):
        if path not in expected_files:
            failures.append(f"unexpected generated file: {path}")
        elif path not in actual_files:
            failures.append(f"missing generated file: {path}")
        elif expected_files[path].read_bytes() != actual_files[path].read_bytes():
            failures.append(f"generated drift: {path}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if sum((args.check, args.check_dir is not None, args.output is not None)) > 1:
        parser.error("--check, --check-dir, and --output are mutually exclusive")
    if args.output:
        destination = args.output.resolve()
        if destination.exists():
            shutil.rmtree(destination)
        generate(destination)
        return 0
    if args.check or args.check_dir:
        expected = args.check_dir.resolve() if args.check_dir else GENERATED
        with tempfile.TemporaryDirectory(prefix="webx-openapi-generated-") as directory:
            candidate = Path(directory) / "openapi"
            generate(candidate)
            failures = compare(expected, candidate)
            if failures:
                for failure in failures:
                    print(f"OPENAPI GENERATED DRIFT: {failure}", file=sys.stderr)
                return 1
        print("VALID generated OpenAPI stubs match canonical documents")
        return 0
    if GENERATED.exists():
        shutil.rmtree(GENERATED)
    generate(GENERATED)
    print("GENERATED public and worker OpenAPI TypeScript/Python stubs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
