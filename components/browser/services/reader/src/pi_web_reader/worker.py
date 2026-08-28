from __future__ import annotations

import json
import resource
import sys
from pathlib import Path

# Direct execution keeps this worker independent from package entry-point behavior.
sys.path.insert(0, str(Path(__file__).parents[1]))

from pi_web_reader.extractors import EXTRACTORS, extract_html
from pi_web_reader.pipeline import MAX_WORKER_OUTPUT_BYTES


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in EXTRACTORS:
        return 2
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
        result = extract_html(
            str(payload["html"]),
            str(payload["url"]),
            str(payload["view"]),  # type: ignore[arg-type]
            str(payload["query"]) if payload.get("query") is not None else None,
            extractor_id=sys.argv[1],
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return 2
    output = json.dumps(
        {
            "content": result.content,
            "title": result.title,
            "extractor": result.extractor,
            "metadata": result.metadata,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(output) > MAX_WORKER_OUTPUT_BYTES:
        return 3
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
