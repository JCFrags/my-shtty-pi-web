#!/usr/bin/env python3
"""Generate deterministic TypeScript and Python types from canonical schemas."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "schemas"
GENERATED_DIR = ROOT / "generated"
LOCK_PATH = ROOT / "generator-lock.json"
TRACE_PATH = "traceability.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str]) -> None:
    subprocess.run(command, cwd=ROOT.parents[1], check=True)


def generate(output: Path) -> None:
    lock: dict[str, Any] = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    typescript = output / "typescript"
    python = output / "python"
    typescript.mkdir(parents=True)
    python.mkdir(parents=True)
    schemas = sorted(SCHEMA_DIR.glob("*.json"))

    trace: dict[str, Any] = {
        "schema_version": "1.0",
        "generators": {
            "typescript": {
                "package": lock["typescript"]["package"],
                "version": lock["typescript"]["version"],
            },
            "python": {
                "package": lock["python"]["package"],
                "version": lock["python"]["version"],
                "target_python": lock["python"]["target_python"],
            },
        },
        "schemas": [],
    }

    for schema in schemas:
        stem = schema.stem
        python_name = stem.replace("-", "_") + ".py"
        typescript_name = stem + ".d.ts"
        run(
            [
                "pnpm",
                "exec",
                "json2ts",
                str(schema),
                str(typescript / typescript_name),
                "--cwd",
                str(SCHEMA_DIR),
                "--no-enableConstEnums",
                "--unknownAny",
                "--maxItems=-1",
                "--style.singleQuote",
                "--style.semi",
            ]
        )
        run(
            [
                "uv",
                "run",
                "jsonschema-gentypes",
                "--json-schema",
                str(schema),
                "--python",
                str(python / python_name),
                "--python-version",
                lock["python"]["target_python"],
            ]
        )
        python_output = python / python_name
        python_text = python_output.read_text(encoding="utf-8")
        python_output.write_text(
            python_text.replace("\\", "\\\\").rstrip() + "\n",
            encoding="utf-8",
        )
        trace["schemas"].append(
            {
                "schema": f"schemas/{schema.name}",
                "schema_sha256": sha256(schema),
                "typescript": f"typescript/{typescript_name}",
                "python": f"python/{python_name}",
            }
        )

    (python / "__init__.py").write_text(
        '"""Generated WebX schema types. Import a schema module directly."""\n',
        encoding="utf-8",
    )
    (output / TRACE_PATH).write_text(
        json.dumps(trace, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def compare(expected: Path, actual: Path) -> list[str]:
    expected_files = {
        path.relative_to(expected): path for path in expected.rglob("*") if path.is_file()
    }
    actual_files = {path.relative_to(actual): path for path in actual.rglob("*") if path.is_file()}
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
        expected = args.check_dir.resolve() if args.check_dir else GENERATED_DIR
        with tempfile.TemporaryDirectory(prefix="webx-generated-types-") as directory:
            candidate = Path(directory) / "generated"
            generate(candidate)
            failures = compare(expected, candidate)
            if failures:
                for failure in failures:
                    print(f"GENERATED DRIFT: {failure}", file=sys.stderr)
                return 1
        print("VALID generated types match canonical schemas")
        return 0

    if GENERATED_DIR.exists():
        shutil.rmtree(GENERATED_DIR)
    generate(GENERATED_DIR)
    print(f"GENERATED {len(list(SCHEMA_DIR.glob('*.json')))} schema type pairs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
