from __future__ import annotations

import asyncio
import multiprocessing
import os
import time
from multiprocessing.connection import Connection
from typing import Any

from .converter import ConvertRequest, convert_document, model_asset_readiness

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
except ImportError as error:  # pragma: no cover
    raise RuntimeError("install the explicit documents profile") from error

WORKER_CONCURRENCY = int(os.getenv("PI_WEB_DOCLING_CONCURRENCY", "1"))
WORKER_QUEUE_SIZE = int(os.getenv("PI_WEB_DOCLING_QUEUE_SIZE", "2"))
WORKER_TIMEOUT_SECONDS = float(os.getenv("PI_WEB_DOCLING_TIMEOUT_SECONDS", "120"))
MAX_INPUT_BYTES = int(os.getenv("PI_WEB_DOCLING_MAX_INPUT_BYTES", str(256 * 1024 * 1024)))
MAX_OUTPUT_BYTES = int(os.getenv("PI_WEB_DOCLING_MAX_OUTPUT_BYTES", str(16 * 1024 * 1024)))
if not 1 <= WORKER_CONCURRENCY <= 2 or not 0 <= WORKER_QUEUE_SIZE <= 8 or not 0 < WORKER_TIMEOUT_SECONDS <= 600:
    raise RuntimeError("Docling worker bounds are invalid")


class ConvertPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    file_path: str = Field(alias="filePath")
    size: int = Field(ge=0, le=MAX_INPUT_BYTES)
    sha256: str = Field(min_length=64, max_length=64)
    media_type: str = Field(alias="mediaType", min_length=1, max_length=255)
    url: str | None = Field(default=None, max_length=8192)
    include_structured: bool = Field(default=False, alias="includeStructured")


class WorkerBusyError(RuntimeError):
    pass


app = FastAPI(title="Pi Web Docling Worker", version="0.1.0")
_worker_slots = asyncio.Semaphore(WORKER_CONCURRENCY)
_admission_lock = asyncio.Lock()
_admitted = 0


def _conversion_process(connection: Connection, request: ConvertRequest) -> None:
    try:
        connection.send((True, convert_document(request)))
    except BaseException as error:
        connection.send((False, f"{type(error).__name__}: {str(error)[:2048]}"))
    finally:
        connection.close()


async def _stop_process(process: multiprocessing.Process) -> None:
    if process.is_alive():
        process.terminate()
    await asyncio.to_thread(process.join, 2)
    if process.is_alive():
        process.kill()
        await asyncio.to_thread(process.join, 2)


async def run_isolated_conversion(
    request: ConvertRequest,
    *,
    timeout_seconds: float = WORKER_TIMEOUT_SECONDS,
    context: multiprocessing.context.BaseContext | None = None,
    target: Any = _conversion_process,
) -> dict[str, Any]:
    """Run one conversion in a process that cancellation and timeout can stop."""
    worker_context = context or multiprocessing.get_context("spawn")
    parent, child = worker_context.Pipe(duplex=False)
    process = worker_context.Process(target=target, args=(child, request), daemon=False)
    process.start()
    child.close()
    deadline = time.monotonic() + timeout_seconds
    try:
        while time.monotonic() < deadline:
            if parent.poll(0):
                ok, value = parent.recv()
                await asyncio.to_thread(process.join, 2)
                if not ok:
                    raise RuntimeError(str(value))
                if not isinstance(value, dict):
                    raise RuntimeError("document worker returned an invalid response")
                return value
            if not process.is_alive():
                await asyncio.to_thread(process.join, 2)
                raise RuntimeError(f"document worker exited without a response ({process.exitcode})")
            await asyncio.sleep(0.02)
        raise TimeoutError(f"document conversion exceeded {timeout_seconds:g} seconds")
    finally:
        parent.close()
        await _stop_process(process)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "pi-web-docling",
        "limits": {
            "concurrency": WORKER_CONCURRENCY,
            "queueSize": WORKER_QUEUE_SIZE,
            "timeoutSeconds": WORKER_TIMEOUT_SECONDS,
            "maxInputBytes": MAX_INPUT_BYTES,
            "maxOutputBytes": MAX_OUTPUT_BYTES,
        },
        "modelAssets": model_asset_readiness(),
    }


@app.post("/v1/convert")
async def convert(payload: ConvertPayload) -> dict[str, Any]:
    global _admitted
    async with _admission_lock:
        if _admitted >= WORKER_CONCURRENCY + WORKER_QUEUE_SIZE:
            raise HTTPException(status_code=503, detail="document worker queue is full")
        _admitted += 1
    try:
        async with _worker_slots:
            return await run_isolated_conversion(ConvertRequest(
                file_path=payload.file_path,
                size=payload.size,
                sha256=payload.sha256,
                media_type=payload.media_type,
                url=payload.url,
                include_structured=payload.include_structured,
            ))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except WorkerBusyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    finally:
        async with _admission_lock:
            _admitted -= 1


def run() -> None:
    import uvicorn

    uvicorn.run(
        "pi_web_docling.main:app",
        host=os.getenv("PI_WEB_DOCLING_HOST", "127.0.0.1"),
        port=int(os.getenv("PI_WEB_DOCLING_PORT", "8792")),
        workers=1,
        reload=False,
    )
