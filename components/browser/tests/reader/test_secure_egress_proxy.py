from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "secure_egress_proxy.py"
spec = importlib.util.spec_from_file_location("secure_egress_proxy", MODULE_PATH)
assert spec is not None and spec.loader is not None
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def test_listener_accepts_only_loopback_literals_and_valid_ports() -> None:
    assert proxy.validate_listener("127.0.0.1", 8877) == ("127.0.0.1", 8877)
    assert proxy.validate_listener("::1", 8877) == ("::1", 8877)
    with pytest.raises(RuntimeError):
        proxy.validate_listener("0.0.0.0", 8877)
    with pytest.raises(RuntimeError):
        proxy.validate_listener("localhost", 8877)
    with pytest.raises(RuntimeError):
        proxy.validate_listener("127.0.0.1", 0)


def test_authority_rejects_credentials_and_local_names() -> None:
    with pytest.raises(proxy.ProxyDenied):
        proxy.parse_authority("user:secret@example.org:443", 443)
    with pytest.raises(proxy.ProxyDenied):
        proxy.parse_authority("localhost:443", 443)


def test_authority_parses_ipv6_and_default_port() -> None:
    assert proxy.parse_authority("[2606:4700:4700::1111]", 443) == (
        "2606:4700:4700::1111",
        443,
    )
    assert proxy.format_host_header("2606:4700:4700::1111", 80) == "[2606:4700:4700::1111]"
    assert proxy.format_host_header("2606:4700:4700::1111", 8080) == "[2606:4700:4700::1111]:8080"


@pytest.mark.parametrize(
    "authority",
    ["https://example.org:443", "example.org/path", "example.org?x", "example.org#x", "user@example.org:443", "2606:4700:4700::1111", "example.org:443:extra", " example.org:443"],
)
def test_connect_requires_strict_authority_form(authority: str) -> None:
    with pytest.raises(proxy.ProxyDenied):
        proxy.parse_authority(authority, 443)


def test_resolution_rejects_private_literal() -> None:
    with pytest.raises(proxy.ProxyDenied):
        asyncio.run(proxy.resolve_public("127.0.0.1", 80))


def test_resolution_accepts_public_literal_without_dns() -> None:
    assert asyncio.run(proxy.resolve_public("1.1.1.1", 443)) == [(2, "1.1.1.1")]


def test_functional_health_target_is_branded_and_network_independent() -> None:
    class Writer:
        def __init__(self) -> None:
            self.data = bytearray()

        def write(self, value: bytes) -> None:
            self.data.extend(value)

        async def drain(self) -> None:
            return None

        def close(self) -> None:
            return None

        async def wait_closed(self) -> None:
            return None

    async def run() -> bytes:
        reader = asyncio.StreamReader()
        reader.feed_data(b"GET http://webx-egress.invalid/.well-known/webx-egress-health HTTP/1.1\r\nHost: webx-egress.invalid\r\n\r\n")
        reader.feed_eof()
        writer = Writer()
        await proxy.handle_client(reader, writer)
        return bytes(writer.data)

    response = asyncio.run(run())
    assert response.startswith(b"HTTP/1.1 204 No Content\r\n")
    assert b"WebX-Egress-Proxy: secure-egress/1\r\n" in response
    assert response.endswith(b"\r\n\r\n")


def test_connection_uses_the_validated_address_not_the_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, int, int | None]] = []

    async def resolved(_host: str, _port: int):
        return [(2, "93.184.216.34")]

    async def connected(host: str, port: int, family: int | None = None):
        calls.append((host, port, family))
        return object(), object()

    monkeypatch.setattr(proxy, "resolve_public", resolved)
    monkeypatch.setattr(asyncio, "open_connection", connected)
    asyncio.run(proxy.open_pinned("example.test", 443))
    assert calls == [("93.184.216.34", 443, 2)]


def test_mixed_dns_answers_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    class Loop:
        async def getaddrinfo(self, *_args, **_kwargs):
            return [
                (2, 1, 6, "", ("93.184.216.34", 443)),
                (2, 1, 6, "", ("127.0.0.1", 443)),
            ]

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: Loop())
    with pytest.raises(proxy.ProxyDenied):
        asyncio.run(proxy.resolve_public("example.test", 443))
