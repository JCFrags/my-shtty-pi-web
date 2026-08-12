#!/usr/bin/env python3
"""Focused tests for the reference Compose validator."""

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any

COMPOSE_DIR = Path(__file__).resolve().parents[1]
ROOT = COMPOSE_DIR.parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "invalid"


def load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("webx_compose_validate", COMPOSE_DIR / "validate.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


class ComposeValidationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = VALIDATOR.load_mapping(COMPOSE_DIR / "compose.yaml")
        cls.images = VALIDATOR.load_mapping(COMPOSE_DIR / "images.lock.json")
        cls.component_lock = VALIDATOR.load_mapping(ROOT / "deploy" / "component-lock.json")

    def test_reference_is_valid(self) -> None:
        VALIDATOR.validate(self.compose, self.images, self.component_lock)

    def test_profiles_have_exact_dependency_closed_service_sets(self) -> None:
        for profile, expected in VALIDATOR.EXPECTED.items():
            with self.subTest(profile=profile):
                self.assertEqual(VALIDATOR.selected_services(self.compose, profile), expected)

    def test_offline_has_no_wan_capable_service(self) -> None:
        selected = VALIDATOR.selected_services(self.compose, "offline")
        self.assertNotIn("egressd", selected)
        self.assertNotIn("searxng", selected)
        for service_name in selected:
            self.assertNotIn(
                "webx_wan", VALIDATOR.normalized_networks(self.compose["services"][service_name])
            )

    def test_seeded_negative_fixtures_fail_for_expected_reason(self) -> None:
        fixtures = sorted(FIXTURES.glob("*.json"))
        self.assertGreaterEqual(len(fixtures), 7)
        for fixture_path in fixtures:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            candidate: dict[str, Any] = copy.deepcopy(self.compose)
            target: Any = candidate
            for key in fixture["path"][:-1]:
                target = target[key]
            target[fixture["path"][-1]] = fixture["value"]
            with self.subTest(fixture=fixture_path.name):
                with self.assertRaisesRegex(VALIDATOR.ValidationError, fixture["expected"]):
                    VALIDATOR.validate(candidate, self.images, self.component_lock)

    def test_cli_resolves_every_profile_without_container_runtime(self) -> None:
        result = subprocess.run(
            [sys.executable, str(COMPOSE_DIR / "validate.py")],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("compose-check: OK", result.stdout)
        for profile in VALIDATOR.PROFILES:
            self.assertIn(f"{profile}:", result.stdout)


if __name__ == "__main__":
    unittest.main()
