#!/usr/bin/env python3
"""Run the M0 release-preparation checks without claiming full product release."""

from __future__ import annotations

import csv
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
ACCEPTANCE: Final = ROOT / "scripts/docs_fixtures/normative/acceptance-matrix.csv"
AC_PATTERN: Final = re.compile(r"^AC-[0-9]{3}$")
SELECTOR_PATTERN: Final = re.compile(r"^[a-z0-9-]+$")
PROFILES: Final = ("core", "full", "model", "llama-cpu", "vllm-gpu", "offline")
RELEASE_COMMANDS: Final = (
    (
        "component-lock",
        "./scripts/toolchain-component-lock",
        "--resolved-at",
        "2026-08-12T05:00:00Z",
        "--mode",
        "release",
        "--check",
    ),
    ("dependency-inventory", "./scripts/dependency-inventory", "--mode", "release", "--check"),
    ("workflow-policy", "python3", "scripts/ci_validate.py"),
    ("m0-gate", "./scripts/ci-m0-gate"),
)


class ReleaseCheckError(Exception):
    """A selector or accepted registry is invalid."""


def acceptance_registry() -> dict[str, str]:
    try:
        with ACCEPTANCE.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        raise ReleaseCheckError(f"cannot read acceptance registry: {error}") from error
    result = {row["acceptance_id"]: row["target_milestone"] for row in rows}
    if len(result) != len(rows):
        raise ReleaseCheckError("acceptance registry contains duplicate IDs")
    return result


def selectors() -> tuple[str, str, dict[str, str]]:
    ac = os.environ.get("AC", "")
    profile = os.environ.get("PROFILE", "")
    registry = acceptance_registry()
    if ac and (not AC_PATTERN.fullmatch(ac) or ac not in registry):
        raise ReleaseCheckError(f"unknown or unsafe AC selector: {ac!r}")
    if profile and (not SELECTOR_PATTERN.fullmatch(profile) or profile not in PROFILES):
        raise ReleaseCheckError(f"unknown or unsafe PROFILE selector: {profile!r}")
    return ac, profile, registry


def main() -> int:
    try:
        ac, profile, registry = selectors()
    except ReleaseCheckError as error:
        print(f"release-check: ERROR: {error}", file=sys.stderr)
        return 2
    print(
        f"release-check: milestone=M0 ac={ac or 'all'} profile={profile or 'all'}",
        flush=True,
    )
    for name, *command in RELEASE_COMMANDS:
        print(f"release-check: run {name}", flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode:
            print(
                f"release-check: FAILED check={name} status={result.returncode}",
                file=sys.stderr,
            )
            return result.returncode
    if ac:
        print(
            f"release-check: NOT IMPLEMENTED at M0: {ac} targets {registry[ac]}; "
            "no acceptance result was claimed"
        )
    else:
        print(
            "release-check: NOT IMPLEMENTED at M0: later milestone acceptance suites; "
            "no full product release result was claimed"
        )
    if profile:
        print(
            f"release-check: NOT IMPLEMENTED at M0: PROFILE={profile} product qualification; "
            "only M0 static and local-fixture checks ran"
        )
    print("release-check: OK milestone=M0 release-readiness=not-claimed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
