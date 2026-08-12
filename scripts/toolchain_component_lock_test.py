import json
from pathlib import Path

import pytest
from toolchain_component_lock import (
    ComponentLockError,
    build_lock,
    file_sha256,
    is_floating,
    validate_release,
)


def component(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "example",
        "kind": "package",
        "source": "example",
        "version": "1.2.3",
        "license": "MIT",
        "health_fixture": "fixture:example",
        "digest": "sha256:" + "a" * 64,
    }
    value.update(changes)
    return value


def test_file_sha256_is_exact(tmp_path: Path) -> None:
    target = tmp_path / "lock"
    target.write_bytes(b"webx\n")
    assert (
        file_sha256(target)
        == "sha256:816030343748fc152e5361493d19af122343373765bc36533338aed9b1eaac6e"
    )


def test_floating_versions_are_detected() -> None:
    assert is_floating("latest")
    assert is_floating("ghcr.io/example/app:latest")
    assert is_floating("^1.2.3")
    assert not is_floating("1.2.3")


def test_output_is_sorted_and_machine_readable() -> None:
    lock = build_lock(
        {"schema_version": 1, "components": [component(id="z"), component(id="a")]},
        "2026-08-12T05:00:00Z",
    )
    encoded = json.dumps(lock, sort_keys=True)
    assert json.loads(encoded)["components"][0]["id"] == "a"


def test_release_rejects_unresolved_and_floating() -> None:
    lock = build_lock(
        {
            "schema_version": 1,
            "components": [
                component(id="unresolved", version="UNRESOLVED_M0", digest=None),
                component(id="floating", version="latest"),
            ],
        },
        "2026-08-12T05:00:00Z",
    )
    with pytest.raises(ComponentLockError, match="release component lock is incomplete") as error:
        validate_release(lock)
    assert "floating: floating" in str(error.value)
    assert "unresolved: unresolved" in str(error.value)


def test_disabled_optional_component_can_remain_unresolved() -> None:
    lock = build_lock(
        {
            "schema_version": 1,
            "components": [
                component(version="UNRESOLVED_M0", digest=None, enabled=False),
            ],
        },
        "2026-08-12T05:00:00Z",
    )
    validate_release(lock)
    assert lock["components"][0]["status"] == "disabled"
