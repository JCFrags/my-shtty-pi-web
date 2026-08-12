#!/usr/bin/env python3
"""Validate WebX documentation links, IDs, and backlog relationships."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.parse
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
FIXTURE_ROOT: Final = Path(__file__).resolve().parent / "docs_fixtures" / "normative"
BACKLOG_FIELDS: Final = (
    "id",
    "milestone",
    "priority",
    "title",
    "owner_role",
    "size",
    "status",
    "dependencies",
    "requirement_ids",
    "acceptance_ids",
    "deliverable",
    "acceptance_criteria",
)
ACCEPTANCE_FIELDS: Final = (
    "acceptance_id",
    "title",
    "target_milestone",
    "test_layer",
    "canonical_command",
    "required_profiles",
    "release_blocking",
    "evidence",
)
BACKLOG_ID: Final = re.compile(r"^WX-M(?:[0-9]|1[0-2])-[0-9]{3}$")
MILESTONE: Final = re.compile(r"^M(?:[0-9]|1[0-2])$")
ACCEPTANCE_ID: Final = re.compile(r"^AC-[0-9]{3}$")
REFERENCE_ID: Final = re.compile(
    r"\b(?:FR-[0-9]+|NFR-[A-Z]+-[0-9]+|ADR-[0-9]+|AC-[0-9]+|WX-M[0-9]+-[0-9]+)\b"
)
LINK: Final = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
REFERENCE_DEFINITION: Final = re.compile(r"^ {0,3}\[([^\]]+)\]:\s*(\S+)")
REFERENCE_LINK: Final = re.compile(r"!?\[([^\]]+)\]\[([^\]]*)\]")
HTML_ANCHOR: Final = re.compile(
    r"<(?:a|[A-Za-z][A-Za-z0-9-]*)\s+[^>]*(?:id|name)=[\"']([^\"']+)[\"'][^>]*>", re.I
)
HEADING: Final = re.compile(r"^ {0,3}#{1,6}[ \t]+(.+?)\s*$")


class DocsError(Exception):
    """The validator configuration or a required fixture is invalid."""


def display(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def error(path: Path, line: int | None, message: str, root: Path) -> str:
    location = display(path, root)
    if line is not None:
        location += f":{line}"
    return f"{location}: {message}"


def read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DocsError(f"cannot read ID catalog {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DocsError(f"ID catalog is not an object: {path}")
    return value


def read_csv(
    path: Path, fields: tuple[str, ...], root: Path
) -> tuple[list[tuple[int, dict[str, str]]], list[str]]:
    failures: list[str] = []
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if tuple(reader.fieldnames or ()) != fields:
                failures.append(
                    error(path, 1, f"unexpected columns: {reader.fieldnames or []!r}", root)
                )
                return [], failures
            rows: list[tuple[int, dict[str, str]]] = []
            for number, row in enumerate(reader, 2):
                if None in row or any(value is None for value in row.values()):
                    failures.append(error(path, number, "row has the wrong field count", root))
                    continue
                rows.append((number, {key: value for key, value in row.items() if key is not None}))
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        failures.append(error(path, None, f"CSV parse failed: {exc}", root))
        return [], failures
    return rows, failures


def split_ids(value: str) -> list[str]:
    if not value:
        return []
    return value.split(";")


def load_catalog(path: Path) -> tuple[set[str], set[str], set[str], set[str]]:
    value = read_json(path)
    if value.get("schema_version") != 1:
        raise DocsError(f"unsupported ID catalog schema: {path}")
    sets: list[set[str]] = []
    for name in ("requirements", "adrs", "acceptance", "backlog"):
        items = value.get(name)
        if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
            raise DocsError(f"ID catalog {name} values are invalid: {path}")
        if len(items) != len(set(items)):
            raise DocsError(f"ID catalog {name} values contain duplicates: {path}")
        sets.append(set(items))
    return sets[0], sets[1], sets[2], sets[3]


def validate_acceptance(path: Path, root: Path, expected: set[str]) -> tuple[set[str], list[str]]:
    rows, failures = read_csv(path, ACCEPTANCE_FIELDS, root)
    seen: dict[str, int] = {}
    for number, row in rows:
        value = row["acceptance_id"]
        if not ACCEPTANCE_ID.fullmatch(value):
            failures.append(error(path, number, f"invalid acceptance ID: {value!r}", root))
        if value in seen:
            failures.append(
                error(
                    path,
                    number,
                    f"duplicate acceptance ID: {value} (first at line {seen[value]})",
                    root,
                )
            )
        else:
            seen[value] = number
        for field in ACCEPTANCE_FIELDS[1:]:
            if not row[field]:
                failures.append(error(path, number, f"empty required field: {field}", root))
    actual = set(seen)
    if actual != expected:
        failures.append(
            error(
                path,
                1,
                f"acceptance registry differs: missing={sorted(expected - actual)}, "
                f"unexpected={sorted(actual - expected)}",
                root,
            )
        )
    return actual, failures


def milestone_number(value: str) -> int:
    return int(value[1:])


def validate_backlog(
    path: Path,
    root: Path,
    requirements: set[str],
    acceptance: set[str],
    expected: set[str],
) -> tuple[set[str], list[str]]:
    rows, failures = read_csv(path, BACKLOG_FIELDS, root)
    by_id: dict[str, tuple[int, dict[str, str]]] = {}
    order: list[str] = []
    for number, row in rows:
        task_id = row["id"]
        if not BACKLOG_ID.fullmatch(task_id):
            failures.append(error(path, number, f"invalid backlog ID: {task_id!r}", root))
        if task_id in by_id:
            failures.append(
                error(
                    path,
                    number,
                    f"duplicate backlog ID: {task_id} (first at line {by_id[task_id][0]})",
                    root,
                )
            )
        else:
            by_id[task_id] = (number, row)
            order.append(task_id)
        if not MILESTONE.fullmatch(row["milestone"]):
            failures.append(error(path, number, f"invalid milestone: {row['milestone']!r}", root))
        elif BACKLOG_ID.fullmatch(task_id) and row["milestone"] != task_id.split("-")[1]:
            failures.append(
                error(
                    path,
                    number,
                    f"milestone differs from ID: {task_id} -> {row['milestone']}",
                    root,
                )
            )
        if row["priority"] not in {"Must", "Should", "Later", "Out of scope"}:
            failures.append(error(path, number, f"invalid priority: {row['priority']!r}", root))
        if row["size"] not in {"XS", "S", "M", "L"}:
            failures.append(error(path, number, f"invalid size: {row['size']!r}", root))
        if row["status"] not in {"todo", "in_progress", "blocked", "done", "deferred"}:
            failures.append(error(path, number, f"invalid status: {row['status']!r}", root))
        for field in ("title", "owner_role", "deliverable", "acceptance_criteria"):
            if not row[field]:
                failures.append(error(path, number, f"empty required field: {field}", root))
        for requirement in split_ids(row["requirement_ids"]):
            if requirement not in requirements:
                failures.append(error(path, number, f"unknown requirement ID: {requirement}", root))
        for acceptance_id in split_ids(row["acceptance_ids"]):
            if acceptance_id not in acceptance:
                failures.append(
                    error(path, number, f"unknown acceptance ID: {acceptance_id}", root)
                )

    graph: dict[str, list[str]] = {}
    for task_id in order:
        number, row = by_id[task_id]
        dependencies = split_ids(row["dependencies"])
        duplicates = sorted(item for item, count in Counter(dependencies).items() if count > 1)
        for dependency in duplicates:
            failures.append(
                error(path, number, f"duplicate dependency: {task_id} -> {dependency}", root)
            )
        graph[task_id] = dependencies
        for dependency in dependencies:
            if dependency == task_id:
                failures.append(
                    error(path, number, f"self-dependency: {task_id} -> {dependency}", root)
                )
            elif dependency not in by_id:
                failures.append(
                    error(path, number, f"unknown dependency: {task_id} -> {dependency}", root)
                )
            elif MILESTONE.fullmatch(row["milestone"]):
                dependency_milestone = by_id[dependency][1]["milestone"]
                if MILESTONE.fullmatch(dependency_milestone) and milestone_number(
                    dependency_milestone
                ) > milestone_number(row["milestone"]):
                    failures.append(
                        error(
                            path,
                            number,
                            f"dependency points to a later milestone: {task_id} -> {dependency}",
                            root,
                        )
                    )

    state: dict[str, int] = {task_id: 0 for task_id in order}
    stack: list[str] = []

    def visit(task_id: str) -> None:
        state[task_id] = 1
        stack.append(task_id)
        for dependency in graph.get(task_id, []):
            if dependency not in state or dependency == task_id:
                continue
            if state[dependency] == 0:
                visit(dependency)
            elif state[dependency] == 1:
                cycle = stack[stack.index(dependency) :] + [dependency]
                failures.append(
                    error(path, by_id[task_id][0], f"dependency cycle: {' -> '.join(cycle)}", root)
                )
        stack.pop()
        state[task_id] = 2

    for task_id in order:
        if state[task_id] == 0:
            visit(task_id)
    actual = set(by_id)
    if actual != expected:
        failures.append(
            error(
                path,
                1,
                f"backlog registry differs: missing={sorted(expected - actual)}, "
                f"unexpected={sorted(actual - expected)}",
                root,
            )
        )
    return actual, failures


def visible_markdown_lines(text: str) -> Iterable[tuple[int, str]]:
    fence: str | None = None
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        marker = stripped[:3]
        if marker in {"```", "~~~"}:
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
            continue
        if fence is None:
            yield number, line


def link_destination(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("<") and ">" in raw:
        return raw[1 : raw.index(">")]
    return raw.split(maxsplit=1)[0] if raw else ""


def github_slug(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"[`*_~]", "", value).strip().lower()
    return "".join(
        character for character in value if character.isalnum() or character in " _-"
    ).replace(" ", "-")


def markdown_anchors(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    anchors: set[str] = set()
    counts: Counter[str] = Counter()
    for _number, line in visible_markdown_lines(text):
        match = HEADING.match(line)
        if match:
            heading = re.sub(r"\s+#+\s*$", "", match.group(1))
            base = github_slug(heading)
            if base:
                count = counts[base]
                anchors.add(base if count == 0 else f"{base}-{count}")
                counts[base] += 1
        for explicit in HTML_ANCHOR.findall(line):
            anchors.add(urllib.parse.unquote(explicit))
    return anchors


def markdown_paths(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*.md")
        if path.is_file() and ".git" not in path.parts and "node_modules" not in path.parts
    )


def validate_link_target(
    source: Path,
    number: int,
    target: str,
    root: Path,
    anchor_cache: dict[Path, set[str]],
) -> list[str]:
    target = link_destination(target)
    if not target or target.startswith("//"):
        return []
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme:
        return []
    decoded_path = urllib.parse.unquote(parsed.path)
    if decoded_path.startswith("/"):
        resolved = (root / decoded_path.lstrip("/")).resolve()
    else:
        resolved = (source.parent / decoded_path).resolve() if decoded_path else source.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return [error(source, number, f"local link escapes repository: {target}", root)]
    if not resolved.exists():
        return [error(source, number, f"broken local link: {target}", root)]
    if parsed.fragment:
        if not resolved.is_file() or resolved.suffix.lower() != ".md":
            return [error(source, number, f"anchor target is not Markdown: {target}", root)]
        if resolved not in anchor_cache:
            anchor_cache[resolved] = markdown_anchors(resolved)
        fragment = urllib.parse.unquote(parsed.fragment)
        if fragment not in anchor_cache[resolved]:
            return [error(source, number, f"missing Markdown anchor: {target}", root)]
    return []


def validate_markdown_links(root: Path) -> list[str]:
    failures: list[str] = []
    anchor_cache: dict[Path, set[str]] = {}
    for path in markdown_paths(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            failures.append(error(path, None, f"cannot read Markdown: {exc}", root))
            continue
        visible = list(visible_markdown_lines(text))
        definitions: dict[str, tuple[int, str]] = {}
        for number, line in visible:
            match = REFERENCE_DEFINITION.match(line)
            if match:
                key = match.group(1).strip().casefold()
                definitions[key] = (number, match.group(2))
                failures.extend(
                    validate_link_target(path, number, match.group(2), root, anchor_cache)
                )
            for raw in LINK.findall(line):
                failures.extend(validate_link_target(path, number, raw, root, anchor_cache))
        for number, line in visible:
            if REFERENCE_DEFINITION.match(line):
                continue
            for label, reference in REFERENCE_LINK.findall(line):
                key = (reference or label).strip().casefold()
                if key not in definitions:
                    failures.append(
                        error(path, number, f"undefined Markdown link reference: {key}", root)
                    )
    return failures


def validate_markdown_ids(root: Path, known: set[str]) -> list[str]:
    failures: list[str] = []
    for path in markdown_paths(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for value in REFERENCE_ID.findall(line):
                if value not in known:
                    failures.append(error(path, number, f"unknown reference ID: {value}", root))
    return failures


def resolve(root: Path, value: Path) -> Path:
    return value.resolve() if value.is_absolute() else (root / value).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--backlog",
        type=Path,
        default=FIXTURE_ROOT / "backlog.csv",
    )
    parser.add_argument(
        "--acceptance",
        type=Path,
        default=FIXTURE_ROOT / "acceptance-matrix.csv",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=FIXTURE_ROOT / "id-catalog.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    backlog = resolve(root, args.backlog)
    acceptance_path = resolve(root, args.acceptance)
    catalog = resolve(root, args.catalog)
    try:
        requirements, adrs, expected_acceptance, expected_backlog = load_catalog(catalog)
        acceptance, failures = validate_acceptance(acceptance_path, root, expected_acceptance)
        backlog_ids, backlog_failures = validate_backlog(
            backlog, root, requirements, acceptance, expected_backlog
        )
        failures.extend(backlog_failures)
        failures.extend(validate_markdown_links(root))
        known = requirements | adrs | acceptance | backlog_ids
        failures.extend(validate_markdown_ids(root, known))
    except DocsError as exc:
        print(f"docs-check: ERROR: {exc}", file=sys.stderr)
        return 2
    if failures:
        for failure in failures:
            print(f"docs-check: ERROR: {failure}", file=sys.stderr)
        print(f"docs-check: FAILED errors={len(failures)}", file=sys.stderr)
        return 1
    print(
        "docs-check: OK "
        f"markdown={len(markdown_paths(root))} backlog={len(backlog_ids)} "
        f"requirements={len(requirements)} adrs={len(adrs)} acceptance={len(acceptance)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
