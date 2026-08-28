from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

MODULE_PATH = Path(__file__).parents[2] / "services/reader/src/pi_web_reader/pipeline.py"
spec = importlib.util.spec_from_file_location("reader_runtime_workers", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def pinned_version(package: str) -> str:
    return {
        "httpx": module.PINNED_HTTPX_VERSION,
        "httpcore": module.PINNED_HTTPCORE_VERSION,
    }[package]


def test_runtime_compatibility_accepts_pinned_hooks() -> None:
    module.assert_runtime_compatibility(pinned_version)


def test_runtime_compatibility_rejects_version_drift() -> None:
    with pytest.raises(RuntimeError, match="incompatible httpx version"):
        module.assert_runtime_compatibility(
            lambda package: (
                "0.0.0" if package == "httpx" else module.PINNED_HTTPCORE_VERSION
            )
        )


def test_runtime_compatibility_rejects_missing_dns_hook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class TransportWithoutPoolHook:
        def __init__(self, **_options: Any) -> None:
            self._pool = object()

    monkeypatch.setattr(module.httpx, "AsyncHTTPTransport", TransportWithoutPoolHook)
    with pytest.raises(RuntimeError, match="DNS-pinning hook"):
        module.assert_runtime_compatibility(pinned_version)


def test_runtime_compatibility_rejects_missing_decompression_hook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ResponseWithoutDecoder:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

    monkeypatch.setattr(module.httpx, "Response", ResponseWithoutDecoder)
    with pytest.raises(RuntimeError, match="decompression hook"):
        module.assert_runtime_compatibility(pinned_version)


@pytest.mark.asyncio
async def test_html_extraction_runs_through_bounded_worker() -> None:
    pipeline = module.ReaderPipeline(worker_timeout_seconds=5)
    content, title, metadata = await pipeline._extract_html(
        "<html><head><title>Worker</title></head><body><h1>Worker</h1>"
        "<p>Useful content from the isolated extraction worker.</p></body></html>",
        module.ReadRequest(url="https://public.example/"),
    )
    assert title == "Worker"
    assert "Useful content" in content
    assert metadata["extractor"] in {"trafilatura", "stdlib-fallback"}


@pytest.mark.asyncio
async def test_worker_output_limit_is_enforced() -> None:
    command = (
        sys.executable,
        "-c",
        "import sys; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'x' * 1024)",
    )
    with pytest.raises(RuntimeError, match="worker output exceeds"):
        await module.run_bounded_process(command, b"input", output_limit=32)


@pytest.mark.asyncio
async def test_worker_cancellation_kills_and_reaps_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[asyncio.subprocess.Process] = []
    create_subprocess_exec = asyncio.create_subprocess_exec

    async def recording_create(*args: Any, **kwargs: Any):
        process = await create_subprocess_exec(*args, **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", recording_create)
    task = asyncio.create_task(
        module.run_bounded_process(
            (sys.executable, "-c", "import time; time.sleep(60)"),
            b"",
            output_limit=32,
        )
    )
    while not created:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert created[0].returncode is not None
