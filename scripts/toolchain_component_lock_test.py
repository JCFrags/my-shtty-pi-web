import json
from pathlib import Path

import pytest
from toolchain_component_lock import (
    ComponentLockError,
    build_lock,
    file_sha256,
    is_floating,
    is_valid_digest,
    resolve_component,
    validate_release,
)

RESOLVED_AT = "2026-08-12T05:00:00Z"


def component(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "example",
        "kind": "package",
        "source": "https://example.invalid/example/1.2.3",
        "version": "1.2.3",
        "license": "MIT",
        "health_fixture": "fixture:example",
        "rollback": {"mode": "safe-disable", "previous_known_good": None},
        "artifacts": [{"id": "package", "digest": "sha256:" + "a" * 64}],
    }
    value.update(changes)
    return value


def catalog(*components: dict[str, object]) -> dict[str, object]:
    return {"schema_version": 2, "resolved_at": RESOLVED_AT, "components": list(components)}


def test_file_sha256_is_exact(tmp_path: Path) -> None:
    target = tmp_path / "lock"
    target.write_bytes(b"webx\n")
    assert (
        file_sha256(target)
        == "sha256:816030343748fc152e5361493d19af122343373765bc36533338aed9b1eaac6e"
    )


def test_digest_validation_accepts_sha256_and_npm_sha512() -> None:
    assert is_valid_digest("sha256:" + "a" * 64)
    assert is_valid_digest("sha512-" + "A" * 86 + "==")
    assert not is_valid_digest("a" * 64)
    assert not is_valid_digest("sha256:" + "G" * 64)


def test_floating_versions_are_detected() -> None:
    assert is_floating("latest")
    assert is_floating("ghcr.io/example/app:latest")
    assert is_floating("^1.2.3")
    assert is_floating("https://github.com/example/project/main/file")
    assert not is_floating("1.2.3")
    assert not is_floating("https://example.invalid/project/v1.2.3/file")


def test_output_is_sorted_and_deterministic() -> None:
    source = catalog(component(id="z"), component(id="a"))
    first = json.dumps(build_lock(source), indent=2, sort_keys=True)
    second = json.dumps(build_lock(source), indent=2, sort_keys=True)
    assert first == second
    assert json.loads(first)["components"][0]["id"] == "a"


def test_local_digest_file_must_stay_in_repository(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.lock"
    outside.write_text("outside", encoding="utf-8")
    with pytest.raises(ComponentLockError, match="escapes repository"):
        resolve_component(component(artifacts=[], digest_files=["../outside.lock"]), tmp_path)


def test_local_digest_file_symlink_cannot_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside-symlink.lock"
    outside.write_text("outside", encoding="utf-8")
    (tmp_path / "escaped.lock").symlink_to(outside)
    with pytest.raises(ComponentLockError, match="escapes repository"):
        resolve_component(component(artifacts=[], digest_files=["escaped.lock"]), tmp_path)


def test_duplicate_component_ids_are_rejected() -> None:
    with pytest.raises(ComponentLockError, match="component IDs must be unique"):
        build_lock(catalog(component(), component()))


def test_duplicate_artifact_ids_are_rejected() -> None:
    with pytest.raises(ComponentLockError, match="duplicate artifact ID"):
        resolve_component(
            component(
                artifacts=[
                    {"id": "same", "digest": "sha256:" + "a" * 64},
                    {"id": "same", "digest": "sha256:" + "b" * 64},
                ]
            )
        )


def test_release_rejects_unresolved_floating_and_invalid_digest() -> None:
    lock = build_lock(
        catalog(
            component(id="unresolved", version="UNRESOLVED_WX_M0_004", artifacts=[]),
            component(id="floating", version="latest"),
            component(
                id="bad-digest",
                artifacts=[{"id": "package", "digest": "sha256:not-a-digest"}],
            ),
        )
    )
    with pytest.raises(ComponentLockError, match="release component lock is incomplete") as error:
        validate_release(lock)
    message = str(error.value)
    assert "bad-digest: invalid-digest" in message
    assert "floating: floating" in message
    assert "unresolved: unresolved" in message


def test_disabled_optional_component_can_remain_unresolved() -> None:
    lock = build_lock(
        catalog(
            component(
                version="UNRESOLVED_OPERATOR_SELECTION",
                artifacts=[],
                enabled=False,
            )
        )
    )
    validate_release(lock)
    assert lock["components"][0]["status"] == "disabled"


def test_resolved_at_override_must_match_catalog() -> None:
    with pytest.raises(ComponentLockError, match="resolved_at differs from catalog"):
        build_lock(catalog(component()), "2026-08-12T06:00:00Z")
