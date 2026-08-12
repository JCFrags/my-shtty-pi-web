#!/usr/bin/env python3
"""Resolve and validate the WebX component lock without executing components."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Final

ROOT: Final = Path(__file__).resolve().parent.parent
SHA256_PATTERN: Final = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
FLOATING_PATTERN: Final = re.compile(r"(^|[/:@])latest($|[/:@])|[*^~<>]|\bmain\b|\bmaster\b", re.I)


class ComponentLockError(Exception):
    """A component cannot be safely locked."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def is_floating(value: str) -> bool:
    return bool(FLOATING_PATTERN.search(value))


def resolve_component(component: dict[str, Any], root: Path = ROOT) -> dict[str, Any]:
    required = {"id", "kind", "source", "version", "license", "health_fixture"}
    missing = sorted(required - component.keys())
    if missing:
        raise ComponentLockError(f"component is missing fields: {', '.join(missing)}")
    result: dict[str, Any] = {
        "id": str(component["id"]),
        "kind": str(component["kind"]),
        "source": str(component["source"]),
        "version": str(component["version"]),
        "license": str(component["license"]),
        "enabled": bool(component.get("enabled", True)),
        "health_fixture": str(component["health_fixture"]),
    }
    digest_file = component.get("digest_file")
    if digest_file is not None:
        candidate = (root / str(digest_file)).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError as error:
            raise ComponentLockError(f"digest_file escapes repository: {digest_file}") from error
        if not candidate.is_file():
            raise ComponentLockError(f"digest_file does not exist: {digest_file}")
        result["digest"] = file_sha256(candidate)
    else:
        result["digest"] = component.get("digest")
    unresolved = result["version"].startswith("UNRESOLVED_") or result["digest"] is None
    floating = is_floating(result["source"]) or is_floating(result["version"])
    digest = result["digest"]
    invalid_digest = digest is not None and not SHA256_PATTERN.fullmatch(str(digest))
    if floating:
        result["status"] = "floating"
    elif invalid_digest:
        result["status"] = "invalid-digest"
    elif unresolved:
        result["status"] = "disabled" if not result["enabled"] else "unresolved"
    else:
        result["status"] = "resolved"
    return result


def build_lock(catalog: dict[str, Any], resolved_at: str, root: Path = ROOT) -> dict[str, Any]:
    if catalog.get("schema_version") != 1:
        raise ComponentLockError("catalog schema_version must be 1")
    raw_components = catalog.get("components")
    if not isinstance(raw_components, list):
        raise ComponentLockError("catalog components must be a list")
    components = [resolve_component(component, root) for component in raw_components]
    ids = [component["id"] for component in components]
    if len(ids) != len(set(ids)):
        raise ComponentLockError("component IDs must be unique")
    components.sort(key=lambda component: component["id"])
    return {
        "schema_version": 1,
        "resolved_at": resolved_at,
        "generated_by": "scripts/toolchain-component-lock",
        "policy": {
            "floating_versions_allowed": False,
            "sha256_digest_required": True,
            "release_requires_all_enabled_resolved": True,
        },
        "components": components,
    }


def validate_release(lock: dict[str, Any]) -> None:
    failures = [
        f"{component['id']}: {component['status']}"
        for component in lock["components"]
        if component["enabled"] and component["status"] != "resolved"
    ]
    if failures:
        detail = "\n".join(f"  - {failure}" for failure in failures)
        raise ComponentLockError(f"release component lock is incomplete:\n{detail}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=ROOT / "deploy/component-catalog.json")
    parser.add_argument("--output", type=Path, default=ROOT / "deploy/component-lock.json")
    parser.add_argument(
        "--resolved-at", required=True, help="RFC 3339 UTC timestamp for stable output"
    )
    parser.add_argument("--mode", choices=("development", "release"), default="development")
    parser.add_argument(
        "--check", action="store_true", help="fail when output differs instead of writing"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
        lock = build_lock(catalog, args.resolved_at)
        if args.mode == "release":
            validate_release(lock)
        content = json.dumps(lock, indent=2, sort_keys=True) + "\n"
        if args.check:
            if not args.output.is_file() or args.output.read_text(encoding="utf-8") != content:
                raise ComponentLockError(f"generated lock differs: {args.output}")
        else:
            args.output.write_text(content, encoding="utf-8")
    except (ComponentLockError, json.JSONDecodeError, OSError) as error:
        print(f"component-lock: ERROR: {error}", file=sys.stderr)
        return 2
    print(f"component-lock: OK ({args.mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
