#!/usr/bin/env python3
"""Deterministic tests for M0 workflow and release orchestration policy."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

import ci_m0_gate
import ci_validate
import release_check

ROOT = Path(__file__).resolve().parent.parent


class CiPolicyTest(unittest.TestCase):
    workflow: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = (ROOT / ".github/workflows/m0.yml").read_text(encoding="utf-8")

    def test_workflow_is_valid(self) -> None:
        self.assertEqual(ci_validate.validate(self.workflow), [])

    def test_unpinned_action_fails(self) -> None:
        candidate = self.workflow.replace(
            f"actions/checkout@{ci_validate.CHECKOUT_SHA}", "actions/checkout@v4"
        )
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("external actions differ" in failure for failure in failures), failures)
        self.assertTrue(any("not pinned" in failure for failure in failures), failures)

    def test_write_permission_fails(self) -> None:
        candidate = self.workflow.replace("contents: read", "contents: write")
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("read-only" in failure for failure in failures), failures)

    def test_pull_request_target_fails(self) -> None:
        candidate = self.workflow.replace("  pull_request:", "  pull_request_target:")
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("forbidden token" in failure for failure in failures), failures)

    def test_container_command_fails(self) -> None:
        candidate = self.workflow.replace(
            "run: make release-check", "run: docker run example.invalid/image"
        )
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("docker" in failure for failure in failures), failures)

    def test_self_hosted_runner_fails(self) -> None:
        candidate = self.workflow.replace("runs-on: ubuntu-24.04", "runs-on: self-hosted")
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("GitHub-hosted runner" in failure for failure in failures), failures)
        self.assertTrue(any("self-hosted" in failure for failure in failures), failures)

    def test_secret_reference_fails(self) -> None:
        candidate = self.workflow.replace(
            "NO_COLOR: \"1\"", "PRIVATE_TOKEN: ${{ secrets.PRIVATE_TOKEN }}"
        )
        failures = ci_validate.validate(candidate)
        self.assertTrue(any("secrets." in failure for failure in failures), failures)

    def test_m0_gate_order_is_exact(self) -> None:
        self.assertEqual(
            ci_m0_gate.COMMAND,
            (
                "make",
                "bootstrap",
                "contracts-check",
                "format",
                "lint",
                "typecheck",
                "test-unit",
                "docs-check",
                "compose-check",
            ),
        )

    def test_known_selectors_are_valid(self) -> None:
        with patch.dict(os.environ, {"AC": "AC-001", "PROFILE": "core"}, clear=False):
            ac, profile, registry = release_check.selectors()
        self.assertEqual((ac, profile), ("AC-001", "core"))
        self.assertEqual(registry[ac], "M2")

    def test_unknown_and_injection_selectors_fail(self) -> None:
        cases = (
            {"AC": "AC-999", "PROFILE": ""},
            {"AC": "AC-001;false", "PROFILE": ""},
            {"AC": "", "PROFILE": "unknown"},
            {"AC": "", "PROFILE": "core;false"},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                with patch.dict(os.environ, environment, clear=False):
                    with self.assertRaises(release_check.ReleaseCheckError):
                        release_check.selectors()


if __name__ == "__main__":
    unittest.main()
