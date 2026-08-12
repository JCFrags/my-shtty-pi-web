from pathlib import Path

import pytest
from toolchain_check import ToolchainError, extract_version, load_lock


def test_extract_version_accepts_common_tool_output() -> None:
    assert extract_version("v24.18.0") == "24.18.0"
    assert extract_version("uv 0.12.0 (x86_64-unknown-linux-gnu)") == "0.12.0"
    assert extract_version("vitest/4.1.10 linux-x64 node-v24.18.0") == "4.1.10"


def test_extract_version_rejects_unknown_output() -> None:
    with pytest.raises(ToolchainError, match="could not parse"):
        extract_version("development build")


def test_load_lock_reads_reviewed_scalar_shape(tmp_path: Path) -> None:
    lock_path = tmp_path / "toolchain.lock.yaml"
    lock_path.write_text('schema_version: 1\nruntimes:\n  node: "24.18.0"\n', encoding="utf-8")
    assert load_lock(lock_path) == {
        "schema_version": {"value": "1"},
        "runtimes": {"node": "24.18.0"},
    }


def test_load_lock_rejects_nested_or_list_values(tmp_path: Path) -> None:
    lock_path = tmp_path / "toolchain.lock.yaml"
    lock_path.write_text("runtimes:\n    node: 24.18.0\n", encoding="utf-8")
    with pytest.raises(ToolchainError, match="unsupported lock structure"):
        load_lock(lock_path)
