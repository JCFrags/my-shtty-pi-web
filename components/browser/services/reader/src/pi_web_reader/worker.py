from __future__ import annotations

import json
import resource
import sys
from pathlib import Path

# Direct execution keeps this worker independent from package entry-point behavior.
sys.path.insert(0, str(Path(__file__).parents[1]))

from pi_web_reader.pipeline import MAX_WORKER_OUTPUT_BYTES, ReadRequest, extract_html


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"main", "outline", "raw"}:
        return 2
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    document = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    request = ReadRequest(url="https://worker.invalid/", view=sys.argv[1])  # type: ignore[arg-type]
    content, title, metadata = extract_html(document, request)
    output = json.dumps(
        {"content": content, "title": title, "metadata": metadata},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(output) > MAX_WORKER_OUTPUT_BYTES:
        return 3
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
