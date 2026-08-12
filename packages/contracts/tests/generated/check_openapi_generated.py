#!/usr/bin/env python3
"""Check OpenAPI operation coverage, deterministic stubs, drift, and Python imports."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = ROOT.parents[1]
GENERATOR = ROOT / "scripts" / "generate_openapi.py"
GENERATED = ROOT / "generated" / "openapi"
DOCUMENTS = (ROOT / "openapi.yaml", ROOT / "worker-openapi.yaml")
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def run(command: list[str], *, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=REPOSITORY,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if (result.returncode == 0) != expect_success:
        raise AssertionError(f"unexpected command result {command}:\n{result.stdout}")
    return result


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def operation_ids(path: Path) -> list[str]:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    return sorted(
        operation["operationId"]
        for path_item in document["paths"].values()
        for method, operation in path_item.items()
        if method in HTTP_METHODS
    )


def import_module(name: str, path: Path) -> object:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load generated module {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    trace = json.loads((GENERATED / "traceability.json").read_text(encoding="utf-8"))
    traced = {entry["document"]: entry for entry in trace["documents"]}
    for document in DOCUMENTS:
        entry = traced.get(document.name)
        if entry is None:
            raise AssertionError(f"OpenAPI traceability is absent: {document.name}")
        if entry["document_sha256"] != hashlib.sha256(document.read_bytes()).hexdigest():
            raise AssertionError(f"OpenAPI hash drift: {document.name}")
        expected_ids = operation_ids(document)
        if entry["operation_ids"] != expected_ids or entry["operation_count"] != len(expected_ids):
            raise AssertionError(f"operation traceability is incomplete: {document.name}")
        for schema_ref in entry["canonical_schema_refs"]:
            schema = ROOT / schema_ref["schema"]
            if schema_ref["schema_sha256"] != hashlib.sha256(schema.read_bytes()).hexdigest():
                raise AssertionError(
                    f"canonical schema compatibility hash differs: {schema_ref['schema']}"
                )
        for language in ("typescript", "python"):
            if not (GENERATED / entry[language]).is_file():
                raise AssertionError(f"generated OpenAPI target is absent: {entry[language]}")

    with tempfile.TemporaryDirectory(prefix="webx-openapi-two-run-") as directory:
        first = Path(directory) / "first"
        second = Path(directory) / "second"
        run([sys.executable, str(GENERATOR), "--output", str(first)])
        run([sys.executable, str(GENERATOR), "--output", str(second)])
        if tree_hashes(first) != tree_hashes(second):
            raise AssertionError("two OpenAPI generator runs produced different bytes")
        if tree_hashes(first) != tree_hashes(GENERATED):
            raise AssertionError("clean OpenAPI regeneration differs from committed output")

        drift = Path(directory) / "drift"
        shutil.copytree(GENERATED, drift)
        target = drift / "typescript" / "worker-api.ts"
        target.write_text(
            target.read_text(encoding="utf-8") + "// seeded drift\n", encoding="utf-8"
        )
        result = run(
            [sys.executable, str(GENERATOR), "--check-dir", str(drift)],
            expect_success=False,
        )
        expected = "OPENAPI GENERATED DRIFT: generated drift: typescript/worker-api.ts"
        if expected not in result.stdout:
            raise AssertionError(f"OpenAPI drift fixture has no exact diagnostic:\n{result.stdout}")

    run([sys.executable, str(GENERATOR), "--check"])
    public = import_module("webx_generated_public_api", GENERATED / "python" / "public_api.py")
    worker = import_module("webx_generated_worker_api", GENERATED / "python" / "worker_api.py")
    if len(public.OPERATIONS) != len(operation_ids(ROOT / "openapi.yaml")):
        raise AssertionError("generated public Python client operation count differs")
    if len(worker.OPERATIONS) != len(operation_ids(ROOT / "worker-openapi.yaml")):
        raise AssertionError("generated worker Python client operation count differs")
    worker_source = (GENERATED / "typescript" / "worker-api.ts").read_text(encoding="utf-8")
    for forbidden in ('"accepted"', '"rejection_reasons"'):
        if forbidden in worker_source:
            raise AssertionError(f"worker authority text was generated: {forbidden}")

    print(
        "VALID generated OpenAPI stubs: all operationIds, deterministic two-run output, "
        "clean regeneration, drift detection, Python imports"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
