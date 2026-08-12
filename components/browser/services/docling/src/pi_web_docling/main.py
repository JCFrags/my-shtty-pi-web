from __future__ import annotations

import os
from typing import Any

from .converter import ConvertRequest, convert_document

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
except ImportError as error:  # pragma: no cover
    raise RuntimeError(
        "install Docling worker dependencies with `uv sync --all-packages`"
    ) from error


class ConvertPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data_base64: str = Field(alias="dataBase64")
    media_type: str = Field(alias="mediaType")
    url: str | None = None
    include_structured: bool = Field(default=False, alias="includeStructured")


app = FastAPI(title="Pi Web Docling Worker", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "pi-web-docling"}


@app.post("/v1/convert")
async def convert(payload: ConvertPayload) -> dict[str, Any]:
    try:
        return convert_document(
            ConvertRequest(
                data_base64=payload.data_base64,
                media_type=payload.media_type,
                url=payload.url,
                include_structured=payload.include_structured,
            )
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


def run() -> None:
    import uvicorn

    uvicorn.run(
        "pi_web_docling.main:app",
        host=os.getenv("PI_WEB_DOCLING_HOST", "127.0.0.1"),
        port=int(os.getenv("PI_WEB_DOCLING_PORT", "8792")),
        reload=False,
    )
