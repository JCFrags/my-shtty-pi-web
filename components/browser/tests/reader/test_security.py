from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

MODULE_PATH = Path(__file__).parents[2] / "services/reader/src/pi_web_reader/pipeline.py"
spec = importlib.util.spec_from_file_location("reader_security_pipeline", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://127.1/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.0.1/",
        "http://224.0.0.1/",
        "http://0.0.0.0/",
        "http://user:secret@example.test/",
        "file:///synthetic",
    ],
)
def test_literal_and_credential_ssrf_matrix_is_rejected(url: str) -> None:
    with pytest.raises(ValueError):
        module.validate_public_url_syntax(url)


@pytest.mark.parametrize(
    "addresses",
    [
        ["127.0.0.1"],
        ["169.254.169.254"],
        ["10.0.0.1"],
        ["192.168.1.2"],
        ["::1"],
        ["fe80::1"],
        ["2606:4700:4700::1111", "127.0.0.1"],
        [],
    ],
)
def test_dns_ssrf_matrix_is_rejected(addresses: list[str]) -> None:
    with pytest.raises(ValueError):
        module.validate_public_addresses("public.example", addresses)


def test_public_dns_result_is_selected_deterministically() -> None:
    assert (
        module.validate_public_addresses("public.example", ["93.184.216.35", "93.184.216.34"])
        == "93.184.216.34"
    )


def test_loopback_fixture_exception_is_disabled_by_default() -> None:
    pipeline = module.ReaderPipeline()
    with pytest.raises(ValueError, match="private or special"):
        pipeline._validated_pin("fixture.invalid", 41234, ["127.0.0.1"])


def test_loopback_fixture_exception_is_exact_and_explicit() -> None:
    pipeline = module.ReaderPipeline(test_loopback_fixture=("fixture.invalid", 41234))
    assert pipeline._validated_pin("fixture.invalid", 41234, ["127.0.0.1"]) == "127.0.0.1"
    for host, port, addresses in [
        ("other.invalid", 41234, ["127.0.0.1"]),
        ("fixture.invalid", 41235, ["127.0.0.1"]),
        ("fixture.invalid", 41234, ["127.0.0.1", "93.184.216.34"]),
    ]:
        with pytest.raises(ValueError, match="private or special"):
            pipeline._validated_pin(host, port, addresses)


@pytest.mark.asyncio
async def test_network_backend_connects_only_to_pinned_address() -> None:
    calls: list[tuple[str, int]] = []

    class RecordingBackend:
        async def connect_tcp(self, host: str, port: int, **kwargs):
            calls.append((host, port))
            return object()

    backend = module.PinnedNetworkBackend({"public.example": "93.184.216.34"})
    backend._backend = RecordingBackend()
    await backend.connect_tcp("public.example", 443)
    assert calls == [("93.184.216.34", 443)]
    with pytest.raises(RuntimeError, match="not resolved and pinned"):
        await backend.connect_tcp("other.example", 443)


@pytest.mark.asyncio
async def test_public_fixture_succeeds_and_uses_pinned_address() -> None:
    pins_seen: list[dict[str, str]] = []

    async def resolver(host: str, port: int) -> list[str]:
        assert (host, port) == ("public.example", 443)
        return ["93.184.216.34"]

    def transport_factory(pins: dict[str, str]) -> httpx.MockTransport:
        pins_seen.append(pins)

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.host == "public.example"
            return httpx.Response(
                200,
                headers={"content-type": "text/plain"},
                content=b"Synthetic public fixture content. " * 4,
            )

        return httpx.MockTransport(handler)

    pipeline = module.ReaderPipeline(resolver=resolver, transport_factory=transport_factory)
    result = await pipeline.read(module.ReadRequest(url="https://public.example/article"))
    assert "Synthetic public fixture" in result.content
    assert pins_seen == [{"public.example": "93.184.216.34"}]


@pytest.mark.asyncio
async def test_conditional_request_uses_bounded_validators_only_at_the_validated_url() -> None:
    requests: list[tuple[str, str | None, str | None]] = []

    async def resolver(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    def transport_factory(pins: dict[str, str]) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            requests.append((str(request.url), request.headers.get("if-none-match"), request.headers.get("if-modified-since")))
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/final"})
            return httpx.Response(304, headers={"etag": '"stable-v1"'})

        return httpx.MockTransport(handler)

    pipeline = module.ReaderPipeline(resolver=resolver, transport_factory=transport_factory)
    result = await pipeline.read(module.ReadRequest(
        url="https://public.example/start",
        etag='"stable-v1"',
        last_modified="Fri, 28 Aug 2026 10:00:00 GMT",
        validator_url="https://public.example/final",
    ))
    assert result.not_modified is True
    assert result.content == ""
    assert result.metadata == {"etag": '"stable-v1"'}
    assert requests == [
        ("https://public.example/start", None, None),
        ("https://public.example/final", '"stable-v1"', "Fri, 28 Aug 2026 10:00:00 GMT"),
    ]


@pytest.mark.asyncio
async def test_conditional_request_rejects_unbounded_validators_before_network() -> None:
    pipeline = module.ReaderPipeline(
        resolver=lambda _host, _port: None,  # type: ignore[arg-type]
        transport_factory=lambda _pins: httpx.MockTransport(lambda _request: httpx.Response(200)),
    )
    with pytest.raises(ValueError, match="ETag validator is invalid"):
        await pipeline._fetch("https://public.example/page", accept="text/plain", etag="x" * 1_025)


@pytest.mark.asyncio
async def test_redirect_target_is_resolved_and_rejected_before_second_request() -> None:
    requests: list[str] = []

    async def resolver(host: str, port: int) -> list[str]:
        if host == "public.example":
            return ["93.184.216.34"]
        assert host == "internal.example"
        return ["127.0.0.1"]

    def transport_factory(pins: dict[str, str]) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://internal.example/secret"})

        return httpx.MockTransport(handler)

    pipeline = module.ReaderPipeline(resolver=resolver, transport_factory=transport_factory)
    with pytest.raises(ValueError, match="private or special"):
        await pipeline._fetch("https://public.example/start", accept="text/plain")
    assert requests == ["https://public.example/start"]


@pytest.mark.asyncio
async def test_redirect_with_credentials_is_rejected() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    def transport_factory(pins: dict[str, str]) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda request: httpx.Response(
                302, headers={"location": "https://user:secret@public.example/next"}
            )
        )

    pipeline = module.ReaderPipeline(resolver=resolver, transport_factory=transport_factory)
    with pytest.raises(ValueError, match="credentials"):
        await pipeline._fetch("https://public.example/start", accept="text/plain")
