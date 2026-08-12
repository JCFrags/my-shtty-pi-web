#!/usr/bin/env python3
"""Verify and bootstrap the exact WebX development toolchain."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
VERSION_PATTERN: Final = re.compile(r"(?<!\d)(\d+\.\d+\.\d+)(?!\d)")


class ToolchainError(Exception):
    """A clear toolchain validation failure."""


def load_lock(path: Path = ROOT / "toolchain.lock.yaml") -> dict[str, dict[str, str]]:
    """Load the scalar two-level subset used by the reviewed toolchain lock."""
    result: dict[str, dict[str, str]] = {}
    section: str | None = None
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()
        if indent == 0:
            key, separator, value = stripped.partition(":")
            if not separator:
                raise ToolchainError(f"{path}:{line_number}: expected a key and value")
            if value.strip():
                result[key] = {"value": value.strip().strip('"')}
                section = None
            else:
                section = key
                result[section] = {}
            continue
        if indent == 2 and section is not None:
            key, separator, value = stripped.partition(":")
            if not separator or not value.strip():
                raise ToolchainError(f"{path}:{line_number}: expected a scalar value")
            result[section][key] = value.strip().strip('"')
            continue
        raise ToolchainError(f"{path}:{line_number}: unsupported lock structure")
    return result


def extract_version(output: str) -> str:
    """Return the first semantic three-part version from command output."""
    match = VERSION_PATTERN.search(output)
    if match is None:
        raise ToolchainError(f"could not parse a version from {output.strip()!r}")
    return match.group(1)


def run(command: list[str]) -> str:
    """Run one bounded local tool command and return combined text."""
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError as error:
        raise ToolchainError(f"missing command: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise ToolchainError(f"command timed out: {' '.join(command)}") from error
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part).strip()
    if completed.returncode != 0:
        raise ToolchainError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n{output}"
        )
    return output


def installed_versions(include_development: bool) -> dict[str, str]:
    """Read exact versions from installed executables."""
    versions = {
        "node": extract_version(run(["node", "--version"])),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "pnpm": extract_version(run(["pnpm", "--version"])),
        "uv": extract_version(run(["uv", "--version"])),
    }
    if include_development:
        commands = {
            "typescript": ["pnpm", "exec", "tsc", "--version"],
            "eslint": ["pnpm", "exec", "eslint", "--version"],
            "vitest": ["pnpm", "exec", "vitest", "--version"],
            "ruff": ["uv", "run", "ruff", "--version"],
            "mypy": ["uv", "run", "mypy", "--version"],
            "pytest": ["uv", "run", "pytest", "--version"],
        }
        versions.update({name: extract_version(run(command)) for name, command in commands.items()})
    return versions


def expected_versions(lock: dict[str, dict[str, str]], include_development: bool) -> dict[str, str]:
    """Select executable versions from the lock."""
    expected = {
        "node": lock["runtimes"]["node"],
        "python": lock["runtimes"]["python"],
        "pnpm": lock["package_managers"]["pnpm"],
        "uv": lock["package_managers"]["uv"],
    }
    if include_development:
        expected.update(
            {
                "typescript": lock["typescript"]["typescript"],
                "eslint": lock["lint"]["eslint"],
                "vitest": lock["test"]["vitest"],
                "ruff": lock["lint"]["ruff"],
                "mypy": lock["lint"]["mypy"],
                "pytest": lock["test"]["pytest"],
            }
        )
    return expected


def verify_manifest_pins(lock: dict[str, dict[str, str]]) -> None:
    """Reject drift between human-readable manifests and the toolchain lock."""
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    python_project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    expected_package_manager = f"pnpm@{lock['package_managers']['pnpm']}"
    if package.get("packageManager") != expected_package_manager:
        raise ToolchainError(
            f"package.json packageManager must be exactly {expected_package_manager}"
        )
    npm_pins = {
        "typescript": lock["typescript"]["typescript"],
        "eslint": lock["lint"]["eslint"],
        "@eslint/js": lock["lint"]["eslint_js"],
        "typescript-eslint": lock["lint"]["typescript_eslint"],
        "vitest": lock["test"]["vitest"],
        "@vitest/coverage-v8": lock["test"]["vitest_coverage_v8"],
    }
    for name, expected in npm_pins.items():
        actual = package.get("devDependencies", {}).get(name)
        if actual != expected:
            raise ToolchainError(f"package.json {name} must be exactly {expected}; got {actual!r}")
    python_pins = set(python_project["dependency-groups"]["dev"])
    for name, expected in {
        "ruff": lock["lint"]["ruff"],
        "mypy": lock["lint"]["mypy"],
        "pytest": lock["test"]["pytest"],
    }.items():
        pin = f"{name}=={expected}"
        if pin not in python_pins:
            raise ToolchainError(f"pyproject.toml must contain exact pin {pin}")
    for filename, expected in {
        ".node-version": lock["runtimes"]["node"],
        ".python-version": lock["runtimes"]["python"],
    }.items():
        actual = (ROOT / filename).read_text(encoding="utf-8").strip()
        if actual != expected:
            raise ToolchainError(f"{filename} must be exactly {expected}; got {actual!r}")


def verify_versions(include_development: bool) -> None:
    """Verify manifest consistency and installed versions."""
    lock = load_lock()
    verify_manifest_pins(lock)
    expected = expected_versions(lock, include_development)
    actual = installed_versions(include_development)
    mismatches = [
        f"{name}: expected {expected[name]}, found {actual.get(name, 'missing')}"
        for name in expected
        if actual.get(name) != expected[name]
    ]
    if mismatches:
        detail = "\n".join(f"  - {item}" for item in mismatches)
        raise ToolchainError(
            "incompatible WebX toolchain:\n"
            f"{detail}\n"
            "Install the versions in toolchain.lock.yaml, then run make bootstrap again."
        )
    for name in expected:
        print(f"{name}={actual[name]}")


def bootstrap() -> None:
    """Verify runtimes, perform frozen local setup, and verify all tools."""
    verify_versions(include_development=False)
    run(["pnpm", "install", "--frozen-lockfile"])
    run(["uv", "sync", "--frozen", "--all-packages"])
    verify_versions(include_development=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--runtime", action="store_true", help="check runtime and package managers")
    mode.add_argument("--all", action="store_true", help="check runtime, lint, and test tools")
    mode.add_argument(
        "--bootstrap", action="store_true", help="run frozen setup and check all tools"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.bootstrap:
            bootstrap()
        else:
            verify_versions(include_development=args.all)
    except (KeyError, OSError, ToolchainError, tomllib.TOMLDecodeError) as error:
        print(f"toolchain-check: ERROR: {error}", file=sys.stderr)
        return 2
    print("toolchain-check: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
