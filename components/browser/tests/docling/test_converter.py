from __future__ import annotations

import base64
import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).parents[2] / "services/docling/src/pi_web_docling/converter.py"
spec = importlib.util.spec_from_file_location("docling_converter", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_decode_payload_and_suffix() -> None:
    payload = base64.b64encode(b"document").decode()
    assert module.decode_payload(payload) == b"document"
    assert module.safe_suffix("application/pdf", "https://example.test/a.pdf") == ".pdf"
