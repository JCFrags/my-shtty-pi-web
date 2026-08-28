from __future__ import annotations

import asyncio
import gzip
import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

MODULE_PATH = Path(__file__).parents[2] / "services/reader/src/pi_web_reader/pipeline.py"
spec = importlib.util.spec_from_file_location("reader_limits_pipeline", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class AsyncBytes(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self):
        yield self.content


async def public_resolver(_host: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


def test_acquisition_defaults_are_finite_and_overrides_are_bounded() -> None:
    pipeline = module.ReaderPipeline()
    assert 0 < pipeline.timeout_seconds <= module.MAX_HTTP_TIMEOUT_SECONDS
    assert 0 < pipeline.max_raw_bytes <= module.MAX_MAX_RAW_BYTES
    assert 0 < pipeline.max_download_bytes <= module.MAX_MAX_DECOMPRESSED_BYTES
    assert 0 <= pipeline.max_redirects <= module.MAX_PUBLIC_REDIRECTS

    with pytest.raises(ValueError, match="HTTP timeout"):
        module.ReaderPipeline(timeout_seconds=module.MAX_HTTP_TIMEOUT_SECONDS + 1)
    with pytest.raises(ValueError, match="raw byte limit"):
        module.ReaderPipeline(max_raw_bytes=module.MAX_MAX_RAW_BYTES + 1)
    with pytest.raises(ValueError, match="decompressed byte limit"):
        module.ReaderPipeline(max_download_bytes=module.MAX_MAX_DECOMPRESSED_BYTES + 1)
    with pytest.raises(ValueError, match="redirect limit"):
        module.ReaderPipeline(max_redirects=module.MAX_PUBLIC_REDIRECTS + 1)
    with pytest.raises(ValueError, match="acquisition concurrency"):
        module.ReaderPipeline(acquisition_concurrency=module.MAX_ACQUISITION_CONCURRENCY + 1)


@pytest.mark.asyncio
async def test_chunked_raw_response_limit_is_enforced() -> None:
    compressed = gzip.compress(b"small body")

    def transport_factory(_pins: dict[str, str]) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"content-type": "text/plain", "content-encoding": "gzip"},
                stream=AsyncBytes(compressed),
            )
        )

    pipeline = module.ReaderPipeline(
        resolver=public_resolver,
        transport_factory=transport_factory,
        max_raw_bytes=len(compressed) - 1,
    )
    with pytest.raises(ValueError, match="raw response exceeds"):
        await pipeline.read(module.ReadRequest(url="https://public.example/raw"))


@pytest.mark.asyncio
async def test_decompressed_response_limit_is_enforced() -> None:
    compressed = gzip.compress(b"expanded content " * 100)

    def transport_factory(_pins: dict[str, str]) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"content-type": "text/plain", "content-encoding": "gzip"},
                stream=AsyncBytes(compressed),
            )
        )

    pipeline = module.ReaderPipeline(
        resolver=public_resolver,
        transport_factory=transport_factory,
        max_download_bytes=100,
    )
    with pytest.raises(ValueError, match="decompressed response exceeds"):
        await pipeline.read(module.ReadRequest(url="https://public.example/expanded"))


@pytest.mark.asyncio
async def test_acquisition_timeout_includes_the_complete_operation() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"late")

    pipeline = module.ReaderPipeline(
        resolver=public_resolver,
        transport_factory=lambda _pins: httpx.MockTransport(handler),
        timeout_seconds=0.01,
    )
    with pytest.raises(TimeoutError):
        await pipeline.read(module.ReadRequest(url="https://public.example/slow"))


@pytest.mark.asyncio
async def test_acquisition_concurrency_is_bounded() -> None:
    active = 0
    maximum = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            content=b"Synthetic public fixture content. " * 4,
        )

    pipeline = module.ReaderPipeline(
        resolver=public_resolver,
        transport_factory=lambda _pins: httpx.MockTransport(handler),
        acquisition_concurrency=2,
    )
    await asyncio.gather(
        *(pipeline.read(module.ReadRequest(url=f"https://public.example/{index}")) for index in range(5))
    )
    assert maximum == 2


@pytest.mark.asyncio
async def test_redirect_override_stops_before_unapproved_hop() -> None:
    requests = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(302, headers={"location": "/again"})

    pipeline = module.ReaderPipeline(
        resolver=public_resolver,
        transport_factory=lambda _pins: httpx.MockTransport(handler),
        max_redirects=1,
    )
    with pytest.raises(ValueError, match="too many redirects"):
        await pipeline.read(module.ReadRequest(url="https://public.example/start"))
    assert requests == 2
