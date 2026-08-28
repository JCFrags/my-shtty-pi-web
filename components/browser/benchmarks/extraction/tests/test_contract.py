from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("extraction_benchmark", ROOT / "run.py")
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def manifest():
    return json.loads((ROOT / "manifest.json").read_text())


def test_manifest_covers_required_classes_and_annotations() -> None:
    data = manifest()
    required = {
        "technical-docs", "news-article", "blog", "product", "wikipedia-like",
        "github-repository", "issue-or-pull-request", "hacker-news-like",
        "reddit-forum-like", "static-html", "javascript-shell", "cookie-wall",
        "challenge-captcha", "json-api", "rss", "atom", "plain-text",
        "negotiated-markdown", "oversized-response", "bad-charset",
        "redirect-chain-metadata", "compressed-content-metadata", "pdf-text",
        "pdf-table", "scanned-pdf", "docx", "pptx", "xlsx",
    }
    assert required <= {case["class"] for case in data["cases"]}
    for case in data["cases"]:
        assert case["requiredMarkers"] is not None
        assert case["forbiddenMarkers"] is not None
        assert set(case["structure"]) == {"headings", "codeBlocks", "tables", "links", "structuredRows"}
        assert case["expectedOutcome"] and case["expectedPath"] and case["allowedLoss"]


def test_fixture_hashes_and_generator_are_stable() -> None:
    data = manifest()
    case_files = [case["file"] for case in data["cases"]]
    assert len(case_files) == len(set(case_files))
    declared_files = set(case_files)
    for case in data["cases"]:
        content = (ROOT / "fixtures" / case["file"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == case["sha256"]
        if fallback := case.get("fallbackFile"):
            declared_files.add(fallback)
            fallback_content = (ROOT / "fixtures" / fallback).read_bytes()
            assert hashlib.sha256(fallback_content).hexdigest() == case["fallbackSha256"]
    assert declared_files == {path.name for path in (ROOT / "fixtures").iterdir()}
    for name, content in runner_import_generator().build().items():
        assert (ROOT / "fixtures" / name).read_bytes() == content


def runner_import_generator():
    generator_spec = importlib.util.spec_from_file_location(
        "extraction_fixture_generator", ROOT / "generate_fixtures.py"
    )
    assert generator_spec and generator_spec.loader
    generator = importlib.util.module_from_spec(generator_spec)
    generator_spec.loader.exec_module(generator)
    return generator


def test_runner_bounds_are_finite_and_small() -> None:
    limits = manifest()["limits"]
    assert 0 < limits["caseSeconds"] <= 60
    assert 0 < limits["totalSeconds"] <= 300
    assert 0 < limits["inputBytes"] <= 256 * 1024
    assert 0 < limits["outputBytes"] <= 65_536
    assert 0 < limits["memoryBytes"] <= 4 * 1024**3
    assert 0 < limits["diskBytes"] <= 8 * 1024**2
    assert 0 < limits["processes"] <= 64
    assert 0 < limits["reportBytes"] <= 256 * 1024


def test_baseline_separates_environment_from_stable_quality() -> None:
    baseline = json.loads((ROOT / "current-baseline.json").read_text())
    assert set(baseline) == {"schemaVersion", "environment", "quality"}
    assert baseline["environment"]["packages"]["trafilatura"]
    assert all("runtime" not in row for row in baseline["quality"])
    assert runner.compare_baseline(ROOT / "current-baseline.json", baseline["quality"]) == []
    changed = json.loads(json.dumps(baseline["quality"]))
    changed[0]["status"] = "changed"
    assert runner.compare_baseline(ROOT / "current-baseline.json", changed)


def test_optional_adapters_are_skipped_and_report_is_bounded() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    skipped = [row for row in report["results"] if row["adapter"] != "current"]
    assert {row["adapter"] for row in skipped} == {"secondary-html", "alternate-pdf"}
    assert all(row["status"] == "skipped" for row in skipped)
    assert (ROOT / "reports/current-run.json").stat().st_size <= manifest()["limits"]["reportBytes"]


def test_quality_snapshot_and_command_exit_semantics() -> None:
    baseline = json.loads((ROOT / "current-baseline.json").read_text())
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    assert runner.stable_quality(report["results"]) == baseline["quality"]
    assert runner.exit_code([]) == 0
    assert runner.exit_code(["quality regression"]) == 1
