from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

MAX_DOCUMENT_BYTES = 256 * 1024 * 1024


@dataclass(slots=True)
class ConvertRequest:
    file_path: str
    size: int
    sha256: str
    media_type: str
    url: str | None = None
    include_structured: bool = False


def safe_suffix(media_type: str, url: str | None) -> str:
    if url:
        suffix = Path(urlparse(url).path).suffix
        if suffix and len(suffix) <= 12:
            return suffix
    return mimetypes.guess_extension(media_type) or ".bin"


def document_staging_root() -> Path:
    configured = os.getenv("PI_WEB_DOCUMENT_STAGING_DIR")
    if configured:
        return Path(configured)
    runtime = os.getenv("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(runtime) / "pi-web-documents"


def validate_private_directory(path: Path) -> Path:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        raise ValueError("document staging root must be a real directory")
    if info.st_uid != os.getuid():
        raise ValueError("document staging root has the wrong owner")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("document staging root must not be accessible by other users")
    return path.resolve(strict=True)


@contextmanager
def validated_document(request: ConvertRequest) -> Iterator[Path]:
    if not isinstance(request.size, int) or isinstance(request.size, bool) or not 0 <= request.size <= MAX_DOCUMENT_BYTES:
        raise ValueError(f"document size must be from 0 to {MAX_DOCUMENT_BYTES}")
    if len(request.sha256) != 64 or any(character not in "0123456789abcdef" for character in request.sha256):
        raise ValueError("document sha256 is invalid")

    root = validate_private_directory(document_staging_root())
    supplied = Path(request.file_path)
    if not supplied.is_absolute() or supplied.parent.resolve(strict=True) != root or supplied.name in {"", ".", ".."}:
        raise ValueError("document path is outside the private staging root")

    directory_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_descriptor = os.open(root, directory_flags)
    descriptor = -1
    try:
        directory_info = os.fstat(directory_descriptor)
        if directory_info.st_uid != os.getuid() or stat.S_IMODE(directory_info.st_mode) & 0o077:
            raise ValueError("document staging root changed during validation")
        info = os.stat(supplied.name, dir_fd=directory_descriptor, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("document path must be a regular file and not a symlink")
        if info.st_uid != os.getuid():
            raise ValueError("document file has the wrong owner")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("document file must not be accessible by other users")

        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(supplied.name, flags, dir_fd=directory_descriptor)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("document file changed during validation")
        if opened.st_uid != os.getuid() or opened.st_size != request.size:
            raise ValueError("document ownership or size does not match the handoff")
        with tempfile.TemporaryDirectory(prefix="pi-web-docling-") as directory:
            private_path = Path(directory) / f"document{safe_suffix(request.media_type, request.url)}"
            digest = hashlib.sha256()
            copied = 0
            with os.fdopen(descriptor, "rb", closefd=False) as source, private_path.open("xb") as destination:
                os.chmod(private_path, 0o600)
                while chunk := source.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > request.size or copied > MAX_DOCUMENT_BYTES:
                        raise ValueError("document exceeds its declared size")
                    digest.update(chunk)
                    destination.write(chunk)
            if copied != request.size or digest.hexdigest() != request.sha256:
                raise ValueError("document digest or size does not match the handoff")
            yield private_path
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_descriptor)


def convert_document(request: ConvertRequest) -> dict[str, Any]:
    with validated_document(request) as path:
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
            {
                "index": index,
                "rows": getattr(table.data, "num_rows", None),
                "columns": getattr(table.data, "num_cols", None),
            }
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
            "originalSha256": request.sha256,
            "mediaType": request.media_type,
        }
