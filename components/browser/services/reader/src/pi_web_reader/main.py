from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

from .pipeline import (
    MAX_PUBLIC_REDIRECTS,
    MAX_RANGE_BYTES,
    RangeReadRequest,
    ReaderPipeline,
    ReadRequest,
)

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
except ImportError as error:  # pragma: no cover - exercised only on partial installs
    raise RuntimeError("install reader dependencies with `uv sync --all-packages`") from error

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]


class RangeReadPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    url: str
    offset: int = Field(ge=0)
    length: int = Field(ge=1, le=MAX_RANGE_BYTES)
    max_redirects: int = Field(default=4, ge=0, le=MAX_PUBLIC_REDIRECTS, alias="maxRedirects")


class ReadPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    url: str
    query: str | None = None
    view: str = "main"
    max_chars: int = Field(default=1_000_000, ge=1, le=1_000_000, alias="maxChars")
    require_markdown: bool = Field(default=False, alias="requireMarkdown")
    allow_llms_full: bool = Field(default=False, alias="allowLlmsFull")
    fields: list[str] = Field(default_factory=list, max_length=32)
    item_offset: int = Field(default=0, ge=0, alias="itemOffset")
    item_limit: int = Field(default=50, ge=1, le=500, alias="itemLimit")
    content_offset: int = Field(default=0, ge=0, le=100_000_000, alias="contentOffset")


def _pipeline() -> ReaderPipeline:
    """Permit one explicit loopback fixture only in the deterministic smoke process."""
    fixture = os.getenv("PI_WEB_TEST_LOOPBACK_ORIGIN")
    if fixture is None:
        return ReaderPipeline()
    parsed = urlparse(fixture)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "fixture.invalid"
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("PI_WEB_TEST_LOOPBACK_ORIGIN must be http://fixture.invalid:PORT")

    async def fixture_resolver(host: str, port: int) -> list[str]:
        if host != "fixture.invalid" or port != parsed.port:
            raise ValueError("deterministic reader refused a non-fixture destination")
        return ["127.0.0.1"]

    return ReaderPipeline(
        resolver=fixture_resolver,
        test_loopback_fixture=("fixture.invalid", parsed.port),
    )


pipeline = _pipeline()
app = FastAPI(title="Pi Web Reader", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "pi-web-reader",
        "doclingUrl": pipeline.docling_url,
        "resolutionOrder": [
            "markdown-negotiation",
            "markdown-fallback",
            "trafilatura",
            "llms.txt-fallback",
            "coordinator-render-escalation",
        ],
    }


@app.post("/v1/read-range")
async def read_range(payload: RangeReadPayload) -> dict[str, Any]:
    try:
        request = RangeReadRequest(
            url=payload.url,
            offset=payload.offset,
            length=payload.length,
            max_redirects=payload.max_redirects,
        )
        return (await pipeline.read_range(request)).to_dict()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        if httpx is not None and isinstance(error, httpx.HTTPError):
            raise HTTPException(status_code=502, detail="range origin request failed") from error
        raise HTTPException(status_code=502, detail="range processing failed") from error


@app.post("/v1/read")
async def read(payload: ReadPayload) -> dict[str, Any]:
    try:
        request = ReadRequest(
            url=payload.url,
            query=payload.query,
            view=payload.view,  # type: ignore[arg-type]
            max_chars=payload.max_chars,
            require_markdown=payload.require_markdown,
            allow_llms_full=payload.allow_llms_full,
            fields=tuple(payload.fields),
            item_offset=payload.item_offset,
            item_limit=payload.item_limit,
            content_offset=payload.content_offset,
        )
        return (await pipeline.read(request)).to_dict()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        if httpx is not None and isinstance(error, httpx.HTTPStatusError):
            upstream_status = error.response.status_code
            raise HTTPException(
                status_code=upstream_status,
                detail={
                    "detail": f"upstream returned HTTP {upstream_status}",
                    "upstreamStatus": upstream_status,
                    "toolStatus": upstream_status,
                    "retryable": upstream_status == 429 or upstream_status >= 500,
                },
            ) from error
        raise HTTPException(status_code=502, detail="reader processing failed") from error


def run() -> None:
    import uvicorn

    uvicorn.run(
        "pi_web_reader.main:app",
        host=os.getenv("PI_WEB_READER_HOST", "127.0.0.1"),
        port=int(os.getenv("PI_WEB_READER_PORT", "8787")),
        reload=False,
    )
