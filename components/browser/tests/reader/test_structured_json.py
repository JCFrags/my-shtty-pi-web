from __future__ import annotations

import json

from pi_web_reader.pipeline import FetchResult, ReadRequest, finalize_json_result


def fetched(value: object, media_type: str = "application/json") -> FetchResult:
    text = json.dumps(value)
    return FetchResult(
        url="https://api.example.test/releases.json",
        status=200,
        media_type=media_type,
        text=text,
        content=text.encode(),
        headers={},
    )


def test_json_filter_projection_and_pagination() -> None:
    result = finalize_json_result(
        fetched(
            {
                "results": [
                    {"name": "alpha", "version": "1.0", "noise": "x"},
                    {"name": "beta", "version": "2.0", "noise": "y"},
                    {"name": "beta", "version": "3.0", "noise": "z"},
                ]
            }
        ),
        ReadRequest(
            url="https://api.example.test/releases.json",
            query="beta",
            fields=("results.name", "results.version"),
            item_offset=1,
            item_limit=1,
        ),
    )
    assert json.loads(result.content) == {
        "results.name": ["beta"],
        "results.version": ["3.0"],
    }
    assert result.source == "structured-json"
    assert result.metadata["structured"] is True
    assert result.metadata["totalItems"] == 3
    assert result.metadata["matchedItems"] == 2
    assert result.metadata["returnedItems"] == 1
    assert result.metadata["nextItemOffset"] is None


def test_json_vendor_media_type_is_structured() -> None:
    result = finalize_json_result(
        fetched({"features": [{"id": 1}]}, "application/geo+json"),
        ReadRequest(url="https://api.example.test/alerts"),
    )
    assert result.source == "structured-json"


def test_json_defaults_bound_large_lists_by_item_count() -> None:
    result = finalize_json_result(
        fetched(list(range(100))),
        ReadRequest(url="https://api.example.test/releases.json"),
    )
    assert len(json.loads(result.content)) == 50
    assert result.metadata["nextItemOffset"] == 50
