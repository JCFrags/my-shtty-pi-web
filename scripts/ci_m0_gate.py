#!/usr/bin/env python3
"""Run the exact WebX M0 exit gate with local fixtures and offline package caches."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
TARGETS: Final = (
    "bootstrap",
    "contracts-check",
    "format",
    "lint",
    "typecheck",
    "test-unit",
    "docs-check",
    "compose-check",
)
COMMAND: Final = ("make", *TARGETS)


class GateError(Exception):
    """The fixed M0 gate cannot run safely."""


def git_status() -> str:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode:
        raise GateError(f"git status failed:\n{result.stdout}")
    return result.stdout


def main() -> int:
    try:
        before = git_status()
        if before:
            raise GateError("M0 gate requires a clean checkout")
        environment = dict(os.environ)
        environment.pop("AC", None)
        environment.pop("PROFILE", None)
        environment.pop("MAKEOVERRIDES", None)
        environment.update(
            {
                "MAKEFLAGS": "",
                "MFLAGS": "",
                "CI": "1",
                "NO_COLOR": "1",
                "npm_config_offline": "true",
                "PNPM_CONFIG_OFFLINE": "true",
                "UV_OFFLINE": "1",
            }
        )
        print("m0-gate: local fixtures only; package resolution is offline", flush=True)
        print(f"m0-gate: run {' '.join(COMMAND)}", flush=True)
        result = subprocess.run(COMMAND, cwd=ROOT, env=environment, check=False)
        if result.returncode:
            print(f"m0-gate: FAILED status={result.returncode}", file=sys.stderr)
            return result.returncode
        if git_status() != before:
            raise GateError("M0 gate changed the checkout")
    except GateError as error:
        print(f"m0-gate: ERROR: {error}", file=sys.stderr)
        return 2
    print("m0-gate: OK milestone=M0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
