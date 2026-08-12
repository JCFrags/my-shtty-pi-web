#!/usr/bin/env python3
"""Seeded tests for the WebX documentation validator."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / "scripts" / "docs_check.py"
FIXTURES = ROOT / "scripts" / "docs_fixtures" / "normative"


class DocsCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.before = subprocess.run(
            ["git", "status", "--porcelain=v1"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout
        self.temp = tempfile.TemporaryDirectory(prefix="webx-docs-check-")
        self.root = Path(self.temp.name)
        (self.root / "docs").mkdir()
        shutil.copy(FIXTURES / "backlog.csv", self.root / "backlog.csv")
        shutil.copy(FIXTURES / "acceptance-matrix.csv", self.root / "acceptance-matrix.csv")
        shutil.copy(FIXTURES / "id-catalog.json", self.root / "id-catalog.json")
        (self.root / "README.md").write_text(
            "# Fixture\n\n[Guide](docs/guide.md#valid-anchor)\n\n"
            "References: WX-M0-011, NFR-M-006, ADR-0001, AC-001.\n",
            encoding="utf-8",
        )
        (self.root / "docs/guide.md").write_text("# Guide\n\n## Valid anchor\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()
        after = subprocess.run(
            ["git", "status", "--porcelain=v1"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout
        self.assertEqual(after, self.before, "docs-check tests changed repository status")

    def run_check(self, *, success: bool, expected: str = "") -> str:
        result = subprocess.run(
            [
                "python3",
                str(VALIDATOR),
                "--root",
                str(self.root),
                "--backlog",
                "backlog.csv",
                "--acceptance",
                "acceptance-matrix.csv",
                "--catalog",
                "id-catalog.json",
            ],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout)
        else:
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn(expected, result.stdout)
        return result.stdout

    def rewrite_backlog(self, mutate: Callable[[list[dict[str, str]]], None]) -> None:
        path = self.root / "backlog.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            fields = list(reader.fieldnames or [])
            rows = list(reader)
        mutate(rows)
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def test_positive_fixture(self) -> None:
        output = self.run_check(success=True)
        self.assertIn("docs-check: OK", output)

    def test_broken_local_link(self) -> None:
        (self.root / "README.md").write_text(
            "# Fixture\n\n[Missing](docs/missing.md)\n", encoding="utf-8"
        )
        self.run_check(
            success=False,
            expected="README.md:3: broken local link: docs/missing.md",
        )

    def test_virtual_environment_markdown_is_ignored(self) -> None:
        hidden = self.root / ".venv/lib/python/site-packages/example"
        hidden.mkdir(parents=True)
        (hidden / "README.md").write_text("[Missing](missing.md)\n", encoding="utf-8")
        self.run_check(success=True)

    def test_reference_style_link(self) -> None:
        (self.root / "README.md").write_text(
            "# Fixture\n\n[Guide][guide]\n\n[guide]: docs/guide.md#valid-anchor\n",
            encoding="utf-8",
        )
        self.run_check(success=True)

    def test_missing_anchor(self) -> None:
        (self.root / "README.md").write_text(
            "# Fixture\n\n[Missing](docs/guide.md#absent)\n", encoding="utf-8"
        )
        self.run_check(
            success=False,
            expected="README.md:3: missing Markdown anchor: docs/guide.md#absent",
        )

    def test_duplicate_backlog_id(self) -> None:
        def mutate(rows: list[dict[str, str]]) -> None:
            rows[1]["id"] = rows[0]["id"]

        self.rewrite_backlog(mutate)
        self.run_check(
            success=False,
            expected="backlog.csv:3: duplicate backlog ID: WX-M0-001 (first at line 2)",
        )

    def test_unknown_dependency(self) -> None:
        def mutate(rows: list[dict[str, str]]) -> None:
            rows[0]["dependencies"] = "WX-M0-999"

        self.rewrite_backlog(mutate)
        self.run_check(
            success=False,
            expected="backlog.csv:2: unknown dependency: WX-M0-001 -> WX-M0-999",
        )

    def test_dependency_cycle(self) -> None:
        def mutate(rows: list[dict[str, str]]) -> None:
            by_id = {row["id"]: row for row in rows}
            by_id["WX-M0-001"]["dependencies"] = "WX-M0-002"
            by_id["WX-M0-002"]["dependencies"] = "WX-M0-001"

        self.rewrite_backlog(mutate)
        self.run_check(
            success=False,
            expected="dependency cycle: WX-M0-001 -> WX-M0-002 -> WX-M0-001",
        )

    def test_unknown_reference_id(self) -> None:
        catalog = json.loads((self.root / "id-catalog.json").read_text(encoding="utf-8"))
        self.assertNotIn("ADR-9999", catalog["adrs"])
        (self.root / "README.md").write_text("# Fixture\n\nUnknown ADR-9999.\n", encoding="utf-8")
        self.run_check(
            success=False,
            expected="README.md:3: unknown reference ID: ADR-9999",
        )

    def test_self_dependency(self) -> None:
        def mutate(rows: list[dict[str, str]]) -> None:
            rows[0]["dependencies"] = rows[0]["id"]

        self.rewrite_backlog(mutate)
        self.run_check(
            success=False,
            expected="backlog.csv:2: self-dependency: WX-M0-001 -> WX-M0-001",
        )


if __name__ == "__main__":
    unittest.main()
