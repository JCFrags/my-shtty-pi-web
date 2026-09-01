#!/usr/bin/env python3
"""Focused tests for the closed Phase 4A qualification fixture proxy."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).with_name("phase4a-qualification-proxy.py")
SPEC = importlib.util.spec_from_file_location("phase4a_qualification_proxy", SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("qualification proxy test import failed")
PROXY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROXY)


class QualificationProxyTests(unittest.TestCase):
    def test_routes_only_health_and_two_exact_fixture_urls(self) -> None:
        health = PROXY.route("GET", PROXY.HEALTH_TARGET, "HTTP/1.1")
        self.assertTrue(health.startswith(b"HTTP/1.1 204 No Content\r\n"))
        self.assertIn(b"WebX-Egress-Proxy: secure-egress/1\r\n", health)

        alpha = PROXY.route("GET", "http://93.184.216.34/.well-known/pi-web-qualification/alpha", "HTTP/1.1")
        beta = PROXY.route("GET", "http://93.184.216.34/.well-known/pi-web-qualification/beta", "HTTP/1.0")
        self.assertIn(b"HTTP/1.1 200 OK\r\n", alpha)
        self.assertIn(b"Actor Alpha", alpha)
        self.assertNotIn(b"Actor Beta", alpha)
        self.assertIn(b"Actor Beta", beta)
        self.assertIn(b"X-Pi-Web-Qualification: fixture/1\r\n", beta)

        denied = [
            ("CONNECT", "93.184.216.34:80", "HTTP/1.1"),
            ("POST", "http://93.184.216.34/.well-known/pi-web-qualification/alpha", "HTTP/1.1"),
            ("GET", "https://93.184.216.34/.well-known/pi-web-qualification/alpha", "HTTP/1.1"),
            ("GET", "http://example.com/.well-known/pi-web-qualification/alpha", "HTTP/1.1"),
            ("GET", "http://93.184.216.34/.well-known/pi-web-qualification/alpha?extra=1", "HTTP/1.1"),
            ("GET", "http://93.184.216.34/.well-known/pi-web-qualification/gamma", "HTTP/1.1"),
            ("GET", "http://93.184.216.34/", "HTTP/1.1"),
            ("GET", "http://93.184.216.34/.well-known/pi-web-qualification/alpha", "HTTP/2.0"),
        ]
        for method, target, version in denied:
            with self.subTest(method=method, target=target, version=version):
                with self.assertRaises(PROXY.Denied):
                    PROXY.route(method, target, version)

    def test_lease_is_private_single_linked_and_exactly_release_bound(self) -> None:
        sha = "a" * 40
        release_id = f"phase4a-{sha}"
        with tempfile.TemporaryDirectory(prefix="phase4a-proxy-test-") as temporary:
            root = Path(temporary)
            release = root / release_id
            executable = release / "bin" / "pi-web-qualification-proxy"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(SOURCE.read_bytes())
            manifest = json.dumps({"releaseId": release_id, "gitSha": sha}, separators=(",", ":")).encode()
            (release / "manifest.json").write_bytes(manifest)
            qualification = root / "runtime" / "pi-web" / "qualification"
            qualification.mkdir(parents=True)
            lease = qualification / "lease.json"
            lease.write_text(json.dumps({
                "schemaVersion": 1,
                "releaseId": release_id,
                "gitSha": sha,
                "manifestSha256": hashlib.sha256(manifest).hexdigest(),
            }))
            lease.chmod(0o600)

            original_file = PROXY.__file__
            PROXY.__file__ = str(executable)
            try:
                with patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(root / "runtime")}, clear=False):
                    PROXY.verify_lease()
                    lease.chmod(0o640)
                    with self.assertRaisesRegex(RuntimeError, "unsafe"):
                        PROXY.verify_lease()
                    lease.chmod(0o600)
                    second_link = qualification / "lease-linked.json"
                    os.link(lease, second_link)
                    with self.assertRaisesRegex(RuntimeError, "unsafe"):
                        PROXY.verify_lease()
                    second_link.unlink()
                    payload = json.loads(lease.read_text())
                    payload["manifestSha256"] = "b" * 64
                    lease.write_text(json.dumps(payload))
                    lease.chmod(0o600)
                    with self.assertRaisesRegex(RuntimeError, "digest"):
                        PROXY.verify_lease()
            finally:
                PROXY.__file__ = original_file

    def test_source_has_no_outbound_client_primitive(self) -> None:
        source = SOURCE.read_text()
        self.assertNotIn("open_connection", source)
        self.assertNotIn("create_connection", source)
        self.assertNotIn("urllib.request", source)
        self.assertNotIn("http.client", source)
        self.assertIn("asyncio.start_server", source)


if __name__ == "__main__":
    unittest.main()
