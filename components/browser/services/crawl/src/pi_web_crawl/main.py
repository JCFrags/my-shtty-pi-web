from __future__ import annotations

import asyncio
import os
from collections import deque
from typing import Any
from urllib.parse import urldefrag, urlparse

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

app = FastAPI(title="Pi Web Crawl", version="0.1.0")


class CrawlPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=8192)
    maxPages: int = Field(default=5, ge=1, le=20)
    maxDepth: int = Field(default=1, ge=0, le=3)
    maxChars: int = Field(default=50000, ge=1, le=200000)
    sameDomain: bool = True


def _public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("only plain HTTP or HTTPS URLs are supported")
    return urldefrag(value)[0]


def _links(result: Any) -> list[str]:
    links = getattr(result, "links", None)
    if not isinstance(links, dict):
        return []
    values: list[str] = []
    for group in ("internal", "external"):
        entries = links.get(group, [])
        if not isinstance(entries, list):
            continue
        for entry in entries:
            href = entry.get("href") if isinstance(entry, dict) else None
            if isinstance(href, str):
                values.append(href)
    return values


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok", "engine": "crawl4ai-0.9.2"}


@app.post("/v1/crawl")
async def crawl(payload: CrawlPayload) -> dict[str, Any]:
    try:
        start = _public_url(payload.url)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    origin_host = urlparse(start).hostname
    proxy = os.environ.get("PI_WEB_CRAWL_PROXY", "http://127.0.0.1:8877")
    browser = BrowserConfig(headless=True, proxy=proxy, verbose=False, text_mode=True)
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        check_robots_txt=True,
        page_timeout=30000,
        wait_until="domcontentloaded",
        exclude_all_images=True,
        remove_forms=True,
        verbose=False,
    )
    queue: deque[tuple[str, int]] = deque([(start, 0)])
    seen: set[str] = set()
    pages: list[dict[str, Any]] = []
    used_chars = 0
    truncated = False
    try:
        async with asyncio.timeout(90):
            async with AsyncWebCrawler(config=browser) as crawler:
                while queue and len(pages) < payload.maxPages and used_chars < payload.maxChars:
                    url, depth = queue.popleft()
                    if url in seen:
                        continue
                    seen.add(url)
                    result = await crawler.arun(url=url, config=run_config)
                    if not getattr(result, "success", False):
                        pages.append({"url": url, "depth": depth, "ok": False, "error": str(getattr(result, "error_message", "crawl failed"))[:500]})
                        continue
                    final_url = str(getattr(result, "url", url))
                    markdown = getattr(result, "markdown", "")
                    content = str(getattr(markdown, "fit_markdown", None) or getattr(markdown, "raw_markdown", None) or markdown or "")
                    remaining = payload.maxChars - used_chars
                    bounded = content[:remaining]
                    used_chars += len(bounded)
                    pages.append({"url": final_url, "depth": depth, "ok": True, "content": bounded, "truncated": len(content) > len(bounded)})
                    truncated = truncated or len(content) > len(bounded)
                    if depth >= payload.maxDepth:
                        continue
                    for raw_link in _links(result):
                        try:
                            link = _public_url(raw_link)
                        except ValueError:
                            continue
                        if payload.sameDomain and urlparse(link).hostname != origin_host:
                            continue
                        if link not in seen:
                            queue.append((link, depth + 1))
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail="crawl exceeded 90 seconds") from error
    truncated = truncated or bool(queue) or used_chars >= payload.maxChars
    return {"startUrl": start, "pages": pages, "pageCount": len(pages), "truncated": truncated}


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=os.environ.get("PI_WEB_CRAWL_HOST", "127.0.0.1"), port=int(os.environ.get("PI_WEB_CRAWL_PORT", "8793")))
