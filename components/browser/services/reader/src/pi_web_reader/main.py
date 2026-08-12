from __future__ import annotations

import os
from typing import Any

from .pipeline import ReaderPipeline, ReadRequest

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
except ImportError as error:  # pragma: no cover - exercised only on partial installs
    raise RuntimeError("install reader dependencies with `uv sync --all-packages`") from error


class ReadPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    url: str
    query: str | None = None
    view: str = "main"
    max_chars: int = Field(default=20_000, alias="maxChars")
    require_markdown: bool = Field(default=False, alias="requireMarkdown")
    allow_llms_full: bool = Field(default=False, alias="allowLlmsFull")


pipeline = ReaderPipeline()
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
            "llms.txt",
            "trafilatura",
            "coordinator-render-escalation",
        ],
    }


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
        )
        return (await pipeline.read(request)).to_dict()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


def run() -> None:
    import uvicorn

    uvicorn.run(
        "pi_web_reader.main:app",
        host=os.getenv("PI_WEB_READER_HOST", "127.0.0.1"),
        port=int(os.getenv("PI_WEB_READER_PORT", "8787")),
        reload=False,
    )
