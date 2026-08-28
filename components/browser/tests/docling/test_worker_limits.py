from __future__ import annotations

import asyncio
import importlib
import multiprocessing
import os
from pathlib import Path
from typing import Any

import pytest

main = importlib.import_module("pi_web_docling.main")
converter = importlib.import_module("pi_web_docling.converter")


def wait_forever(connection: Any, request: Any) -> None:
    Path(request.file_path).write_text(str(os.getpid()), encoding="utf-8")
    try:
        while True:
            pass
    finally:
        connection.close()


def return_success(connection: Any, _request: Any) -> None:
    connection.send((True, {"markdown": "worker recovered"}))
    connection.close()


def sample_request(path: Path) -> Any:
    return converter.ConvertRequest(
        file_path=str(path),
        size=0,
        sha256="0" * 64,
        media_type="text/plain",
    )


@pytest.mark.asyncio
async def test_cancel_stops_worker_and_next_conversion_recovers(tmp_path: Path) -> None:
    context = multiprocessing.get_context("spawn")
    pid_file = tmp_path / "worker.pid"
    task = asyncio.create_task(main.run_isolated_conversion(
        sample_request(pid_file), timeout_seconds=10, context=context, target=wait_forever
    ))
    for _ in range(100):
        if pid_file.exists():
            break
        await asyncio.sleep(0.01)
    assert pid_file.exists()
    pid = int(pid_file.read_text(encoding="utf-8"))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not Path(f"/proc/{pid}").exists()

    result = await main.run_isolated_conversion(
        sample_request(tmp_path / "unused"), timeout_seconds=2, context=context, target=return_success
    )
    assert result == {"markdown": "worker recovered"}


@pytest.mark.asyncio
async def test_timeout_stops_worker(tmp_path: Path) -> None:
    context = multiprocessing.get_context("spawn")
    pid_file = tmp_path / "timeout.pid"
    with pytest.raises(TimeoutError, match="exceeded"):
        await main.run_isolated_conversion(
            sample_request(pid_file), timeout_seconds=0.5, context=context, target=wait_forever
        )
    pid = int(pid_file.read_text(encoding="utf-8"))
    assert not Path(f"/proc/{pid}").exists()
