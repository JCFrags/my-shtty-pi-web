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


def test_resolution_rejects_private_literal() -> None:
    with pytest.raises(proxy.ProxyDenied):
        asyncio.run(proxy.resolve_public("127.0.0.1", 80))


def test_resolution_accepts_public_literal_without_dns() -> None:
    assert asyncio.run(proxy.resolve_public("1.1.1.1", 443)) == [(2, "1.1.1.1")]


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
