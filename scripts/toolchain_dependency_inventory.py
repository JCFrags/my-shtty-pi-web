#!/usr/bin/env python3
"""Generate the WebX dependency inventory, CycloneDX SBOM, and notices."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import uuid
from pathlib import Path
from typing import Any, Final

ROOT: Final = Path(__file__).resolve().parent.parent
REQUIRED_FIELDS: Final = {
    "id",
    "name",
    "kind",
    "version",
    "license",
    "source",
    "notice",
    "scope",
    "bundled",
    "component_refs",
    "security_channel",
    "platform_support",
    "health_fixture",
    "upgrade_rollback",
    "replacement",
}
UNRESOLVED: Final = "UNRESOLVED"
PRIVATE_PATH: Final = re.compile(r"(?:^|[\s:/])(?:home|Users)/[^/\s]+/|^[A-Za-z]:\\")
SECRET_SOURCE: Final = re.compile(r"(?i)(?:token|password|api[_-]?key|secret)=")


class InventoryError(Exception):
    """Dependency inventory input is incomplete or inconsistent."""


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise InventoryError(f"{path}: expected an object")
    return value


def direct_manifest_dependencies(root: Path) -> dict[str, str]:
    package = load_json(root / "package.json")
    result = {
        f"npm:{name}": str(version)
        for group in ("dependencies", "devDependencies", "optionalDependencies")
        for name, version in package.get(group, {}).items()
    }
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    for requirement in project.get("dependency-groups", {}).get("dev", []):
        name, separator, version = requirement.partition("==")
        if not separator:
            raise InventoryError(f"pyproject direct dependency is not exact: {requirement}")
        result[f"pypi:{name.lower()}"] = version
    return result


def validate_entry(entry: dict[str, Any], component_ids: set[str]) -> dict[str, Any]:
    missing = sorted(REQUIRED_FIELDS - entry.keys())
    entry_id = str(entry.get("id", "<unknown>"))
    if missing:
        raise InventoryError(f"{entry_id}: missing fields: {', '.join(missing)}")
    for field in REQUIRED_FIELDS - {"bundled", "component_refs"}:
        if not isinstance(entry[field], str) or not entry[field].strip():
            raise InventoryError(f"{entry_id}: {field} must be a non-empty string")
    if not isinstance(entry["bundled"], bool):
        raise InventoryError(f"{entry_id}: bundled must be boolean")
    refs = entry["component_refs"]
    if not isinstance(refs, list) or not refs or not all(isinstance(ref, str) for ref in refs):
        raise InventoryError(f"{entry_id}: component_refs must be a non-empty string list")
    unknown_refs = sorted(set(refs) - component_ids)
    if unknown_refs:
        raise InventoryError(f"{entry_id}: unknown component refs: {', '.join(unknown_refs)}")
    for field in ("source", "notice", "security_channel"):
        value = entry[field]
        if PRIVATE_PATH.search(value):
            raise InventoryError(f"{entry_id}: {field} contains a private host path")
        if SECRET_SOURCE.search(value):
            raise InventoryError(f"{entry_id}: {field} appears to contain a secret")
    result = dict(entry)
    enabled = bool(result.get("enabled", True))
    if result["license"] == UNRESOLVED:
        result["license_status"] = "unresolved" if enabled else "safe-disabled"
    else:
        result["license_status"] = "resolved"
    return result


def validate_catalog(
    catalog: dict[str, Any], component_lock: dict[str, Any], root: Path = ROOT
) -> list[dict[str, Any]]:
    if catalog.get("schema_version") != 1:
        raise InventoryError("dependency catalog schema_version must be 1")
    generated_at = catalog.get("generated_at")
    if not isinstance(generated_at, str) or not generated_at.endswith("Z"):
        raise InventoryError("dependency catalog generated_at must be RFC 3339 UTC")
    raw_entries = catalog.get("entries")
    if not isinstance(raw_entries, list) or not all(
        isinstance(entry, dict) for entry in raw_entries
    ):
        raise InventoryError("dependency catalog entries must be objects")
    component_ids = {str(component["id"]) for component in component_lock.get("components", [])}
    entries = [validate_entry(entry, component_ids) for entry in raw_entries]
    ids = [entry["id"] for entry in entries]
    if len(ids) != len(set(ids)):
        raise InventoryError("dependency inventory IDs must be unique")

    represented_components = {ref for entry in entries for ref in entry["component_refs"]}
    missing_components = sorted(component_ids - represented_components)
    if missing_components:
        raise InventoryError(
            f"component-lock entries missing from inventory: {', '.join(missing_components)}"
        )

    manifests = direct_manifest_dependencies(root)
    inventory_packages = {
        entry["id"]: entry["version"]
        for entry in entries
        if entry["id"].startswith(("npm:", "pypi:"))
    }
    if manifests != inventory_packages:
        missing = sorted(set(manifests) - set(inventory_packages))
        extra = sorted(set(inventory_packages) - set(manifests))
        drift = sorted(
            key
            for key in set(manifests) & set(inventory_packages)
            if manifests[key] != inventory_packages[key]
        )
        raise InventoryError(
            f"direct manifest drift; missing={missing}, extra={extra}, version_drift={drift}"
        )
    return sorted(entries, key=lambda entry: entry["id"])


def validate_release(entries: list[dict[str, Any]]) -> None:
    failures = [
        entry["id"]
        for entry in entries
        if entry["license_status"] == "unresolved" and bool(entry.get("enabled", True))
    ]
    if failures:
        raise InventoryError(
            "release dependency licenses are unresolved:\n"
            + "\n".join(f"  - {entry_id}" for entry_id in failures)
        )


def build_inventory(catalog: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": catalog["generated_at"],
        "generated_by": "scripts/dependency-inventory",
        "entries": entries,
    }


def build_sbom(inventory: dict[str, Any], component_lock: dict[str, Any]) -> dict[str, Any]:
    lock_by_id = {component["id"]: component for component in component_lock["components"]}
    components = []
    for entry in inventory["entries"]:
        hashes = []
        for ref in entry["component_refs"]:
            if entry["id"] != f"component:{ref}":
                continue
            for artifact in lock_by_id[ref].get("artifacts", []):
                digest = artifact["digest"]
                if digest.startswith("sha256:"):
                    hashes.append({"alg": "SHA-256", "content": digest.removeprefix("sha256:")})
        license_value = entry["license"]
        license_record = (
            {"license": {"name": license_value}}
            if license_value in {"AGGREGATE", "HOST-PACKAGES-NOT-BUNDLED", UNRESOLVED}
            else {"expression": license_value}
        )
        component: dict[str, Any] = {
            "bom-ref": entry["id"],
            "type": "application" if entry["kind"] in {"runtime", "container-image"} else "library",
            "name": entry["name"],
            "version": entry["version"],
            "licenses": [license_record],
            "scope": "excluded" if not entry.get("enabled", True) else "required",
            "properties": [
                {"name": "webx:scope", "value": entry["scope"]},
                {"name": "webx:bundled", "value": str(entry["bundled"]).lower()},
                {"name": "webx:license-status", "value": entry["license_status"]},
            ],
            "externalReferences": [{"type": "distribution", "url": entry["source"]}],
        }
        if entry.get("purl"):
            component["purl"] = entry["purl"]
        if hashes:
            unique = {(item["alg"], item["content"]): item for item in hashes}
            component["hashes"] = [unique[key] for key in sorted(unique)]
        components.append(component)
    identity = uuid.uuid5(
        uuid.NAMESPACE_URL,
        json.dumps(inventory, sort_keys=True, separators=(",", ":")),
    )
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{identity}",
        "version": 1,
        "metadata": {
            "timestamp": inventory["generated_at"],
            "component": {
                "bom-ref": "webx",
                "type": "application",
                "name": "WebX",
                "version": "0.0.0",
            },
            "tools": {
                "components": [
                    {"type": "application", "name": "WebX dependency inventory", "version": "1"}
                ]
            },
        },
        "components": components,
    }


def build_notices(inventory: dict[str, Any]) -> str:
    lines = [
        "# Third-Party Notices",
        "",
        "Generated by `scripts/dependency-inventory`. Do not edit this file directly.",
        "",
        "This inventory is an engineering record. It is not legal advice.",
        "",
    ]
    for entry in inventory["entries"]:
        lines.extend(
            [
                f"## {entry['name']} {entry['version']}",
                "",
                f"- Inventory ID: `{entry['id']}`",
                f"- License: `{entry['license']}` ({entry['license_status']})",
                f"- Source: {entry['source']}",
                f"- Use: {entry['scope']}; bundled: {str(entry['bundled']).lower()}",
                f"- Notice: {entry['notice']}",
                "",
            ]
        )
    return "\n".join(lines)


def render_outputs(catalog_path: Path, lock_path: Path, root: Path = ROOT) -> dict[Path, str]:
    catalog = load_json(catalog_path)
    component_lock = load_json(lock_path)
    entries = validate_catalog(catalog, component_lock, root)
    inventory = build_inventory(catalog, entries)
    return {
        root / "deploy/dependency-inventory.json": json.dumps(inventory, indent=2, sort_keys=True)
        + "\n",
        root / "deploy/sbom.cdx.json": json.dumps(
            build_sbom(inventory, component_lock), indent=2, sort_keys=True
        )
        + "\n",
        root / "THIRD_PARTY_NOTICES.md": build_notices(inventory),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=ROOT / "deploy/dependency-catalog.json")
    parser.add_argument("--component-lock", type=Path, default=ROOT / "deploy/component-lock.json")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--mode", choices=("development", "release"), default="development")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        outputs = render_outputs(args.catalog, args.component_lock)
        inventory = json.loads(outputs[ROOT / "deploy/dependency-inventory.json"])
        if args.mode == "release":
            validate_release(inventory["entries"])
        for path, content in outputs.items():
            if args.check:
                if not path.is_file() or path.read_text(encoding="utf-8") != content:
                    raise InventoryError(f"generated output differs: {path}")
            else:
                path.write_text(content, encoding="utf-8")
    except (InventoryError, json.JSONDecodeError, OSError, tomllib.TOMLDecodeError) as error:
        print(f"dependency-inventory: ERROR: {error}", file=sys.stderr)
        return 2
    print(f"dependency-inventory: OK ({args.mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
