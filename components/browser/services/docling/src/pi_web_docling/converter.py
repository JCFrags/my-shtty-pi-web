from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(slots=True)
class ConvertRequest:
    data_base64: str
    media_type: str
    url: str | None = None
    include_structured: bool = False


def safe_suffix(media_type: str, url: str | None) -> str:
    if url:
        suffix = Path(urlparse(url).path).suffix
        if suffix and len(suffix) <= 12:
            return suffix
    return mimetypes.guess_extension(media_type) or ".bin"


def decode_payload(value: str, *, max_bytes: int = 256 * 1024 * 1024) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as error:
        raise ValueError("dataBase64 is not valid base64") from error
    if len(decoded) > max_bytes:
        raise ValueError(f"document exceeds {max_bytes} bytes")
    return decoded


def convert_document(request: ConvertRequest) -> dict[str, Any]:
    data = decode_payload(request.data_base64)
    suffix = safe_suffix(request.media_type, request.url)
    with tempfile.TemporaryDirectory(prefix="pi-web-docling-") as directory:
        path = Path(directory) / f"document{suffix}"
        path.write_bytes(data)
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as error:  # pragma: no cover
            raise RuntimeError("Docling is not installed; run `uv sync --all-packages`") from error

        result = DocumentConverter().convert(path)
        document = result.document
        markdown = document.export_to_markdown()
        structured: Any | None = None
        if request.include_structured:
            try:
                structured = document.export_to_dict()
            except AttributeError:
                structured = json.loads(document.model_dump_json())

        pages: list[dict[str, Any]] = []
        for page_number, page in sorted(getattr(document, "pages", {}).items()):
            size = getattr(page, "size", None)
            pages.append(
                {
                    "page": page_number,
                    "width": getattr(size, "width", None),
                    "height": getattr(size, "height", None),
                }
            )
        tables = [
            {"index": index, "rows": getattr(table.data, "num_rows", None), "columns": getattr(table.data, "num_cols", None)}
            for index, table in enumerate(getattr(document, "tables", []))
        ]
        images = [{"index": index} for index, _ in enumerate(getattr(document, "pictures", []))]
        title = Path(urlparse(request.url).path).name if request.url else path.name
        return {
            "title": title,
            "markdown": markdown,
            "structured": structured,
            "pages": pages,
            "tables": tables,
            "images": images,
            "originalSha256": hashlib.sha256(data).hexdigest(),
            "mediaType": request.media_type,
        }
