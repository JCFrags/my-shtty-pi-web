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


def short_text_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 740 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{number} 0 obj\n".encode() + value + b"\nendobj\n"
    xref = len(result)
    result += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        result += f"{offset:010d} 00000 n \n".encode()
    trailer = (
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    )
    result += trailer.encode()
    return bytes(result)


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
async def test_valid_short_text_pdf_uses_pdftotext_without_docling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class UnexpectedClient:
        def __init__(self, **_options: Any) -> None:
            raise AssertionError("Docling must not run for a text PDF")

    monkeypatch.setattr(module.httpx, "AsyncClient", UnexpectedClient)
    content = short_text_pdf("Dummy PDF file")
    fetched = module.FetchResult(
        url="https://www.w3.org/dummy.pdf",
        status=200,
        media_type="application/pdf",
        text="",
        content=content,
        headers={},
    )

    result = await module.ReaderPipeline()._read_document(
        fetched, module.ReadRequest(url=fetched.url)
    )

    assert result.content.strip() == "Dummy PDF file"
    assert result.metadata["documentConverter"] == "pdftotext"


@pytest.mark.asyncio
async def test_pdf_without_local_text_escalates_to_docling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(tmp_path / "handoff"))
    monkeypatch.setattr(
        module,
        "extract_pdf_text",
        lambda _content: (_ for _ in ()).throw(RuntimeError("no local text")),
    )
    observed: dict[str, Any] = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "markdown": (
                    "Docling recovered scanned document text that is intentionally long enough "
                    "to satisfy the structured converter quality check."
                ),
            }

    class Client:
        def __init__(self, **_options: Any) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, _url: str, *, json: dict[str, Any]):
            observed["path"] = Path(json["filePath"])
            return Response()

    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    fetched = module.FetchResult(
        url="https://public.example/scanned.pdf",
        status=200,
        media_type="application/pdf",
        text="",
        content=b"scanned PDF bytes",
        headers={},
    )

    result = await module.ReaderPipeline()._read_document(
        fetched, module.ReadRequest(url=fetched.url)
    )

    assert result.metadata["documentConverter"] == "docling"
    assert not observed["path"].exists()


@pytest.mark.asyncio
async def test_pdf_fails_cleanly_when_local_text_and_docling_are_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(tmp_path / "handoff"))
    monkeypatch.setattr(
        module,
        "extract_pdf_text",
        lambda _content: (_ for _ in ()).throw(RuntimeError("no local text")),
    )

    class Client:
        def __init__(self, **_options: Any) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, _url: str, *, json: dict[str, Any]):
            raise module.httpx.ConnectError("Docling unavailable")

    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    fetched = module.FetchResult(
        url="https://public.example/scanned.pdf",
        status=200,
        media_type="application/pdf",
        text="",
        content=b"scanned PDF bytes",
        headers={},
    )

    with pytest.raises(RuntimeError, match="document conversion failed"):
        await module.ReaderPipeline()._read_document(
            fetched, module.ReadRequest(url=fetched.url)
        )


@pytest.mark.asyncio
async def test_docling_handoff_uses_file_metadata_and_removes_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "handoff"
    monkeypatch.setenv("PI_WEB_DOCUMENT_STAGING_DIR", str(root))
    monkeypatch.setattr(
        module,
        "extract_pdf_text",
        lambda _content: (_ for _ in ()).throw(
            AssertionError("raw PDF view must use Docling")
        ),
    )
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
        fetched, module.ReadRequest(url=fetched.url, view="raw")
    )

    payload = observed["payload"]
    assert payload["includeStructured"] is True
    assert result.metadata["documentConverter"] == "docling"
    assert "dataBase64" not in payload
    assert payload["size"] == len(b"document bytes")
    assert len(payload["sha256"]) == 64
    assert observed["clientOptions"]["trust_env"] is False
    assert not observed["path"].exists()
    assert "originalDataBase64" not in result.metadata
    assert result.metadata["originalBytes"] == len(b"document bytes")
