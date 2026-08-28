from __future__ import annotations

import importlib.util
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

MODULE_PATH = Path(__file__).parents[2] / "services/reader/src/pi_web_reader/pipeline.py"
spec = importlib.util.spec_from_file_location("reader_document_handoff", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_staged_document_is_private_and_always_cleaned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "handoff"
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(root))
    staged_path: Path | None = None
    with pytest.raises(RuntimeError, match="stop"):
        with module.staged_document(b"private bytes") as handoff:
            staged_path = handoff.path
            assert handoff.path.parent == root
            assert handoff.path.read_bytes() == b"private bytes"
            assert stat.S_IMODE(handoff.path.stat().st_mode) == 0o600
            assert stat.S_IMODE(root.stat().st_mode) == 0o700
            raise RuntimeError("stop")
    assert staged_path is not None and not staged_path.exists()


@pytest.mark.asyncio
async def test_docling_handoff_uses_file_metadata_and_removes_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "handoff"
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(root))
    observed: dict[str, Any] = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "title": "Document",
                "markdown": "# Document\n\nUseful converted content that is long enough for the reader result and contains more than eighty compact characters for validation.",
            }

    class Client:
        def __init__(self, **options: Any) -> None:
            observed["clientOptions"] = options

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, _url: str, *, json: dict[str, Any]):
            observed["payload"] = json
            path = Path(json["filePath"])
            observed["path"] = path
            assert path.read_bytes() == b"document bytes"
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            return Response()

    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    pipeline = module.ReaderPipeline(docling_url="http://127.0.0.1:8792/")
    fetched = module.FetchResult(
        url="https://public.example/document.pdf",
        status=200,
        media_type="application/pdf",
        text="",
        content=b"document bytes",
        headers={},
    )
    result = await pipeline._read_document(
        fetched, module.ReadRequest(url=fetched.url)
    )

    payload = observed["payload"]
    assert "dataBase64" not in payload
    assert payload["size"] == len(b"document bytes")
    assert len(payload["sha256"]) == 64
    assert observed["clientOptions"]["trust_env"] is False
    assert not observed["path"].exists()
    assert "originalDataBase64" not in result.metadata
    assert result.metadata["originalBytes"] == len(b"document bytes")
