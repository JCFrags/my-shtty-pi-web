import json
from pathlib import Path

import pytest
from toolchain_dependency_inventory import (
    InventoryError,
    build_inventory,
    build_notices,
    build_sbom,
    render_outputs,
    validate_catalog,
    validate_release,
)


def entry(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "component:example",
        "name": "Example",
        "kind": "runtime",
        "version": "1.2.3",
        "license": "MIT",
        "source": "https://example.invalid/example/1.2.3",
        "notice": "Retain the MIT license.",
        "scope": "runtime",
        "bundled": False,
        "component_refs": ["example"],
        "security_channel": "https://example.invalid/security",
        "platform_support": "Linux",
        "health_fixture": "fixture:example",
        "upgrade_rollback": "Restore the prior lock.",
        "replacement": "Safely disable.",
    }
    value.update(changes)
    return value


def component_lock(*ids: str) -> dict[str, object]:
    return {
        "components": [
            {
                "id": component_id,
                "artifacts": [{"id": "linux-x64", "digest": "sha256:" + "a" * 64}],
            }
            for component_id in ids
        ]
    }


def catalog(*entries: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "generated_at": "2026-08-12T06:00:00Z",
        "entries": list(entries),
    }


def write_manifests(
    root: Path, npm: dict[str, str] | None = None, python: list[str] | None = None
) -> None:
    (root / "package.json").write_text(json.dumps({"devDependencies": npm or {}}), encoding="utf-8")
    requirements = ", ".join(json.dumps(item) for item in (python or []))
    (root / "pyproject.toml").write_text(
        f"[dependency-groups]\ndev = [{requirements}]\n", encoding="utf-8"
    )


def test_inventory_and_outputs_are_deterministic(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    entries = validate_catalog(catalog(entry()), component_lock("example"), tmp_path)
    inventory = build_inventory(catalog(entry()), entries)
    first = json.dumps(build_sbom(inventory, component_lock("example")), sort_keys=True)
    second = json.dumps(build_sbom(inventory, component_lock("example")), sort_keys=True)
    assert first == second
    assert build_notices(inventory) == build_notices(inventory)


def test_duplicate_inventory_ids_are_rejected(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    with pytest.raises(InventoryError, match="IDs must be unique"):
        validate_catalog(catalog(entry(), entry()), component_lock("example"), tmp_path)


def test_incomplete_source_version_and_license_are_rejected(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    for field in ("source", "version", "license"):
        with pytest.raises(InventoryError, match=field):
            validate_catalog(catalog(entry(**{field: ""})), component_lock("example"), tmp_path)


def test_unresolved_enabled_license_fails_release(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    entries = validate_catalog(
        catalog(entry(license="UNRESOLVED", version="UNRESOLVED_WX_M0_004")),
        component_lock("example"),
        tmp_path,
    )
    with pytest.raises(InventoryError, match="component:example"):
        validate_release(entries)


def test_unresolved_safe_disabled_optional_entry_passes_release(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    entries = validate_catalog(
        catalog(entry(license="UNRESOLVED", enabled=False)), component_lock("example"), tmp_path
    )
    validate_release(entries)
    assert entries[0]["license_status"] == "safe-disabled"


def test_private_paths_and_secret_sources_are_rejected(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    with pytest.raises(InventoryError, match="private host path"):
        validate_catalog(
            catalog(entry(source="/home/person/private/package")),
            component_lock("example"),
            tmp_path,
        )
    with pytest.raises(InventoryError, match="appears to contain a secret"):
        validate_catalog(
            catalog(entry(source="https://example.invalid/?token=not-a-real-value")),
            component_lock("example"),
            tmp_path,
        )


def test_component_lock_cross_check_requires_every_component(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    with pytest.raises(InventoryError, match="missing from inventory: second"):
        validate_catalog(catalog(entry()), component_lock("example", "second"), tmp_path)


def test_direct_manifest_version_drift_is_rejected(tmp_path: Path) -> None:
    write_manifests(tmp_path, npm={"eslint": "10.8.1"})
    package_entry = entry(
        id="npm:eslint",
        name="eslint",
        kind="npm",
        version="10.0.0",
        component_refs=["example"],
    )
    with pytest.raises(InventoryError, match=r"version_drift=\['npm:eslint'\]"):
        validate_catalog(catalog(package_entry), component_lock("example"), tmp_path)


def test_generated_drift_is_visible(tmp_path: Path) -> None:
    write_manifests(tmp_path)
    (tmp_path / "deploy").mkdir()
    catalog_path = tmp_path / "deploy/dependency-catalog.json"
    lock_path = tmp_path / "deploy/component-lock.json"
    catalog_path.write_text(json.dumps(catalog(entry())), encoding="utf-8")
    lock_path.write_text(json.dumps(component_lock("example")), encoding="utf-8")
    outputs = render_outputs(catalog_path, lock_path, tmp_path)
    assert tmp_path / "deploy/dependency-inventory.json" in outputs
    assert tmp_path / "deploy/sbom.cdx.json" in outputs
    assert tmp_path / "THIRD_PARTY_NOTICES.md" in outputs
    assert all(not path.exists() for path in outputs)
