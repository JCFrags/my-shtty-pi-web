from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).parents[2] / "services/reader/src/pi_web_reader/pipeline.py"
spec = importlib.util.spec_from_file_location("reader_pipeline", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_read_result_uses_coordinator_camel_case_contract() -> None:
    result = module.ReadResult(
        url="https://example.test/",
        title="Example",
        media_type="text/markdown",
        content="content",
        source="raw",
    )
    payload = result.to_dict()
    assert payload["mediaType"] == "text/markdown"
    assert "media_type" not in payload


def test_markdown_candidates_preserve_origin() -> None:
    assert module.markdown_candidates("https://docs.example/a/b?x=1#top") == [
        "https://docs.example/a/b.md",
        "https://docs.example/a/index.md",
    ]


def test_llms_candidates_walk_to_origin() -> None:
    assert module.llms_candidates("https://docs.example/a/b/page", ["llms.txt"]) == [
        "https://docs.example/a/b/llms.txt",
        "https://docs.example/a/llms.txt",
        "https://docs.example/llms.txt",
    ]


def test_static_html_extraction_removes_script_and_navigation_noise() -> None:
    document = """
    <html><head><title>Useful Guide</title><script>window.big = 'noise'</script></head>
    <body><nav>Home Docs About</nav><main><h1>Useful Guide</h1><p>This is a sufficiently long useful paragraph about the implementation and its operational behavior.</p></main></body></html>
    """
    request = module.ReadRequest(url="https://example.test/guide")
    text, title, metadata = module.extract_html(document, request)
    assert title == "Useful Guide"
    assert "window.big" not in text
    assert "implementation" in text
    assert metadata["extractor"] in {"trafilatura", "stdlib-fallback"}


def test_query_context_selects_relevant_paragraphs() -> None:
    text = "First unrelated paragraph.\n\nBrowser profiles persist login state.\n\nNearby details.\n\nFinal unrelated paragraph."
    selected = module.select_query_context(text, "persistent browser profiles", radius=0)
    assert "persist login state" in selected
    assert "First unrelated" not in selected


def test_focused_markdown_keeps_matching_sections_and_omits_other_sections() -> None:
    text = """# Model release

Intro.

## Context and dimensions

The context is 32K and dimensions range from 32 to 4096.

## Architecture benchmarks

Many unrelated benchmark details.

## Tasks

Embedding, ranking, and retrieval are supported.
"""
    selected = module.select_query_context(text, "context dimensions tasks")
    assert "## Context and dimensions" in selected
    assert "## Tasks" in selected
    assert "Architecture benchmarks" not in selected


def test_outline_contains_headings_only() -> None:
    outline = module.outline_from_markdown("# Root\n\nIntro prose.\n\n## Child\n\nBody.")
    assert outline == "# Root\n## Child"


def test_javascript_shell_requests_render() -> None:
    source = '<html><body><div id="root"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>'
    assert module.looks_like_javascript_shell(source, "")
