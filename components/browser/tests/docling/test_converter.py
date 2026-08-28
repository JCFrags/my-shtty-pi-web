from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[2] / "services/docling/src/pi_web_docling/converter.py"
spec = importlib.util.spec_from_file_location("docling_converter", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def request(path: Path, content: bytes, **overrides):
    values = {
        "file_path": str(path),
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "media_type": "application/pdf",
        "url": "https://example.test/a.pdf",
    }
    values.update(overrides)
    return module.ConvertRequest(**values)


def private_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "handoff"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(root))
    return root


def test_validated_document_copies_verified_bytes_to_private_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = private_root(tmp_path, monkeypatch)
    content = b"document"
    source = root / "source"
    source.write_bytes(content)
    source.chmod(0o600)

    with module.validated_document(request(source, content)) as validated:
        assert validated.read_bytes() == content
        assert validated.parent != root
        assert os.stat(validated).st_mode & 0o077 == 0
    assert not validated.exists()


@pytest.mark.parametrize("changed", ["size", "digest"])
def test_handoff_rejects_size_or_digest_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    root = private_root(tmp_path, monkeypatch)
    content = b"document"
    source = root / "source"
    source.write_bytes(content)
    source.chmod(0o600)
    candidate = request(source, content)
    if changed == "size":
        candidate.size += 1
    else:
        candidate.sha256 = "0" * 64
    with pytest.raises(ValueError, match="size|digest|ownership"):
        with module.validated_document(candidate):
            pass


def test_handoff_rejects_outside_path_and_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = private_root(tmp_path, monkeypatch)
    content = b"document"
    outside = tmp_path / "outside"
    outside.write_bytes(content)
    outside.chmod(0o600)
    with pytest.raises(ValueError, match="outside"):
        with module.validated_document(request(outside, content)):
            pass

    target = root / "target"
    target.write_bytes(content)
    target.chmod(0o600)
    link = root / "link"
    link.symlink_to(target)
    with pytest.raises(ValueError, match="regular file|symlink"):
        with module.validated_document(request(link, content)):
            pass


def test_handoff_rejects_non_private_root_and_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = private_root(tmp_path, monkeypatch)
    content = b"document"
    source = root / "source"
    source.write_bytes(content)
    source.chmod(0o644)
    with pytest.raises(ValueError, match="other users"):
        with module.validated_document(request(source, content)):
            pass

    source.chmod(0o600)
    root.chmod(0o755)
    with pytest.raises(ValueError, match="other users"):
        with module.validated_document(request(source, content)):
            pass
