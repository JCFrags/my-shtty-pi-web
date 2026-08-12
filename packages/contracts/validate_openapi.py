#!/usr/bin/env python3
"""Validate the canonical WebX public and worker OpenAPI 3.1 contracts."""

from __future__ import annotations

import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag

import yaml

ROOT = Path(__file__).resolve().parent
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
OPERATION_ID = re.compile(r"^[a-z][A-Za-z0-9]*$")
PATH_PARAMETER = re.compile(r"{([^{}]+)}")

PUBLIC_REQUIRED_OPERATIONS = {
    ("get", "/health/live"),
    ("get", "/health/ready"),
    ("get", "/version"),
    ("get", "/capabilities"),
    ("get", "/engines"),
    ("get", "/engines/{engine_id}"),
    ("post", "/engines/{engine_id}/probe"),
    ("post", "/search"),
    ("post", "/read"),
    ("post", "/research"),
    ("post", "/pages/search"),
    ("delete", "/pages"),
    ("post", "/search/local"),
    ("get", "/search/facets"),
    ("post", "/fetch"),
    ("post", "/verify"),
    ("get", "/browser/sessions"),
    ("post", "/browser/sessions"),
    ("post", "/browser/workspace"),
    ("post", "/browser/operations/{operation_id}/cancel"),
    ("get", "/browser/sessions/{session_id}"),
    ("delete", "/browser/sessions/{session_id}"),
    ("post", "/browser/sessions/{session_id}/actions"),
    ("delete", "/browser/sessions/{session_id}/tabs/{tab_id}"),
    ("post", "/browser/sessions/{session_id}/observe"),
    ("post", "/browser/sessions/{session_id}/frame"),
    ("post", "/browser/sessions/{session_id}/debug"),
    ("get", "/browser/sessions/{session_id}/snapshot"),
    ("get", "/browser/sessions/{session_id}/events"),
    ("post", "/crawls"),
    ("get", "/crawls/{crawl_id}"),
    ("post", "/crawls/{crawl_id}/pause"),
    ("post", "/crawls/{crawl_id}/resume"),
    ("post", "/crawls/{crawl_id}/cancel"),
    ("get", "/crawls/{crawl_id}/visits"),
    ("post", "/extractions"),
    *(
        ("post", f"/documents/{name}")
        for name in ("inspect", "convert", "ocr", "scholarly", "chunk")
    ),
    *(("post", f"/media/{name}") for name in ("info", "acquire", "transcribe")),
    ("post", "/galleries/acquire"),
    ("post", "/streams/record"),
    ("post", "/uploads"),
    ("put", "/uploads/{upload_id}/parts/{part_number}"),
    ("post", "/uploads/{upload_id}/complete"),
    ("delete", "/uploads/{upload_id}"),
    ("get", "/artifacts/{artifact_id}"),
    ("get", "/artifacts/{artifact_id}/metadata"),
    ("get", "/artifacts/{artifact_id}/content"),
    ("get", "/artifacts/{artifact_id}/excerpt"),
    ("get", "/pages/{page_id}"),
    ("get", "/pages/{page_id}/versions"),
    ("get", "/pages/{page_id}/versions/{version_id}"),
    ("get", "/pages/{page_id}/changes"),
    ("post", "/pages/{page_id}/tombstone"),
    ("get", "/visits/{visit_id}"),
    ("get", "/visits/{visit_id}/receipt"),
    ("post", "/archives/captures"),
    ("post", "/archives/imports"),
    ("post", "/archives/{archive_id}/replay-sessions"),
    ("post", "/feeds/discover"),
    ("post", "/watches"),
    ("get", "/watches"),
    ("get", "/watches/{watch_id}"),
    ("patch", "/watches/{watch_id}"),
    ("post", "/watches/{watch_id}/run"),
    ("delete", "/watches/{watch_id}"),
    ("get", "/jobs"),
    ("get", "/jobs/{job_id}"),
    ("get", "/jobs/{job_id}/result"),
    ("get", "/jobs/{job_id}/events"),
    ("post", "/jobs/{job_id}/cancel"),
    ("post", "/jobs/{job_id}/retry"),
    ("get", "/index/status"),
    ("post", "/index/drain"),
    ("post", "/index/rebuilds"),
    ("get", "/index/rebuilds/{job_id}"),
    ("get", "/wiki/consumers/{consumer_id}/deliveries"),
    ("get", "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}"),
    ("get", "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}/envelope"),
    ("post", "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}/ack"),
    ("post", "/wiki/consumers/{consumer_id}/leases"),
    ("post", "/wiki/consumers/{consumer_id}/backfills"),
    ("post", "/corpus/imports"),
    ("post", "/corpus/exports"),
    ("get", "/corpus/stats"),
    ("post", "/backups"),
    ("get", "/backups"),
    ("post", "/backups/{backup_id}/verify"),
    ("post", "/restores"),
    ("get", "/audit/events"),
    ("get", "/config/effective"),
    ("post", "/config/validate"),
}

WORKER_REQUIRED_OPERATIONS = {
    ("post", "/workers/register"),
    ("post", "/workers/{worker_id}/heartbeat"),
    ("post", "/leases/claim"),
    ("post", "/attempts/{attempt_id}/heartbeat"),
    ("post", "/attempts/{attempt_id}/progress"),
    ("get", "/attempts/{attempt_id}/inputs/{input_id}"),
    ("put", "/attempts/{attempt_id}/outputs/{slot}"),
    ("post", "/attempts/{attempt_id}/complete"),
    ("post", "/attempts/{attempt_id}/fail"),
    ("post", "/egress/authorize"),
}


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        return yaml.safe_load(stream)


def resolve_pointer(document: Any, fragment: str) -> Any:
    current = document
    if not fragment:
        return current
    if not fragment.startswith("/"):
        raise ValueError(f"unsupported reference fragment #{fragment}")
    for token in fragment[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def iter_refs(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        reference = value.get("$ref")
        if isinstance(reference, str):
            yield reference
        for child in value.values():
            yield from iter_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_refs(child)


def resolve_references(path: Path, document: dict[str, Any]) -> None:
    cache: dict[Path, Any] = {path.resolve(): document}
    for reference in iter_refs(document):
        target_name, fragment = urldefrag(reference)
        if "://" in target_name or target_name.startswith("/"):
            raise ValueError(f"{path.name}: non-local reference is forbidden: {reference}")
        target_path = (path.parent / target_name).resolve() if target_name else path.resolve()
        if ROOT.resolve() not in (target_path, *target_path.parents):
            raise ValueError(f"{path.name}: reference escapes contracts package: {reference}")
        if target_path not in cache:
            cache[target_path] = load_yaml(target_path)
        try:
            resolve_pointer(cache[target_path], fragment)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ValueError(f"{path.name}: unresolved reference {reference}: {error}") from error


def parameters(
    operation: dict[str, Any], path_item: dict[str, Any], document: dict[str, Any]
) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for candidate in [*path_item.get("parameters", []), *operation.get("parameters", [])]:
        if "$ref" in candidate:
            _, fragment = urldefrag(candidate["$ref"])
            candidate = resolve_pointer(document, fragment)
        values.append(candidate)
    return values


def operation_pairs(document: dict[str, Any]) -> set[tuple[str, str]]:
    return {
        (method, path)
        for path, path_item in document["paths"].items()
        for method in path_item
        if method in HTTP_METHODS
    }


def validate_document(
    path: Path, required: set[tuple[str, str]], major_extension: str
) -> dict[str, Any]:
    document = load_yaml(path)
    if not isinstance(document, dict) or document.get("openapi") != "3.1.0":
        raise ValueError(f"{path.name}: OpenAPI version must be 3.1.0")
    info = document.get("info")
    if not isinstance(info, dict) or not re.fullmatch(
        r"1\.[0-9]+\.[0-9]+", str(info.get("version", ""))
    ):
        raise ValueError(f"{path.name}: info.version must identify major 1")
    if info.get(major_extension) != 1:
        raise ValueError(f"{path.name}: {major_extension} must be integer 1")
    paths = document.get("paths")
    if not isinstance(paths, dict) or not paths:
        raise ValueError(f"{path.name}: paths must be a non-empty object")

    actual = operation_pairs(document)
    missing = sorted(required - actual)
    if missing:
        raise ValueError(f"{path.name}: missing normative operations: {missing}")

    operation_ids: set[str] = set()
    for route, path_item in paths.items():
        if (
            not isinstance(route, str)
            or not route.startswith("/")
            or not isinstance(path_item, dict)
        ):
            raise ValueError(f"{path.name}: invalid path item {route!r}")
        for method, operation in path_item.items():
            if method not in HTTP_METHODS:
                continue
            label = f"{method.upper()} {route}"
            if not isinstance(operation, dict):
                raise ValueError(f"{path.name}: {label} operation must be an object")
            operation_id = operation.get("operationId")
            if not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(operation_id):
                raise ValueError(f"{path.name}: {label} has an invalid operationId")
            if operation_id in operation_ids:
                raise ValueError(f"{path.name}: duplicate operationId {operation_id}")
            operation_ids.add(operation_id)
            if not isinstance(operation.get("responses"), dict) or not operation["responses"]:
                raise ValueError(f"{path.name}: {label} has no responses")
            for extension in ("x-webx-scopes", "x-webx-examples"):
                if not isinstance(operation.get(extension), list) or not operation[extension]:
                    raise ValueError(f"{path.name}: {label} has no {extension}")
            limits = operation.get("x-webx-request-limits")
            if not isinstance(limits, dict) or not all(
                isinstance(limits.get(name), int) and limits[name] >= 0
                for name in ("max_body_bytes", "max_response_bytes")
            ):
                raise ValueError(f"{path.name}: {label} has invalid request limits")
            declared = {
                value.get("name")
                for value in parameters(operation, path_item, document)
                if value.get("in") == "path" and value.get("required") is True
            }
            templated = set(PATH_PARAMETER.findall(route))
            if declared != templated:
                raise ValueError(
                    f"{path.name}: {label} path parameters differ: "
                    f"template={sorted(templated)}, declared={sorted(declared)}"
                )

    resolve_references(path, document)
    print(f"VALID {path.name}: OpenAPI 3.1, major 1, {len(operation_ids)} stable operationIds")
    return document


def validate_worker_authority(worker: dict[str, Any]) -> None:
    completion = worker["components"]["schemas"]["AttemptCompletion"]
    properties = completion.get("properties", {})
    normalized = properties.get("normalized_content_result")
    if normalized != {"$ref": "./schemas/normalized-content-result.json"}:
        raise ValueError("worker-openapi.yaml: normalized-content result is not integrated")
    forbidden = {
        "accepted",
        "rejection_reasons",
        "visibility",
        "canonical_id",
        "final_artifact_path",
    }
    produced = {"AttemptCompletion", "OutputHandle"}
    for name in produced:
        schema_properties = worker["components"]["schemas"][name].get("properties", {})
        overlap = forbidden & set(schema_properties)
        if overlap:
            raise ValueError(
                f"worker-openapi.yaml: worker authority fields in {name}: {sorted(overlap)}"
            )
    observation = load_yaml(ROOT / "schemas" / "engine-observation.json")
    overlap = {"accepted", "rejection_reasons"} & set(observation.get("properties", {}))
    if overlap:
        raise ValueError(
            f"worker-openapi.yaml: worker observation authority fields: {sorted(overlap)}"
        )
    normalized_schema = load_yaml(ROOT / "schemas" / "normalized-content-result.json")
    if normalized_schema.get("additionalProperties") is not False:
        raise ValueError(
            "worker-openapi.yaml: normalized-content result must reject unknown fields"
        )
    trust = normalized_schema.get("properties", {}).get("trust", {})
    if trust.get("const") != "untrusted_external_source":
        raise ValueError("worker-openapi.yaml: normalized-content trust boundary is not fixed")
    print(
        "VALID worker authority: normalized content is inert evidence and workers cannot "
        "accept content"
    )


def main() -> int:
    try:
        validate_document(ROOT / "openapi.yaml", PUBLIC_REQUIRED_OPERATIONS, "x-webx-api-major")
        worker = validate_document(
            ROOT / "worker-openapi.yaml", WORKER_REQUIRED_OPERATIONS, "x-webx-protocol-major"
        )
        validate_worker_authority(worker)
    except (OSError, TypeError, yaml.YAMLError, ValueError) as error:
        print(f"OPENAPI CONTRACT ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
