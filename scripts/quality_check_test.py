#!/usr/bin/env python3
"""Seeded negative and routing tests for the WebX quality dispatcher."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import quality_check as quality

ROOT = Path(__file__).resolve().parent.parent


class QualitySeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.before = subprocess.run(
            ["git", "status", "--porcelain=v1"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout
        self.temp = tempfile.TemporaryDirectory(prefix=".quality-seed-", dir=ROOT)
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()
        after = subprocess.run(
            ["git", "status", "--porcelain=v1"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout
        self.assertEqual(after, self.before, "seeded checks changed repository status")

    def seed(self, name: str, text: str) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def assert_format_failure(self, name: str, text: str, expected: str) -> None:
        failures = quality.text_failures([self.seed(name, text)], format_mode=True)
        self.assertTrue(any(expected in item for item in failures), failures)

    def assert_lint_failure(self, name: str, text: str, expected: str) -> None:
        failures = quality.text_failures([self.seed(name, text)], format_mode=False)
        self.assertTrue(any(expected in item for item in failures), failures)

    def test_neg_fmt_ts_001(self) -> None:
        self.assert_format_failure("bad.ts", "const value={answer: 1};\n", "TypeScript")

    def test_neg_fmt_py_001(self) -> None:
        path = self.seed("bad.py", "value  = 1\n")
        result = subprocess.run(
            ["uv", "run", "ruff", "format", "--check", str(path)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("would be reformatted", result.stdout)

    def test_neg_fmt_sql_001(self) -> None:
        self.assert_format_failure("bad.sql", "create table item(id integer);\n", "SQL")

    def test_neg_fmt_sh_001(self) -> None:
        self.assert_format_failure("bad.sh", "#!/bin/sh\nif true;then echo yes; fi\n", "shell")

    def test_neg_fmt_doc_001(self) -> None:
        self.assert_format_failure("bad.md", "# Title\n\n-item\n", "Markdown")

    def test_fmt_doc_accepts_front_matter_rules_and_bold(self) -> None:
        path = self.seed("good.md", "---\nname: fixture\n---\n\n**Label:** value\n\n---\n")
        self.assertEqual(quality.text_failures([path], format_mode=True), [])

    def test_neg_lint_ts_001(self) -> None:
        path = self.seed("unused.mjs", "const unused = 1;\nexport {};\n")
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "eslint",
                "--config",
                str(ROOT / "eslint.config.js"),
                "--no-ignore",
                str(path),
            ],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("no-unused-vars", result.stdout)

    def test_neg_lint_py_001(self) -> None:
        path = self.seed("unused.py", "import os\n")
        result = subprocess.run(
            ["uv", "run", "ruff", "check", str(path)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("F401", result.stdout)

    def test_neg_lint_sql_001(self) -> None:
        path = self.seed("bad.sql", "CREATE TABLE broken(;\n")
        with self.assertRaisesRegex(quality.QualityError, "SQLite parse failed"):
            quality.sql_parse([path])

    def test_neg_lint_bash_001(self) -> None:
        self.assert_lint_failure("bad.sh", "#!/bin/sh\necho $value\n", "SC2086")
        self.assertFalse(quality.has_unquoted_shell_expansion('echo "prefix $value"'))

    def test_neg_lint_sh_002(self) -> None:
        self.assert_lint_failure(
            "bad.sh", "#!/bin/sh\nvalues=(one two)\n", "not valid for a POSIX shell"
        )

    def test_neg_lint_doc_001(self) -> None:
        self.assert_lint_failure("bad.md", "#Bad\n\n```text\nopen\n", "unclosed")

    def test_neg_lint_marker_001(self) -> None:
        self.assert_lint_failure(  # WX-M0-010
            "bad.py", "# " + "TO" + "DO: release blocker\n", "backlog ID"
        )

    def test_neg_type_ts_001(self) -> None:
        path = self.seed("bad.ts", "const value: string = 7;\n")
        config = self.seed(
            "tsconfig.json",
            '{"compilerOptions":{"strict":true,"noEmit":true},"files":["bad.ts"]}\n',
        )
        result = subprocess.run(
            ["pnpm", "exec", "tsc", "-p", str(config)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("not assignable to type 'string'", result.stdout)
        self.assertTrue(path.is_file())

    def test_neg_type_py_001(self) -> None:
        path = self.seed("bad.py", "value: str = 7\n")
        result = subprocess.run(
            ["uv", "run", "mypy", "--strict", str(path)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Incompatible types", result.stdout)

    def test_neg_unit_ts_001(self) -> None:
        path = self.seed(
            "bad.test.mjs",
            "import test from 'node:test';\n"
            "import assert from 'node:assert';\n"
            "test('seed',()=>assert.equal(1,2));\n",
        )
        result = subprocess.run(
            ["node", "--test", str(path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_neg_unit_py_001(self) -> None:
        path = self.seed("test_bad.py", "def test_seed() -> None:\n    assert 1 == 2\n")
        result = subprocess.run(
            ["uv", "run", "pytest", "-q", str(path)],
            cwd=ROOT,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_neg_select_001_unknown(self) -> None:
        with self.assertRaisesRegex(quality.QualityError, "unknown AREA"):
            quality.validate_selector("unknown", "", "")

    def test_neg_select_002_path(self) -> None:
        with self.assertRaisesRegex(quality.QualityError, "unsafe AREA"):
            quality.validate_selector("../contracts", "", "")

    def test_neg_select_003_shell_text(self) -> None:
        with self.assertRaisesRegex(quality.QualityError, "unsafe AREA"):
            quality.validate_selector("docs;false", "", "")

    def test_neg_select_004_zero_match(self) -> None:
        with self.assertRaisesRegex(quality.QualityError, "zero tracked files"):
            quality.selected_files("docs", {"docs": []}, [])

    def test_neg_select_005_reserved(self) -> None:
        for ac, profile in (("AC-001", ""), ("", "core")):
            with self.assertRaisesRegex(quality.QualityError, "reserved and unsupported"):
                quality.validate_selector("all", ac, profile)

    def test_neg_gen_001(self) -> None:
        source = ROOT / "packages/contracts/generated"
        drift = self.root / "generated"
        shutil.copytree(source, drift)
        target = drift / "typescript/engine-observation.d.ts"
        target.write_text(
            target.read_text(encoding="utf-8") + "// seeded drift\n", encoding="utf-8"
        )
        result = subprocess.run(
            ["python3", "packages/contracts/scripts/generate_types.py", "--check-dir", str(drift)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("generated drift: typescript/engine-observation.d.ts", result.stdout)

    def test_neg_gen_openapi_001(self) -> None:
        source = ROOT / "packages/contracts/generated/openapi"
        drift = self.root / "openapi"
        shutil.copytree(source, drift)
        target = drift / "typescript/worker-api.ts"
        target.write_text(
            target.read_text(encoding="utf-8") + "// seeded drift\n", encoding="utf-8"
        )
        result = subprocess.run(
            [
                "python3",
                "packages/contracts/scripts/generate_openapi.py",
                "--check-dir",
                str(drift),
            ],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("generated drift: typescript/worker-api.ts", result.stdout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--self-test-area", choices=quality.AREAS, default="all")
    args, remaining = parser.parse_known_args()
    os.environ["WEBX_QUALITY_SELF_TEST_AREA"] = args.self_test_area
    unittest.main(argv=[__file__, *remaining])
