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
SHA256_PATTERN: Final = re.compile(r"^sha256:[0-9a-f]{64}$")
SRI_SHA512_PATTERN: Final = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
FLOATING_PATTERN: Final = re.compile(
    r"(^|[/:@])latest($|[/:@])|[*^~<>]|(^|[/:@])(main|master)($|[/:@])", re.I
)
UNRESOLVED_PATTERN: Final = re.compile(r"^UNRESOLVED_[A-Z0-9_]+$")


class ComponentLockError(Exception):
    """A component cannot be safely locked."""


def file_sha256(path: Path) -> str:
    """Return a lowercase SHA-256 digest for one local lock input."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def is_valid_digest(value: object) -> bool:
    """Accept OCI/SHA-256 digests and npm SHA-512 integrity values."""
    return isinstance(value, str) and bool(
        SHA256_PATTERN.fullmatch(value) or SRI_SHA512_PATTERN.fullmatch(value)
    )


def is_floating(value: str) -> bool:
    """Identify versions and sources that do not name immutable input."""
    return bool(FLOATING_PATTERN.search(value))


def repository_file(root: Path, raw_path: object) -> Path:
    """Resolve a regular file while denying lexical and symlink path escape."""
    relative = Path(str(raw_path))
    if relative.is_absolute():
        raise ComponentLockError(f"digest file must be relative: {raw_path}")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise ComponentLockError(f"digest file escapes repository: {raw_path}") from error
    if not candidate.is_file():
        raise ComponentLockError(f"digest file does not exist: {raw_path}")
    return candidate


def resolve_component(component: dict[str, Any], root: Path = ROOT) -> dict[str, Any]:
    """Normalize one reviewed catalog entry and calculate local lock digests."""
    required = {
        "id",
        "kind",
        "source",
        "version",
        "license",
        "health_fixture",
        "rollback",
    }
    missing = sorted(required - component.keys())
    if missing:
        raise ComponentLockError(f"component is missing fields: {', '.join(missing)}")

    component_id = str(component["id"])
    source = str(component["source"])
    version = str(component["version"])
    enabled = bool(component.get("enabled", True))
    rollback = component["rollback"]
    if not isinstance(rollback, dict) or not rollback.get("mode"):
        raise ComponentLockError(f"{component_id}: rollback.mode is required")

    raw_artifacts = component.get("artifacts", [])
    raw_digest_files = component.get("digest_files", [])
    if not isinstance(raw_artifacts, list) or not isinstance(raw_digest_files, list):
        raise ComponentLockError(f"{component_id}: artifacts and digest_files must be lists")

    artifacts: list[dict[str, str]] = []
    artifact_ids: set[str] = set()
    invalid_digest = False
    for raw_artifact in raw_artifacts:
        if (
            not isinstance(raw_artifact, dict)
            or "id" not in raw_artifact
            or "digest" not in raw_artifact
        ):
            raise ComponentLockError(f"{component_id}: each artifact needs id and digest")
        artifact_id = str(raw_artifact["id"])
        digest = str(raw_artifact["digest"])
        if artifact_id in artifact_ids:
            raise ComponentLockError(f"{component_id}: duplicate artifact ID: {artifact_id}")
        artifact_ids.add(artifact_id)
        invalid_digest = invalid_digest or not is_valid_digest(digest)
        artifacts.append({"id": artifact_id, "digest": digest})

    for raw_path in raw_digest_files:
        path = repository_file(root, raw_path)
        artifact_id = f"file:{Path(str(raw_path)).as_posix()}"
        if artifact_id in artifact_ids:
            raise ComponentLockError(f"{component_id}: duplicate artifact ID: {artifact_id}")
        artifact_ids.add(artifact_id)
        artifacts.append({"id": artifact_id, "digest": file_sha256(path)})

    artifacts.sort(key=lambda artifact: artifact["id"])
    floating = is_floating(source) or is_floating(version)
    unresolved = bool(UNRESOLVED_PATTERN.fullmatch(version)) or not artifacts
    if floating:
        status = "floating"
    elif invalid_digest:
        status = "invalid-digest"
    elif unresolved:
        status = "disabled" if not enabled else "unresolved"
    else:
        status = "resolved"

    result: dict[str, Any] = {
        "id": component_id,
        "kind": str(component["kind"]),
        "source": source,
        "version": version,
        "license": str(component["license"]),
        "enabled": enabled,
        "status": status,
        "artifacts": artifacts,
        "health_fixture": str(component["health_fixture"]),
        "rollback": rollback,
    }
    for optional_key in ("compatibility", "depends_on"):
        if optional_key in component:
            result[optional_key] = component[optional_key]
    return result


def build_lock(
    catalog: dict[str, Any], resolved_at: str | None = None, root: Path = ROOT
) -> dict[str, Any]:
    """Build deterministic lock output from reviewed catalog data."""
    if catalog.get("schema_version") != 2:
        raise ComponentLockError("catalog schema_version must be 2")
    catalog_time = catalog.get("resolved_at")
    if not isinstance(catalog_time, str) or not catalog_time.endswith("Z"):
        raise ComponentLockError("catalog resolved_at must be an RFC 3339 UTC string")
    if resolved_at is not None and resolved_at != catalog_time:
        raise ComponentLockError(
            f"resolved_at differs from catalog: expected {catalog_time}, got {resolved_at}"
        )
    raw_components = catalog.get("components")
    if not isinstance(raw_components, list):
        raise ComponentLockError("catalog components must be a list")
    if not all(isinstance(component, dict) for component in raw_components):
        raise ComponentLockError("each catalog component must be an object")
    components = [resolve_component(component, root) for component in raw_components]
    ids = [component["id"] for component in components]
    if len(ids) != len(set(ids)):
        raise ComponentLockError("component IDs must be unique")
    components.sort(key=lambda component: component["id"])
    return {
        "schema_version": 2,
        "resolved_at": catalog_time,
        "generated_by": "scripts/toolchain-component-lock",
        "policy": {
            "floating_versions_allowed": False,
            "immutable_digest_required": True,
            "release_requires_all_enabled_resolved": True,
            "unresolved_disabled_optional_allowed": True,
        },
        "components": components,
    }


def validate_release(lock: dict[str, Any]) -> None:
    """Reject an enabled component that is not immutable and resolved."""
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
    parser.add_argument("--resolved-at", help="must equal the reviewed catalog timestamp")
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
