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

HARD_MAX_DOCUMENT_BYTES = 256 * 1024 * 1024
HARD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_DOCUMENT_BYTES = int(os.getenv("PI_WEB_DOCLING_MAX_INPUT_BYTES", str(HARD_MAX_DOCUMENT_BYTES)))
MAX_OUTPUT_BYTES = int(os.getenv("PI_WEB_DOCLING_MAX_OUTPUT_BYTES", str(HARD_MAX_OUTPUT_BYTES)))
if not 1 <= MAX_DOCUMENT_BYTES <= HARD_MAX_DOCUMENT_BYTES or not 1 <= MAX_OUTPUT_BYTES <= HARD_MAX_OUTPUT_BYTES:
    raise RuntimeError("Docling input or output bounds are invalid")
MAX_ASSET_MANIFEST_BYTES = 64 * 1024
MAX_ASSET_FILES = 256
# Add an asset set only after its files pass an Office or scanned-PDF acceptance run.
VALIDATED_MODEL_ASSET_SETS: dict[str, dict[str, Any]] = {}
OFFICE_MEDIA_TYPES = {
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


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


def model_asset_readiness(root: Path | None = None) -> dict[str, Any]:
    """Report only capabilities backed by a reviewed digest manifest."""
    configured_root = os.getenv("DOCLING_ARTIFACTS_PATH")
    asset_root = root if root is not None else Path(configured_root) if configured_root else None
    report: dict[str, Any] = {
        "manifestValidated": False,
        "office": False,
        "scannedPdf": False,
        "detail": "model asset manifest is absent",
    }
    if asset_root is None:
        return report
    manifest = asset_root / "model-assets.json"
    try:
        if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > MAX_ASSET_MANIFEST_BYTES:
            return report
        value = json.loads(manifest.read_text(encoding="utf-8"))
        files = value.get("files")
        capabilities = value.get("capabilities")
        asset_set_id = value.get("assetSetId")
        approved = VALIDATED_MODEL_ASSET_SETS.get(asset_set_id) if isinstance(asset_set_id, str) else None
        if value.get("schemaVersion") != 1 or not isinstance(files, list) or not 1 <= len(files) <= MAX_ASSET_FILES:
            raise ValueError("invalid model asset manifest")
        if not isinstance(capabilities, list) or not all(item in {"office", "scanned-pdf"} for item in capabilities):
            raise ValueError("invalid model asset capabilities")
        if approved is None or approved.get("capabilities") != capabilities or approved.get("files") != files:
            raise ValueError("model asset set has no validated acceptance record in this release")
        resolved_root = asset_root.resolve(strict=True)
        for item in files:
            relative = item.get("path") if isinstance(item, dict) else None
            expected = item.get("sha256") if isinstance(item, dict) else None
            if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise ValueError("invalid model asset path")
            if not isinstance(expected, str) or len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
                raise ValueError("invalid model asset digest")
            path = resolved_root / relative
            if path.is_symlink() or not path.is_file() or not path.resolve(strict=True).is_relative_to(resolved_root):
                raise ValueError("model asset is missing or unsafe")
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise ValueError("model asset digest mismatch")
        report.update({
            "manifestValidated": True,
            "office": "office" in capabilities,
            "scannedPdf": "scanned-pdf" in capabilities,
            "detail": f"validated {len(files)} declared model asset file(s)",
        })
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        report["detail"] = str(error)
    return report


def required_model_capability(media_type: str) -> str | None:
    if media_type == "application/pdf":
        return "scannedPdf"
    if media_type in OFFICE_MEDIA_TYPES:
        return "office"
    return None


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
    capability = required_model_capability(request.media_type)
    readiness = model_asset_readiness()
    if capability and readiness[capability] is not True:
        name = "Office" if capability == "office" else "scanned PDF"
        raise RuntimeError(f"{name} conversion is unavailable: {readiness['detail']}")

    with validated_document(request) as path:
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as error:  # pragma: no cover
            raise RuntimeError("Docling is not installed; select the documents profile") from error

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
            pages.append({"page": page_number, "width": getattr(size, "width", None), "height": getattr(size, "height", None)})
        tables = [{"index": index, "rows": getattr(table.data, "num_rows", None), "columns": getattr(table.data, "num_cols", None)} for index, table in enumerate(getattr(document, "tables", []))]
        images = [{"index": index} for index, _ in enumerate(getattr(document, "pictures", []))]
        title = Path(urlparse(request.url).path).name if request.url else path.name
        response = {
            "title": title,
            "markdown": markdown,
            "structured": structured,
            "pages": pages,
            "tables": tables,
            "images": images,
            "originalSha256": request.sha256,
            "mediaType": request.media_type,
        }
        if len(json.dumps(response, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise RuntimeError(f"document output exceeds {MAX_OUTPUT_BYTES} bytes")
        return response
