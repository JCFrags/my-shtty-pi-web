from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import stat
import subprocess
import tempfile
from collections.abc import Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse, urlunparse

try:
    import httpcore
    import httpx
    from httpcore._backends.auto import AutoBackend
except ImportError:  # core unit tests exercise pure functions without optional runtime deps
    httpcore = None  # type: ignore[assignment]
    httpx = None  # type: ignore[assignment]
    AutoBackend = object  # type: ignore[assignment,misc]

try:
    import trafilatura
except ImportError:
    trafilatura = None  # type: ignore[assignment]

ReadView = Literal["main", "outline", "raw"]

DOCUMENT_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
MARKDOWN_TYPES = {"text/markdown", "text/x-markdown"}
TEXT_TYPES = MARKDOWN_TYPES | {"text/plain", "application/json", "application/ld+json"}
MAX_PUBLIC_REDIRECTS = 10
MAX_RANGE_BYTES = 1_048_576
DEFAULT_HTTP_TIMEOUT_SECONDS = 30.0
MAX_HTTP_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_RAW_BYTES = 32 * 1024 * 1024
MAX_MAX_RAW_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_REDIRECTS = 5
DEFAULT_ACQUISITION_CONCURRENCY = 8
MAX_ACQUISITION_CONCURRENCY = 32

Resolver = Callable[[str, int], Awaitable[list[str]]]


@dataclass(slots=True)
class ReadRequest:
    url: str
    query: str | None = None
    view: ReadView = "main"
    max_chars: int = 20_000
    require_markdown: bool = False
    allow_llms_full: bool = False
    fields: tuple[str, ...] = ()
    item_offset: int = 0
    item_limit: int = 50
    content_offset: int = 0


@dataclass(slots=True)
class RangeReadRequest:
    url: str
    offset: int
    length: int
    max_redirects: int = 4


@dataclass(slots=True)
class FetchResult:
    url: str
    status: int
    media_type: str
    text: str
    content: bytes
    headers: dict[str, str]


@dataclass(slots=True, frozen=True)
class DocumentHandoff:
    path: Path
    size: int
    sha256: str


@contextmanager
def staged_document(content: bytes) -> Iterator[DocumentHandoff]:
    configured = os.getenv("PI_WEB_DOCUMENT_STAGING_DIR")
    runtime = os.getenv("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    root = Path(configured) if configured else Path(runtime) / "pi-web-documents"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_info = root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or root.is_symlink():
        raise ValueError("document staging root must be a real directory")
    if root_info.st_uid != os.getuid() or stat.S_IMODE(root_info.st_mode) & 0o077:
        raise ValueError("document staging root must be private and owned by the reader")
    root = root.resolve(strict=True)

    descriptor, raw_path = tempfile.mkstemp(prefix="document-", dir=root)
    path = Path(raw_path)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        yield DocumentHandoff(
            path=path,
            size=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
        )
    finally:
        os.close(descriptor)
        try:
            path.unlink()
        except FileNotFoundError:
            pass


@dataclass(slots=True)
class RangeReadResult:
    requested_url: str
    final_url: str
    status: int
    media_type: str
    content_range: str
    range_start: int
    range_end: int
    total_bytes: int | None
    content: bytes
    redirect_chain: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "requestedUrl": self.requested_url,
            "finalUrl": self.final_url,
            "statusCode": self.status,
            "mediaType": self.media_type,
            "contentRange": self.content_range,
            "rangeStart": self.range_start,
            "rangeEnd": self.range_end,
            "totalBytes": self.total_bytes,
            "bodyBase64": base64.b64encode(self.content).decode("ascii"),
            "bodyBytes": len(self.content),
            "sha256": hashlib.sha256(self.content).hexdigest(),
            "redirectChain": list(self.redirect_chain),
        }


@dataclass(slots=True)
class ReadResult:
    url: str
    title: str
    media_type: str
    content: str
    source: str
    truncated: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        # The coordinator protocol is camelCase even though Python internals use
        # snake_case. Keep this explicit so FastAPI does not leak implementation keys.
        return {
            "url": self.url,
            "title": self.title,
            "mediaType": self.media_type,
            "content": self.content,
            "source": self.source,
            "truncated": self.truncated,
            "metadata": self.metadata,
        }


class ReaderPipeline:
    """Read public HTTP content without access to local or special networks.

    Browser-local navigation is a separate coordinator capability. This public reader
    resolves each request target, pins a checked public address, and checks each redirect.
    """

    def __init__(
        self,
        *,
        timeout_seconds: float | None = None,
        max_download_bytes: int | None = None,
        max_raw_bytes: int | None = None,
        max_redirects: int | None = None,
        acquisition_concurrency: int | None = None,
        docling_url: str | None = None,
        user_agent: str = "Pi-Web-Reader/0.1 (+local self-hosted reader)",
        resolver: Resolver | None = None,
        transport_factory: Callable[[dict[str, str]], Any] | None = None,
        test_loopback_fixture: tuple[str, int] | None = None,
    ) -> None:
        self.timeout_seconds = bounded_number(
            timeout_seconds,
            os.getenv("PI_WEB_HTTP_TIMEOUT_SECONDS"),
            default=DEFAULT_HTTP_TIMEOUT_SECONDS,
            maximum=MAX_HTTP_TIMEOUT_SECONDS,
            name="HTTP timeout",
        )
        self.max_download_bytes = bounded_integer(
            max_download_bytes,
            os.getenv("PI_WEB_MAX_DOWNLOAD_BYTES"),
            default=DEFAULT_MAX_DECOMPRESSED_BYTES,
            maximum=MAX_MAX_DECOMPRESSED_BYTES,
            name="decompressed byte limit",
        )
        self.max_raw_bytes = bounded_integer(
            max_raw_bytes,
            os.getenv("PI_WEB_MAX_RAW_DOWNLOAD_BYTES"),
            default=DEFAULT_MAX_RAW_BYTES,
            maximum=MAX_MAX_RAW_BYTES,
            name="raw byte limit",
        )
        self.max_redirects = bounded_integer(
            max_redirects,
            os.getenv("PI_WEB_MAX_REDIRECTS"),
            default=DEFAULT_MAX_REDIRECTS,
            maximum=MAX_PUBLIC_REDIRECTS,
            name="redirect limit",
            minimum=0,
        )
        concurrency = bounded_integer(
            acquisition_concurrency,
            os.getenv("PI_WEB_ACQUISITION_CONCURRENCY"),
            default=DEFAULT_ACQUISITION_CONCURRENCY,
            maximum=MAX_ACQUISITION_CONCURRENCY,
            name="acquisition concurrency",
        )
        self._acquisition_slots = asyncio.Semaphore(concurrency)
        self.docling_url = docling_url or os.getenv("PI_WEB_DOCLING_URL", "http://127.0.0.1:8792/")
        self.user_agent = user_agent
        self.resolver = resolver or resolve_public_addresses
        self.transport_factory = transport_factory or pinned_transport
        self.test_loopback_fixture = test_loopback_fixture

    def _validated_pin(self, host: str, port: int, addresses: list[str]) -> str:
        if self.test_loopback_fixture == (host, port) and addresses == ["127.0.0.1"]:
            return "127.0.0.1"
        return validate_public_addresses(host, addresses)

    async def read_range(self, request: RangeReadRequest) -> RangeReadResult:
        async with self._acquisition_slots:
            async with asyncio.timeout(self.timeout_seconds):
                return await self._read_range(request)

    async def _read_range(self, request: RangeReadRequest) -> RangeReadResult:
        validate_range_request(request)
        if httpx is None:
            raise RuntimeError(
                "reader runtime dependencies are not installed; run `uv sync --all-packages`"
            )
        start = request.offset
        requested_end = start + request.length - 1
        headers = {
            "Accept": "application/octet-stream",
            "Accept-Encoding": "identity",
            "Range": f"bytes={start}-{requested_end}",
            "User-Agent": self.user_agent,
        }
        timeout = httpx_timeout(self.timeout_seconds)
        current = request.url
        redirect_chain = [current]
        for redirect_count in range(request.max_redirects + 1):
            parsed = validate_public_url_syntax(current)
            host = parsed.hostname
            assert host is not None
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            addresses = await self.resolver(host, port)
            pinned = self._validated_pin(host, port, addresses)
            transport = self.transport_factory({host.lower().rstrip("."): pinned})
            async with (
                httpx.AsyncClient(
                    follow_redirects=False,
                    timeout=timeout,
                    headers=headers,
                    transport=transport,
                    trust_env=False,
                ) as client,
                client.stream("GET", current) as response,
            ):
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("redirect response has no location")
                    if redirect_count >= request.max_redirects:
                        raise ValueError("too many redirects")
                    current = urljoin(current, location)
                    validate_public_url_syntax(current)
                    redirect_chain.append(current)
                    continue
                if response.status_code != 206:
                    raise ValueError("range origin must return HTTP 206")
                encoding = response.headers.get("content-encoding", "identity").strip().lower()
                if encoding not in {"", "identity"}:
                    raise ValueError("range origin returned a content encoding")
                content_range = response.headers.get("content-range")
                actual_start, actual_end, total = parse_content_range(content_range)
                if actual_start != start or actual_end > requested_end:
                    raise ValueError("range origin returned an inconsistent Content-Range")
                expected_bytes = actual_end - actual_start + 1
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_raw():
                    size += len(chunk)
                    if size > request.length or size > MAX_RANGE_BYTES:
                        raise ValueError("range response exceeds its byte limit")
                    chunks.append(chunk)
                content = b"".join(chunks)
                if len(content) != expected_bytes:
                    raise ValueError("range body length conflicts with Content-Range")
                return RangeReadResult(
                    requested_url=request.url,
                    final_url=str(response.url),
                    status=response.status_code,
                    media_type=content_type(response.headers.get("content-type")),
                    content_range=content_range or "",
                    range_start=actual_start,
                    range_end=actual_end,
                    total_bytes=total,
                    content=content,
                    redirect_chain=tuple(redirect_chain),
                )
        raise ValueError("too many redirects")

    async def read(self, request: ReadRequest) -> ReadResult:
        async with self._acquisition_slots:
            async with asyncio.timeout(self.timeout_seconds):
                return await self._read(request)

    async def _read(self, request: ReadRequest) -> ReadResult:
        validate_public_url_syntax(request.url)
        original = await self._fetch(
            request.url,
            accept="text/markdown, text/plain;q=0.95, application/json;q=0.9, text/html;q=0.8, */*;q=0.2",
        )

        if original.media_type == "application/json" or original.media_type.endswith("+json"):
            return finalize_json_result(original, request)

        if original.media_type in DOCUMENT_TYPES or looks_like_document_url(original.url):
            return await self._read_document(original, request)

        # 1–2. Content negotiation / original Markdown or plain-text response.
        if original.media_type in TEXT_TYPES:
            source = "markdown-negotiation" if original.media_type in MARKDOWN_TYPES else "raw"
            return finalize_text_result(original, original.text, request, source)

        # 3. Explicit .md and index.md fallback.
        for candidate in markdown_candidates(original.url):
            fetched = await self._try_fetch(candidate, accept="text/markdown, text/plain;q=0.9")
            if fetched and fetched.media_type in TEXT_TYPES and useful_text(fetched.text):
                return finalize_text_result(fetched, fetched.text, request, "markdown-fallback")

        # 4. Preserve the requested page when static extraction yields useful content.
        extracted, title, extraction_meta = extract_html(original.text, request)
        if useful_text(extracted) and not looks_like_javascript_shell(original.text, extracted):
            focused = select_query_context(extracted, request.query) if request.query else extracted
            result = finalize_text_result(original, focused, request, "trafilatura", title=title)
            result.metadata.update(extraction_meta)
            return result

        # 5–6. Use llms.txt only when the requested page is a shell or extraction failed.
        # The result metadata makes this substitution explicit.
        llms_names = ["llms-full.txt", "llms.txt"] if request.allow_llms_full else ["llms.txt"]
        for candidate in llms_candidates(original.url, llms_names):
            fetched = await self._try_fetch(candidate, accept="text/plain, text/markdown;q=0.9")
            if fetched and fetched.media_type in TEXT_TYPES and useful_text(fetched.text):
                selected = (
                    select_query_context(fetched.text, request.query)
                    if request.query
                    else fetched.text
                )
                return finalize_text_result(fetched, selected, request, "llms-txt")

        # 7–8 are deliberately surfaced to the coordinator, which owns browser identity,
        # profiles, artifacts, and engine routing. Returning a bounded shell preserves the
        # HTTP evidence while avoiding a hidden engine switch or an unowned browser session.
        shell = extracted or html_to_text(original.text)
        result = finalize_text_result(original, shell, request, "raw", title=title)
        result.metadata.update(
            {
                **extraction_meta,
                "renderRequired": True,
                "renderPathSelection": "coordinator-owned",
                "staticContentSha256": hashlib.sha256(original.content).hexdigest(),
            }
        )
        return result

    async def _read_document(self, fetched: FetchResult, request: ReadRequest) -> ReadResult:
        converted: dict[str, Any] = {}
        converter = "docling"
        if fetched.media_type == "application/pdf" and request.view != "raw":
            try:
                markdown = await asyncio.to_thread(extract_pdf_text, fetched.content)
                converter = "pdftotext"
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass
        if converter == "docling":
            if httpx is None:
                raise RuntimeError("httpx is required to invoke the Docling worker")
            try:
                with staged_document(fetched.content) as handoff:
                    payload = {
                        "url": fetched.url,
                        "mediaType": fetched.media_type,
                        "filePath": str(handoff.path),
                        "size": handoff.size,
                        "sha256": handoff.sha256,
                        "includeStructured": request.view == "raw",
                    }
                    async with httpx.AsyncClient(
                        timeout=httpx_timeout(self.timeout_seconds), trust_env=False
                    ) as client:
                        response = await client.post(
                            urljoin(self.docling_url, "v1/convert"), json=payload
                        )
                        response.raise_for_status()
                        converted = response.json()
                markdown = str(converted.get("markdown") or "")
                if not useful_text(markdown):
                    raise ValueError("document converter returned no useful text")
            except (httpx.HTTPError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                raise RuntimeError("document conversion failed") from None
        title = str(converted.get("title") or infer_title(markdown, fetched.url))
        focused = select_query_context(markdown, request.query) if request.query else markdown
        result = finalize_text_result(fetched, focused, request, "document", title=title)
        result.media_type = "text/markdown"
        result.metadata.update(
            {
                "document": True,
                "documentConverter": converter,
                "documentMediaType": fetched.media_type,
                "originalSha256": hashlib.sha256(fetched.content).hexdigest(),
                "originalBytes": len(fetched.content),
                "pages": converted.get("pages", []),
                "tables": converted.get("tables", []),
                "images": converted.get("images", []),
                "structured": converted.get("structured") if request.view == "raw" else None,
            }
        )
        return result

    async def _try_fetch(self, url: str, *, accept: str) -> FetchResult | None:
        try:
            response = await self._fetch(url, accept=accept)
        except (ValueError, OSError, httpx.HTTPError):
            return None
        return response if 200 <= response.status < 300 else None

    async def _fetch(self, url: str, *, accept: str) -> FetchResult:
        if httpx is None:
            raise RuntimeError(
                "reader runtime dependencies are not installed; run `uv sync --all-packages`"
            )
        headers = {"Accept": accept, "User-Agent": self.user_agent}
        timeout = httpx_timeout(self.timeout_seconds)
        current = url
        for redirect_count in range(self.max_redirects + 1):
            parsed = validate_public_url_syntax(current)
            host = parsed.hostname
            assert host is not None
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            addresses = await self.resolver(host, port)
            pinned = self._validated_pin(host, port, addresses)
            transport = self.transport_factory({host.lower().rstrip("."): pinned})
            async with (
                httpx.AsyncClient(
                    follow_redirects=False,
                    timeout=timeout,
                    headers=headers,
                    transport=transport,
                    trust_env=False,
                ) as client,
                client.stream("GET", current) as response,
            ):
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("redirect response has no location")
                    if redirect_count >= self.max_redirects:
                        raise ValueError("too many redirects")
                    current = urljoin(current, location)
                    validate_public_url_syntax(current)
                    continue
                response.raise_for_status()
                content = await read_bounded_response(
                    response,
                    max_raw_bytes=self.max_raw_bytes,
                    max_decompressed_bytes=self.max_download_bytes,
                )
                media_type = content_type(response.headers.get("content-type"))
                encoding = response.encoding or "utf-8"
                text = content.decode(encoding, errors="replace")
                return FetchResult(
                    url=str(response.url),
                    status=response.status_code,
                    media_type=media_type,
                    text=text,
                    content=content,
                    headers={key.lower(): value for key, value in response.headers.items()},
                )
        raise ValueError("too many redirects")


def extract_pdf_text(content: bytes) -> str:
    """Extract PDF text with the bounded local Poppler utility."""
    with tempfile.TemporaryDirectory(prefix="pi-web-pdf-") as directory:
        source = os.path.join(directory, "input.pdf")
        output = os.path.join(directory, "output.txt")
        with open(source, "wb") as handle:
            handle.write(content)
        completed = subprocess.run(
            ["pdftotext", "-layout", source, output],
            check=False,
            capture_output=True,
            timeout=60,
        )
        if completed.returncode != 0:
            raise RuntimeError("PDF extraction failed")
        with open(output, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    if not any(character.isalnum() for character in text):
        raise RuntimeError("PDF extraction returned no text")
    return text


def validate_range_request(request: RangeReadRequest) -> None:
    validate_public_url_syntax(request.url)
    if (
        isinstance(request.offset, bool)
        or not isinstance(request.offset, int)
        or request.offset < 0
    ):
        raise ValueError("range offset must be a non-negative integer")
    if (
        isinstance(request.length, bool)
        or not isinstance(request.length, int)
        or not 1 <= request.length <= MAX_RANGE_BYTES
    ):
        raise ValueError(f"range length must be from 1 to {MAX_RANGE_BYTES}")
    if request.offset > (2**63 - 1) - request.length:
        raise ValueError("range end exceeds the supported integer bound")
    if (
        isinstance(request.max_redirects, bool)
        or not isinstance(request.max_redirects, int)
        or not 0 <= request.max_redirects <= MAX_PUBLIC_REDIRECTS
    ):
        raise ValueError(f"max redirects must be from 0 to {MAX_PUBLIC_REDIRECTS}")


def parse_content_range(value: str | None) -> tuple[int, int, int | None]:
    match = re.fullmatch(r"bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)/(\*|0|[1-9][0-9]*)", value or "")
    if match is None:
        raise ValueError("range origin returned an invalid Content-Range")
    start = int(match.group(1))
    end = int(match.group(2))
    if end < start:
        raise ValueError("range origin returned an invalid Content-Range")
    total_text = match.group(3)
    total = None if total_text == "*" else int(total_text)
    if total is not None and (total <= end or total == 0):
        raise ValueError("range origin returned an invalid Content-Range total")
    return start, end, total


def bounded_number(
    explicit: float | None,
    configured: str | None,
    *,
    default: float,
    maximum: float,
    name: str,
) -> float:
    try:
        value = explicit if explicit is not None else (
            float(configured) if configured is not None and configured.strip() else default
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if isinstance(value, bool) or not 0 < value <= maximum:
        raise ValueError(f"{name} must be greater than 0 and at most {maximum}")
    return float(value)


def bounded_integer(
    explicit: int | None,
    configured: str | None,
    *,
    default: int,
    maximum: int,
    name: str,
    minimum: int = 1,
) -> int:
    try:
        value = explicit if explicit is not None else (
            int(configured) if configured is not None and configured.strip() else default
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be an integer") from error
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be from {minimum} to {maximum}")
    return value


def httpx_timeout(seconds: float):
    return httpx.Timeout(seconds, connect=min(seconds, 10.0))


async def read_bounded_response(
    response: Any,
    *,
    max_raw_bytes: int,
    max_decompressed_bytes: int,
) -> bytes:
    content_length = response.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as error:
            raise ValueError("response has an invalid Content-Length") from error
        if declared_length < 0 or declared_length > max_raw_bytes:
            raise ValueError(f"raw response exceeds {max_raw_bytes} bytes")

    # In-memory transports can supply an already-consumed response. Its content has no
    # separate wire stream, so apply both limits to the available bytes.
    if response.is_stream_consumed:
        content = response.content
        if len(content) > max_raw_bytes:
            raise ValueError(f"raw response exceeds {max_raw_bytes} bytes")
        if len(content) > max_decompressed_bytes:
            raise ValueError(f"decompressed response exceeds {max_decompressed_bytes} bytes")
        return content

    # HTTPX owns content decoding. Read its raw stream directly so both the wire-size
    # and decompressed-size ceilings apply, including to chunked compressed responses.
    decoder = response._get_content_decoder()  # type: ignore[attr-defined]
    chunks: list[bytes] = []
    raw_size = 0
    decompressed_size = 0
    async for raw_chunk in response.aiter_raw():
        raw_size += len(raw_chunk)
        if raw_size > max_raw_bytes:
            raise ValueError(f"raw response exceeds {max_raw_bytes} bytes")
        chunk = decoder.decode(raw_chunk)
        decompressed_size += len(chunk)
        if decompressed_size > max_decompressed_bytes:
            raise ValueError(f"decompressed response exceeds {max_decompressed_bytes} bytes")
        chunks.append(chunk)
    final_chunk = decoder.flush()
    decompressed_size += len(final_chunk)
    if decompressed_size > max_decompressed_bytes:
        raise ValueError(f"decompressed response exceeds {max_decompressed_bytes} bytes")
    chunks.append(final_chunk)
    return b"".join(chunks)


def content_type(value: str | None) -> str:
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()


def validate_http_url(value: str) -> None:
    validate_public_url_syntax(value)


def validate_public_url_syntax(value: str):
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.hostname is None:
        raise ValueError("url must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL credentials are not allowed")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("URL port is invalid") from error
    if port == 0:
        raise ValueError("URL port is invalid")
    host = parsed.hostname.rstrip(".")
    if not host or "%" in host:
        raise ValueError("URL host is invalid")
    try:
        address = parse_ip_literal(host)
    except ValueError:
        if len(host) > 253 or any(not label or len(label) > 63 for label in host.split(".")):
            raise ValueError("URL host is invalid")
    else:
        if not is_public_address(address):
            raise ValueError("public reader rejects private or special addresses")
    return parsed


async def resolve_public_addresses(host: str, port: int) -> list[str]:
    try:
        literal = parse_ip_literal(host.rstrip("."))
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            results = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as error:
            raise ValueError("public reader could not resolve the host") from error
        return list(dict.fromkeys(result[4][0] for result in results))
    return [str(literal)]


def parse_ip_literal(value: str):
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        if re.fullmatch(r"[0-9.]+", value):
            try:
                return ipaddress.ip_address(socket.inet_ntoa(socket.inet_aton(value)))
            except OSError:
                pass
        raise


def is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        address.is_global
        and not address.is_multicast
        and not address.is_unspecified
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_private
        and not address.is_reserved
    )


def validate_public_addresses(host: str, addresses: Iterable[str]) -> str:
    checked: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for value in addresses:
        try:
            address = ipaddress.ip_address(value)
        except ValueError as error:
            raise ValueError("DNS returned an invalid address") from error
        if not is_public_address(address):
            raise ValueError(f"public reader rejects a private or special address for {host}")
        checked.append(address)
    if not checked:
        raise ValueError("public reader DNS result was empty")
    checked.sort(key=lambda address: (address.version, address.packed))
    return str(checked[0])


class PinnedNetworkBackend(AutoBackend):
    def __init__(self, pins: dict[str, str]) -> None:
        self.pins = {host.lower().rstrip("."): address for host, address in pins.items()}

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ):
        pinned = self.pins.get(host.lower().rstrip("."))
        if pinned is None:
            raise RuntimeError("connection target was not resolved and pinned")
        return await super().connect_tcp(
            pinned,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )


def pinned_transport(pins: dict[str, str]):
    if httpx is None or httpcore is None:
        raise RuntimeError("httpx and httpcore are required for public fetch")
    transport = httpx.AsyncHTTPTransport(retries=0, trust_env=False)
    # HTTPX does not expose the network backend in its public constructor. The
    # pinned backend is installed into its owned pool before the first request.
    transport._pool._network_backend = PinnedNetworkBackend(pins)  # type: ignore[attr-defined]
    return transport


def markdown_candidates(url: str) -> list[str]:
    parsed = urlparse(url)
    path = parsed.path or "/"
    candidates: list[str] = []
    if path.endswith("/"):
        candidates.append(
            urlunparse(parsed._replace(path=path + "index.md", query="", fragment=""))
        )
    else:
        candidates.append(urlunparse(parsed._replace(path=path + ".md", query="", fragment="")))
        parent = path.rsplit("/", 1)[0] + "/"
        candidates.append(
            urlunparse(parsed._replace(path=parent + "index.md", query="", fragment=""))
        )
    return dedupe(candidates)


def llms_candidates(url: str, names: Iterable[str] = ("llms.txt",)) -> list[str]:
    parsed = urlparse(url)
    segments = [segment for segment in (parsed.path or "/").split("/") if segment]
    if parsed.path and not parsed.path.endswith("/") and segments:
        segments.pop()
    candidates: list[str] = []
    for depth in range(len(segments), -1, -1):
        base = "/" + "/".join(segments[:depth])
        if not base.endswith("/"):
            base += "/"
        for name in names:
            candidates.append(urlunparse(parsed._replace(path=base + name, query="", fragment="")))
    return dedupe(candidates)


def dedupe(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def extract_html(document: str, request: ReadRequest) -> tuple[str, str, dict[str, Any]]:
    title = extract_title(document)
    if request.view == "raw":
        return document, title, {"extractor": "raw-html"}
    if request.view == "outline":
        outline = outline_from_html(document)
        if outline:
            return outline, title, {"extractor": "html-headings"}
    if trafilatura is not None:
        # Keep Markdown headings for both main and outline views. Outline rendering
        # removes body text after extraction.
        output_format = "markdown"
        extracted = trafilatura.extract(
            document,
            output_format=output_format,
            include_links=True,
            include_images=False,
            include_tables=True,
            include_comments=False,
            favor_precision=True,
            deduplicate=True,
        )
        if extracted:
            if request.view == "outline":
                extracted = outline_from_markdown(extracted)
            elif request.query:
                extracted = select_query_context(extracted, request.query)
            return extracted, title, {"extractor": "trafilatura"}
    fallback = html_to_text(document)
    if request.view == "outline":
        fallback = outline_from_html(document)
    elif request.query:
        fallback = select_query_context(fallback, request.query)
    return fallback, title, {"extractor": "stdlib-fallback"}


def finalize_json_result(fetched: FetchResult, request: ReadRequest) -> ReadResult:
    try:
        value = json.loads(fetched.text)
    except json.JSONDecodeError:
        return finalize_text_result(fetched, fetched.text, request, "raw-json")
    container = value
    collection_key: str | None = None
    collection: list[Any] | None = value if isinstance(value, list) else None
    if isinstance(value, dict):
        for key, candidate in value.items():
            if isinstance(candidate, list):
                collection_key, collection = str(key), candidate
                break
    total_items = len(collection) if collection is not None else None
    selected = collection
    matched_items = total_items
    if collection is not None:
        if request.query:
            tokens = [
                token
                for token in re.findall(r"[\w.+-]+", request.query.casefold())
                if len(token) > 1
            ]
            selected = [
                item
                for item in collection
                if all(token in json.dumps(item, ensure_ascii=False).casefold() for token in tokens)
            ]
        matched_items = len(selected)
        selected = selected[request.item_offset : request.item_offset + request.item_limit]
        if collection_key is None:
            container = selected
        else:
            container = {**value, collection_key: selected}
    if request.fields:
        if selected is not None:
            projected_rows = []
            for item in selected:
                row: dict[str, Any] = {}
                for path in request.fields:
                    segments = path.split(".")
                    if collection_key is not None and segments[0] == collection_key:
                        segments = segments[1:]
                    key = ".".join(segments) or path
                    row[key] = json_path_value(item, segments)
                projected_rows.append(row)
            container = projected_rows if collection_key is None else {collection_key: projected_rows}
        else:
            container = {
                path: json_path_value(container, path.split(".")) for path in request.fields
            }
    rendered = json.dumps(container, ensure_ascii=False, indent=2)
    result = finalize_text_result(fetched, rendered, request, "structured-json")
    returned_items = len(selected) if selected is not None else None
    result.metadata.update(
        {
            "structured": True,
            "selectedFields": list(request.fields),
            "itemOffset": request.item_offset,
            "itemLimit": request.item_limit,
            "totalItems": total_items,
            "matchedItems": matched_items,
            "returnedItems": returned_items,
            "nextItemOffset": (
                request.item_offset + returned_items
                if matched_items is not None
                and returned_items is not None
                and request.item_offset + returned_items < matched_items
                else None
            ),
            "itemsComplete": (
                matched_items is not None
                and returned_items is not None
                and request.item_offset + returned_items >= matched_items
            ),
        }
    )
    return result


def json_path_value(value: Any, segments: list[str]) -> Any:
    if not segments:
        return value
    if isinstance(value, list):
        return [json_path_value(item, segments) for item in value]
    if not isinstance(value, dict):
        return None
    head, *tail = segments
    return json_path_value(value.get(head), tail)


def finalize_text_result(
    fetched: FetchResult,
    text: str,
    request: ReadRequest,
    source: str,
    *,
    title: str | None = None,
) -> ReadResult:
    normalized = normalize_text(text)
    if request.query and source not in {"llms-txt", "trafilatura"}:
        normalized = select_query_context(normalized, request.query)
    if request.view == "outline":
        normalized = outline_from_markdown(normalized)
    limit = max(256, min(request.max_chars, 1_000_000))
    offset = max(0, request.content_offset)
    if offset > len(normalized):
        raise ValueError(
            f"contentOffset {offset} exceeds extracted content length {len(normalized)}"
        )
    remaining = normalized[offset:]
    bounded, truncated = truncate_chars(remaining, limit)
    consumed = min(len(remaining), max(0, limit - 32) if truncated else len(remaining))
    return ReadResult(
        url=fetched.url,
        title=title or infer_title(normalized, fetched.url),
        media_type="text/markdown"
        if request.require_markdown or source != "raw"
        else fetched.media_type,
        content=bounded,
        source=source,
        truncated=truncated,
        metadata={
            "originalMediaType": fetched.media_type,
            "responseBytes": len(fetched.content),
            "contentSha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
            "resolvedVia": source,
            "requestedUrl": request.url,
            "finalUrl": fetched.url,
            "substituted": fetched.url != request.url,
            "contentOffset": offset,
            "returnedCharacters": len(bounded),
            "sourceCharactersReturned": consumed,
            "totalCharacters": len(normalized),
            "complete": not truncated and offset + consumed >= len(normalized),
            "hardLimitApplied": truncated,
            "nextContentOffset": offset + consumed if truncated else None,
        },
    )


def useful_text(value: str) -> bool:
    compact = re.sub(r"\s+", " ", value).strip()
    return len(compact) >= 80


def looks_like_javascript_shell(source: str, extracted: str) -> bool:
    source_lower = source.lower()
    script_count = source_lower.count("<script")
    visible_len = len(re.sub(r"\s+", " ", extracted).strip())
    shell_markers = ('id="root"', 'id="app"', "__next_data__", "data-reactroot", "ng-version")
    return visible_len < 240 and (
        script_count >= 3 or any(marker in source_lower for marker in shell_markers)
    )


def looks_like_document_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return path.endswith(
        (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp")
    )


def extract_title(document: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", document, flags=re.IGNORECASE | re.DOTALL)
    return normalize_text(html.unescape(strip_tags(match.group(1)))) if match else ""


def infer_title(text: str, url: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        if stripped:
            return stripped[:160]
    return title_from_url(url)


def title_from_url(url: str) -> str:
    parsed = urlparse(url)
    tail = (
        (parsed.path.rstrip("/").rsplit("/", 1)[-1] or parsed.netloc)
        .replace("-", " ")
        .replace("_", " ")
    )
    return tail or parsed.netloc


def html_to_text(document: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|template|svg|noscript)\b.*?</\1>", " ", document)
    cleaned = re.sub(r"(?i)</(p|div|section|article|main|li|tr|h[1-6])>", "\n", cleaned)
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    return normalize_text(html.unescape(strip_tags(cleaned)))


def strip_tags(value: str) -> str:
    return re.sub(r"(?s)<[^>]+>", " ", value)


def normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")]
    output: list[str] = []
    blank = False
    for line in lines:
        if not line:
            if output and not blank:
                output.append("")
            blank = True
        else:
            output.append(line)
            blank = False
    return "\n".join(output).strip()


def outline_from_html(document: str) -> str:
    headings = re.findall(r"(?is)<h([1-6])\b[^>]*>(.*?)</h\1>", document)
    return "\n".join(
        f"{'#' * int(level)} {normalize_text(html.unescape(strip_tags(body)))}"
        for level, body in headings
    )


def outline_from_markdown(markdown: str) -> str:
    return "\n".join(
        line.strip()
        for line in markdown.splitlines()
        if re.match(r"^#{1,6}\s+\S", line.strip())
    )


def select_query_context(text: str, query: str | None, *, radius: int = 1) -> str:
    if not query:
        return text
    noise = {"and", "for", "from", "into", "only", "that", "the", "this", "with"}
    terms = list(dict.fromkeys(
        term.casefold()
        for term in re.findall(r"[\w-]{3,}", query)
        if term.casefold() not in noise
    ))
    if not terms:
        return text

    # Prefer complete Markdown sections. This keeps a matching table or list with
    # its heading and omits unrelated sections instead of returning nearby chunks.
    heading_matches = list(re.finditer(r"(?m)^#{1,6}\s+\S.*$", text))
    if heading_matches:
        sections: list[tuple[int, int, str]] = []
        preamble = text[: heading_matches[0].start()].strip()
        if preamble:
            lowered = preamble.casefold()
            score = sum(1 for term in terms if query_term_matches(term, lowered))
            if score:
                sections.append((score, -1, preamble))
        for index, match in enumerate(heading_matches):
            end = heading_matches[index + 1].start() if index + 1 < len(heading_matches) else len(text)
            section = text[match.start():end].strip()
            lowered = section.casefold()
            heading = match.group(0).casefold()
            score = sum(
                (4 if term in heading else 1)
                for term in terms
                if query_term_matches(term, lowered)
            )
            if score:
                sections.append((score, index, section))
        if sections:
            covered: set[str] = set()
            best: list[tuple[int, int, str]] = []
            for item in sorted(sections, key=lambda candidate: (-candidate[0], candidate[1])):
                lowered = item[2].casefold()
                matched = {term for term in terms if query_term_matches(term, lowered)}
                if not matched - covered:
                    continue
                best.append(item)
                covered.update(matched)
                if len(best) >= 12 or len(covered) == len(terms):
                    break
            return "\n\n".join(section for _, _, section in sorted(best, key=lambda item: item[1]))

    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    scored = [
        (sum(1 for term in terms if query_term_matches(term, paragraph.casefold())), index)
        for index, paragraph in enumerate(paragraphs)
    ]
    matches = [(score, index) for score, index in scored if score > 0]
    if not matches:
        return text
    selected: set[int] = set()
    for _, index in sorted(matches, reverse=True)[:8]:
        selected.update(range(max(0, index - radius), min(len(paragraphs), index + radius + 1)))
    return "\n\n".join(paragraphs[index] for index in sorted(selected))


def query_term_matches(term: str, lowered_text: str) -> bool:
    if term in lowered_text:
        return True
    return term == "context" and "sequence length" in lowered_text


def truncate_chars(value: str, limit: int) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    return value[: max(0, limit - 32)].rstrip() + "\n\n[content truncated]", True


async def bounded_gather(*coroutines: Any) -> list[Any]:
    return list(await asyncio.gather(*coroutines))
