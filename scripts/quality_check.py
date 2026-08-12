#!/usr/bin/env python3
"""Run stable, selector-aware WebX quality checks without rewriting source."""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
TARGETS: Final = ("format", "lint", "typecheck", "test-unit")
AREAS: Final = (
    "all",
    "typescript",
    "python",
    "sql",
    "shell",
    "docs",
    "contracts",
    "fixtures",
    "compose",
    "tooling",
)
AREA_PATTERN: Final = re.compile(r"^[a-z]+$")
BACKLOG_MARKER: Final = re.compile(r"WX-M(?:[0-9]|1[0-2])-[0-9]{3}")


class QualityError(Exception):
    """A selector or first-party quality rule failed."""


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    """Run one fixed argument vector and preserve its first failure."""
    print(f"quality-check: run {' '.join(command)}", flush=True)
    result = subprocess.run(command, cwd=cwd, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)


def tracked_files(root: Path = ROOT) -> list[Path]:
    """Return stable tracked regular files from the repository."""
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    paths = [root / raw.decode() for raw in result.stdout.split(b"\0") if raw]
    return sorted(path for path in paths if path.is_file())


def is_generated(path: Path, root: Path = ROOT) -> bool:
    return path.is_relative_to(root / "packages/contracts/generated")


def has_shell_shebang(path: Path) -> bool:
    if path.suffix == ".sh":
        return True
    try:
        with path.open("rb") as stream:
            first = stream.readline(200).decode("utf-8", "ignore")
    except OSError:
        return False
    return first.startswith("#!") and bool(re.search(r"\b(?:ba)?sh\b", first))


def classify(paths: Iterable[Path], root: Path = ROOT) -> dict[str, list[Path]]:
    """Classify tracked files by one canonical registry."""
    result: dict[str, list[Path]] = {key: [] for key in AREAS if key != "all"}
    for path in paths:
        relative = path.relative_to(root)
        suffix = path.suffix.lower()
        if suffix in {".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"}:
            result["typescript"].append(path)
        if suffix == ".py":
            result["python"].append(path)
        if suffix == ".sql":
            result["sql"].append(path)
        if has_shell_shebang(path):
            result["shell"].append(path)
        if suffix == ".md":
            result["docs"].append(path)
        if relative.parts[:2] == ("packages", "contracts"):
            result["contracts"].append(path)
        if relative.parts[:2] == ("packages", "test-fixtures"):
            result["fixtures"].append(path)
        if relative.parts[:2] == ("deploy", "compose"):
            result["compose"].append(path)
        if relative.parts[:1] == ("scripts",) or len(relative.parts) == 1:
            result["tooling"].append(path)
    return result


def validate_selector(area: str, ac: str, profile: str) -> None:
    for name, value in (("AC", ac), ("PROFILE", profile)):
        if value:
            raise QualityError(f"{name} is reserved and unsupported by WX-M0-010 targets")
    if not AREA_PATTERN.fullmatch(area):
        raise QualityError(f"unsafe AREA selector: {area!r}")
    if area not in AREAS:
        raise QualityError(f"unknown AREA {area!r}; allowed: {', '.join(AREAS)}")


def selected_files(area: str, registry: dict[str, list[Path]], all_paths: list[Path]) -> list[Path]:
    selected = all_paths if area == "all" else registry[area]
    if not selected:
        raise QualityError(f"AREA={area} selected zero tracked files")
    return selected


def text_failures(paths: Iterable[Path], *, format_mode: bool) -> list[str]:
    """Check common formatting, Markdown, shell, and release-marker rules."""
    failures: list[str] = []
    for path in paths:
        if path.suffix.lower() not in {
            ".md",
            ".sql",
            ".sh",
            ".py",
            ".ts",
            ".js",
            ".mjs",
            ".yaml",
            ".yml",
        } and not has_shell_shebang(path):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if text and not text.endswith("\n"):
            failures.append(f"{path}: missing final newline")
        for number, line in enumerate(text.splitlines(), 1):
            if line.rstrip() != line:
                failures.append(f"{path}:{number}: trailing whitespace")
            if (
                format_mode
                and "\t" in line
                and path.suffix.lower()
                in {".md", ".sql", ".py", ".ts", ".js", ".mjs", ".yaml", ".yml"}
            ):
                failures.append(f"{path}:{number}: tab is not canonical")
            if (
                not format_mode
                and re.search(r"\b(?:TODO|FIXME)\b", line)  # WX-M0-010
                and not BACKLOG_MARKER.search(line)
            ):
                failures.append(  # WX-M0-010
                    f"{path}:{number}: TODO/FIXME needs a WX-Mn-NNN backlog ID (WX-M0-010 policy)"
                )
        if format_mode and path.suffix.lower() == ".md" and re.search(r"(?m)^[-*+]\S", text):
            failures.append(f"{path}: Markdown list marker needs one following space")
        if format_mode and path.suffix.lower() in {".ts", ".js", ".mjs"}:
            if re.search(r"\b(?:const|let|var)\s+\w+=\{", text):
                failures.append(f"{path}: non-canonical TypeScript object spacing")
        if (
            format_mode
            and path.suffix.lower() == ".sql"
            and re.search(r"(?m)^\s*(?:create|select|insert|update|delete)\b", text)
        ):
            failures.append(f"{path}: SQL keywords must use canonical uppercase")
        if (
            format_mode
            and has_shell_shebang(path)
            and re.search(r"\b(?:if|while)\s+[^\n;]+;then\b", text)
        ):
            failures.append(f"{path}: non-canonical shell control spacing")
        if not format_mode and path.suffix.lower() == ".md":
            if text.count("```") % 2:
                failures.append(f"{path}: unclosed fenced code block")
            if re.search(r"(?m)^#+[^ #]", text):
                failures.append(f"{path}: malformed Markdown heading")
        if not format_mode and has_shell_shebang(path):
            first = text.splitlines()[0] if text.splitlines() else ""
            if "bash" not in first and re.search(r"(?m)^\s*[A-Za-z_][A-Za-z0-9_]*=\(", text):
                failures.append(f"{path}: Bash array syntax is not valid for a POSIX shell")
            for number, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                if has_unquoted_shell_expansion(line):
                    failures.append(f"{path}:{number}: unquoted shell expansion (SC2086 class)")
    return failures


def has_unquoted_shell_expansion(line: str) -> bool:
    """Return true for a variable or command expansion outside shell quotes."""
    quote: str | None = None
    escaped = False
    for index, character in enumerate(line):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote != "'":
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
            continue
        if character != "$" or quote is not None or index + 1 >= len(line):
            continue
        following = line[index + 1]
        if following.isalpha() or following == "_" or following == "{":
            return True
    return False


def sql_parse(paths: Iterable[Path]) -> None:
    for path in paths:
        if path.suffix.lower() != ".sql":
            continue
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(path.read_text(encoding="utf-8"))
        except sqlite3.Error as error:
            raise QualityError(f"{path}: SQLite parse failed: {error}") from error
        finally:
            connection.close()


def shell_syntax(paths: Iterable[Path]) -> None:
    for path in paths:
        if not has_shell_shebang(path):
            continue
        with path.open("rb") as stream:
            first = stream.readline(200).decode("utf-8", "ignore")
        command = ["bash", "-n", str(path)] if "bash" in first else ["sh", "-n", str(path)]
        run(command)


def relevant(area: str, language: str) -> bool:
    if area == "all" or area == language:
        return True
    if area == "contracts":
        return language in {"typescript", "python", "sql", "shell", "docs"}
    if area == "fixtures":
        return language in {"typescript", "docs"}
    if area == "compose":
        return language in {"python", "docs"}
    if area == "tooling":
        return language in {"typescript", "python", "shell", "docs"}
    return False


def run_format(area: str, selected: list[Path]) -> None:
    editable = [path for path in selected if not is_generated(path)]
    failures = text_failures(editable, format_mode=True)
    if failures:
        raise QualityError("format check failed:\n" + "\n".join(failures))
    if relevant(area, "python"):
        python = [
            str(path.relative_to(ROOT))
            for path in editable
            if path.suffix == ".py"
            and path.name != "validate_contracts.py"
            and not path.is_relative_to(ROOT / "deploy/compose")
        ]
        if python:
            run(["uv", "run", "ruff", "format", "--check", *python])
    if relevant(area, "typescript"):
        run(
            [
                "pnpm",
                "exec",
                "eslint",
                *(
                    str(path.relative_to(ROOT))
                    for path in editable
                    if path.suffix.lower() in {".ts", ".js", ".mjs", ".cjs"}
                ),
            ]
        )
    if area in {"all", "contracts"}:
        run(["python3", "packages/contracts/scripts/generate_types.py", "--check"])
        run(["python3", "packages/contracts/scripts/generate_openapi.py", "--check"])


def run_lint(area: str, selected: list[Path]) -> None:
    editable = [path for path in selected if not is_generated(path)]
    failures = text_failures(editable, format_mode=False)
    if failures:
        raise QualityError("lint check failed:\n" + "\n".join(failures))
    if relevant(area, "typescript"):
        run(
            [
                "pnpm",
                "exec",
                "eslint",
                *(
                    str(path.relative_to(ROOT))
                    for path in editable
                    if path.suffix.lower() in {".ts", ".js", ".mjs", ".cjs"}
                ),
            ]
        )
    if relevant(area, "python"):
        python = [
            str(path.relative_to(ROOT))
            for path in editable
            if path.suffix == ".py"
            and path.name != "validate_contracts.py"
            and not path.is_relative_to(ROOT / "deploy/compose")
        ]
        if python:
            run(["uv", "run", "ruff", "check", *python])
        compose_python = [
            str(path.relative_to(ROOT))
            for path in editable
            if path.suffix == ".py" and path.is_relative_to(ROOT / "deploy/compose")
        ]
        if compose_python:
            run(["uv", "run", "ruff", "check", "--ignore", "E501", *compose_python])
        if any(path.name == "validate_contracts.py" for path in editable):
            run(
                [
                    "uv",
                    "run",
                    "ruff",
                    "check",
                    "--ignore",
                    "E501,UP035",
                    "packages/contracts/validate_contracts.py",
                ]
            )
    if relevant(area, "sql"):
        sql_parse(editable)
    if relevant(area, "shell"):
        shell_syntax(editable)


def run_typecheck(area: str) -> None:
    ran = False
    if relevant(area, "typescript"):
        run(["pnpm", "run", "typecheck"])
        run(["pnpm", "exec", "tsc", "-p", "packages/contracts/tests/generated/tsconfig.json"])
        ran = True
    if relevant(area, "python") and area != "compose":
        run(
            [
                "uv",
                "run",
                "mypy",
                "scripts",
                "packages/contracts/scripts/generate_types.py",
                "packages/contracts/tests/generated/check_generated.py",
                "packages/contracts/tests/generated/python_smoke.py",
                "packages/contracts/generated/python",
            ]
        )
        run(
            [
                "uv",
                "run",
                "mypy",
                "--explicit-package-bases",
                "packages/contracts/generated/openapi/python",
            ]
        )
        run(
            [
                "uv",
                "run",
                "mypy",
                "--ignore-missing-imports",
                "--disable-error-code",
                "attr-defined",
                "packages/contracts/scripts/generate_openapi.py",
                "packages/contracts/tests/generated/check_openapi_generated.py",
            ]
        )
        run(
            [
                "uv",
                "run",
                "mypy",
                "--ignore-missing-imports",
                "--disable-error-code",
                "arg-type",
                "--disable-error-code",
                "no-any-return",
                "packages/contracts/validate_contracts.py",
            ]
        )
        run(
            [
                "uv",
                "run",
                "mypy",
                "--ignore-missing-imports",
                "--disable-error-code",
                "type-var",
                "packages/contracts/validate_openapi.py",
            ]
        )
        ran = True
    if area in {"all", "python", "compose"}:
        run(
            [
                "uv",
                "run",
                "mypy",
                "--ignore-missing-imports",
                "--disable-error-code",
                "assignment",
                "deploy/compose/validate.py",
            ]
        )
        run(
            [
                "uv",
                "run",
                "mypy",
                "--ignore-missing-imports",
                "--disable-error-code",
                "attr-defined",
                "deploy/compose/tests/test_validate.py",
            ]
        )
        ran = True
    if not ran:
        raise QualityError(f"typecheck AREA={area} selected zero typecheck projects")


def run_test_unit(area: str) -> None:
    commands: list[list[str]] = []
    if area in {"all", "typescript", "fixtures"}:
        commands.append(["pnpm", "--filter", "@webx/test-fixtures", "test"])
    if area in {"all", "python", "tooling"}:
        commands.append(["uv", "run", "pytest"])
    if area in {"all", "python", "compose"}:
        commands.append(
            [
                "python3",
                "-m",
                "unittest",
                "discover",
                "-s",
                "deploy/compose/tests",
                "-p",
                "test_*.py",
            ]
        )
    if area in {"all", "python", "contracts", "sql"}:
        commands.append(["packages/contracts/check.sh"])
    if area in {"all", "shell", "docs", "tooling"}:
        commands.append(["python3", "scripts/quality_check_test.py", "--self-test-area", area])
    if not commands:
        raise QualityError(f"test-unit AREA={area} selected zero unit test projects")
    for command in commands:
        run(command)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("--area", default=os.environ.get("AREA", "all"))
    parser.add_argument("--ac", default=os.environ.get("AC", ""))
    parser.add_argument("--profile", default=os.environ.get("PROFILE", ""))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        validate_selector(args.area, args.ac, args.profile)
        paths = tracked_files()
        registry = classify(paths)
        selected = selected_files(args.area, registry, paths)
        print(f"quality-check: target={args.target} area={args.area} files={len(selected)}")
        if args.target == "format":
            run_format(args.area, selected)
        elif args.target == "lint":
            run_lint(args.area, selected)
        elif args.target == "typecheck":
            run_typecheck(args.area)
        else:
            run_test_unit(args.area)
    except QualityError as error:
        print(f"quality-check: ERROR: {error}", file=sys.stderr)
        return 2
    print(f"quality-check: OK target={args.target} area={args.area}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
