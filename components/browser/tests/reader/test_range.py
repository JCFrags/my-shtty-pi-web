from __future__ import annotations

import asyncio

import httpx
import pytest
from pi_web_reader.pipeline import (
    MAX_RANGE_BYTES,
    RangeReadRequest,
    ReaderPipeline,
    parse_content_range,
    validate_range_request,
)


class BytesStream(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self):
        yield self.content


async def public_resolver(_host: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


def response(
    status: int,
    request: httpx.Request,
    *,
    headers: dict[str, str] | None = None,
    content: bytes = b"",
) -> httpx.Response:
    return httpx.Response(status, headers=headers, stream=BytesStream(content), request=request)


def pipeline(handler, *, resolver=public_resolver) -> ReaderPipeline:
    return ReaderPipeline(
        timeout_seconds=2,
        resolver=resolver,
        transport_factory=lambda _pins: httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_range_returns_exact_raw_bytes_and_required_metadata() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return response(
            206,
            request,
            headers={
                "content-range": "bytes 10-14/100",
                "content-type": "application/warc",
            },
            content=b"abcde",
        )

    result = await pipeline(handler).read_range(
        RangeReadRequest("https://data.example/archive.warc.gz", 10, 5, 2)
    )
    assert seen[0].method == "GET"
    assert seen[0].headers["range"] == "bytes=10-14"
    assert seen[0].headers["accept-encoding"] == "identity"
    assert result.content == b"abcde"
    assert result.range_start == 10
    assert result.range_end == 14
    assert result.total_bytes == 100
    assert result.redirect_chain == ("https://data.example/archive.warc.gz",)
    assert (
        result.to_dict()["sha256"]
        == "36bbe50ed96841d10443bcb670d6554f0a34b761be67ec9c4a8ad2c0c44ca42c"
    )


@pytest.mark.asyncio
async def test_range_accepts_a_short_final_range() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return response(
            206,
            request,
            headers={"content-range": "bytes 98-99/100"},
            content=b"xy",
        )

    result = await pipeline(handler).read_range(
        RangeReadRequest("https://data.example/archive.warc.gz", 98, 10)
    )
    assert result.content == b"xy"
    assert result.range_end == 99


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "headers", "content", "message"),
    [
        (200, {}, b"abcde", "HTTP 206"),
        (206, {"content-range": "bytes 9-13/100"}, b"abcde", "inconsistent"),
        (206, {"content-range": "bytes 10-14/100"}, b"abcdef", "byte limit"),
        (
            206,
            {"content-range": "bytes 10-14/100", "content-encoding": "gzip"},
            b"abcde",
            "content encoding",
        ),
        (206, {"content-range": "items 10-14/100"}, b"abcde", "invalid Content-Range"),
    ],
)
async def test_range_rejects_unbounded_or_inconsistent_origin_responses(
    status: int, headers: dict[str, str], content: bytes, message: str
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return response(status, request, headers=headers, content=content)

    with pytest.raises(ValueError, match=message):
        await pipeline(handler).read_range(
            RangeReadRequest("https://data.example/archive.warc.gz", 10, 5)
        )


@pytest.mark.asyncio
async def test_range_checks_redirect_target_before_second_transport() -> None:
    transports = 0

    async def resolver(host: str, _port: int) -> list[str]:
        return ["93.184.216.34"] if host == "public.example" else ["127.0.0.1"]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "http://private.example/warc"},
            request=request,
        )

    def transport_factory(_pins):
        nonlocal transports
        transports += 1
        return httpx.MockTransport(handler)

    reader = ReaderPipeline(resolver=resolver, transport_factory=transport_factory)
    with pytest.raises(ValueError, match="private or special"):
        await reader.read_range(RangeReadRequest("https://public.example/warc", 0, 5))
    assert transports == 1


@pytest.mark.asyncio
async def test_range_enforces_redirect_limit() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/again"}, request=request)

    with pytest.raises(ValueError, match="too many redirects"):
        await pipeline(handler).read_range(
            RangeReadRequest("https://public.example/warc", 0, 5, max_redirects=0)
        )


@pytest.mark.asyncio
async def test_range_cancellation_stops_the_active_origin_request() -> None:
    started = asyncio.Event()
    released = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            released.set()
        return httpx.Response(206, request=request)

    task = asyncio.create_task(
        pipeline(handler).read_range(RangeReadRequest("https://public.example/warc", 0, 5))
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(released.wait(), 1)


def test_range_request_and_content_range_validation() -> None:
    validate_range_request(RangeReadRequest("https://public.example/warc", 0, MAX_RANGE_BYTES, 10))
    for request in (
        RangeReadRequest("https://public.example/warc", -1, 1),
        RangeReadRequest("https://public.example/warc", 0, 0),
        RangeReadRequest("https://public.example/warc", 0, MAX_RANGE_BYTES + 1),
        RangeReadRequest("https://public.example/warc", 2**63 - 1, 2),
        RangeReadRequest("https://public.example/warc", 0, 1, 11),
    ):
        with pytest.raises(ValueError):
            validate_range_request(request)
    assert parse_content_range("bytes 0-0/1") == (0, 0, 1)
    for value in (None, "bytes 1-0/2", "bytes 0-1/1", "bytes 00-01/2", "bytes */2"):
        with pytest.raises(ValueError):
            parse_content_range(value)
