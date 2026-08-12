#!/usr/bin/env python3
"""Check generated traceability, deterministic output, drift failure, and type smoke."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = ROOT.parents[1]
GENERATOR = ROOT / "scripts" / "generate_types.py"
GENERATED = ROOT / "generated"
SCHEMAS = ROOT / "schemas"


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
        if path.is_file()
    }


def main() -> int:
    trace = json.loads((GENERATED / "traceability.json").read_text(encoding="utf-8"))
    schema_names = sorted(path.name for path in SCHEMAS.glob("*.json"))
    traced_names = sorted(Path(entry["schema"]).name for entry in trace["schemas"])
    if traced_names != schema_names:
        raise AssertionError("schema-to-generated traceability is incomplete")
    for entry in trace["schemas"]:
        schema = ROOT / entry["schema"]
        if hashlib.sha256(schema.read_bytes()).hexdigest() != entry["schema_sha256"]:
            raise AssertionError(f"schema hash drift: {entry['schema']}")
        for language in ("typescript", "python"):
            if not (GENERATED / entry[language]).is_file():
                raise AssertionError(f"missing generated target: {entry[language]}")

    with tempfile.TemporaryDirectory(prefix="webx-two-run-") as directory:
        first = Path(directory) / "first"
        second = Path(directory) / "second"
        run(["python3", str(GENERATOR), "--output", str(first)])
        run(["python3", str(GENERATOR), "--output", str(second)])
        if tree_hashes(first) != tree_hashes(second):
            raise AssertionError("two generator runs produced different bytes")
        if tree_hashes(first) != tree_hashes(GENERATED):
            raise AssertionError("clean regeneration differs from committed output")

        drift = Path(directory) / "drift"
        shutil.copytree(GENERATED, drift)
        target = drift / "typescript" / "engine-observation.d.ts"
        target.write_text(
            target.read_text(encoding="utf-8") + "// seeded drift\n", encoding="utf-8"
        )
        result = run(
            ["python3", str(GENERATOR), "--check-dir", str(drift)],
            expect_success=False,
        )
        expected_message = "GENERATED DRIFT: generated drift: typescript/engine-observation.d.ts"
        if expected_message not in result.stdout:
            raise AssertionError(f"drift fixture failed without exact diagnostic:\n{result.stdout}")

    run(["python3", str(GENERATOR), "--check"])
    run(["python3", str(ROOT / "tests" / "generated" / "python_smoke.py")])
    run(
        [
            "pnpm",
            "exec",
            "tsc",
            "-p",
            str(ROOT / "tests" / "generated" / "tsconfig.json"),
        ]
    )

    engine_ts = (GENERATED / "typescript" / "engine-observation.d.ts").read_text(encoding="utf-8")
    engine_py = (GENERATED / "python" / "engine_observation.py").read_text(encoding="utf-8")
    for forbidden in ("accepted", "rejection_reasons"):
        if forbidden in engine_ts or forbidden in engine_py:
            raise AssertionError(f"worker authority text was generated: {forbidden}")

    print(
        f"VALID generated type checks: {len(schema_names)} schemas, deterministic two-run output, "
        "clean regeneration, drift detection, TypeScript compile, Python import smoke"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
