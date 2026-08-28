from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

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
    production_paths = {"trafilatura", "markdown-fallback", "raw", "structured-json", "markdown-negotiation", "document", "input-limit"}
    for case in data["cases"]:
        assert case["requiredMarkers"] is not None
        assert case["forbiddenMarkers"] is not None
        assert set(case["structure"]) == {"headings", "codeBlocks", "tables", "links", "structuredRows"}
        assert case["expectedOutcome"] and case["expectedPath"] in production_paths and case["allowedLoss"]


def test_representative_structure_requirements_are_meaningful() -> None:
    cases = {case["id"]: case for case in manifest()["cases"]}
    assert cases["technical-docs"]["structure"] == {"headings": 2, "codeBlocks": 1, "tables": 1, "links": 1, "structuredRows": 0}
    assert cases["blog"]["structure"]["codeBlocks"] == 1
    assert cases["product"]["structure"]["tables"] == 1
    assert cases["github-repository"]["structure"]["links"] == 2
    assert cases["negotiated-markdown"]["structure"]["headings"] == 2
    assert cases["pdf-table"]["structure"]["tables"] == 1


def test_acquisition_contracts_do_not_use_expected_metadata_as_results() -> None:
    contracts = [case for case in manifest()["cases"] if case.get("caseKind") == "acquisition-contract"]
    assert {case["class"] for case in contracts} == {"bad-charset", "redirect-chain-metadata", "compressed-content-metadata"}
    for case in contracts:
        assert "metadata" not in case
        assert case["acquisitionExpected"]
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    rows = {row["id"]: row for row in report["results"]}
    for case in contracts:
        quality = rows[case["id"]]["quality"]
        assert quality["contract"] == "acquisition"
        assert quality["observed"] is not case["acquisitionExpected"]
        assert "extractionMetrics" in quality


@pytest.mark.parametrize(
    ("case_id", "reader_check"),
    (
        ("bad-charset", "readerDecodedRequiredMarkers"),
        ("compressed-content", "readerDecompressedRequiredMarkers"),
    ),
)
def test_acquisition_contracts_fail_when_reader_loses_decoded_content(
    monkeypatch: pytest.MonkeyPatch,
    case_id: str,
    reader_check: str,
) -> None:
    case = next(case for case in manifest()["cases"] if case["id"] == case_id)
    content = (ROOT / "fixtures" / case["file"]).read_bytes()
    real_read = runner.pipeline.ReaderPipeline.read

    async def read_without_content(self, request):
        result = await real_read(self, request)
        result.content = ""
        return result

    monkeypatch.setattr(runner.pipeline.ReaderPipeline, "read", read_without_content)
    extracted, observed = asyncio.run(runner.production_read(case, content))
    extraction = runner.extraction_quality(case, extracted, None)
    quality = runner.acquisition_quality(case, observed, extraction)

    assert all(observed.get(key) == value for key, value in case["acquisitionExpected"].items())
    assert extraction["requiredMarkerRetention"]["retained"] == 0
    assert not quality["checks"][reader_check]
    assert quality["outcome"] == "fail"


def test_expected_annotations_do_not_select_production_behavior() -> None:
    case = next(case for case in manifest()["cases"] if case["id"] == "plain-text")
    changed = json.loads(json.dumps(case))
    changed["expectedPath"] = "trafilatura"
    limits = manifest()["limits"]
    original = runner.worker_case({"case": case, "limits": limits})
    measured_after_annotation_change = runner.worker_case({"case": changed, "limits": limits})
    assert original == measured_after_annotation_change
    assert original["extracted"]["path"] == "raw"


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
    generator_spec = importlib.util.spec_from_file_location("extraction_fixture_generator", ROOT / "generate_fixtures.py")
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


def probe_limits(**changes):
    limits = dict(manifest()["limits"])
    limits.update({"caseSeconds": 2, "totalSeconds": 4, "memoryBytes": 1024**3, "diskBytes": 1024**2, "processes": 8, "reportBytes": 256 * 1024})
    limits.update(changes)
    return limits


def test_input_output_and_report_limits_fail_deterministically() -> None:
    with pytest.raises(runner.LimitError, match="input"):
        runner.validate_input_size(b"1234", 3)
    with pytest.raises(runner.LimitError, match="output"):
        runner.validate_output_size("éé", 3)
    with pytest.raises(runner.LimitError, match="report"):
        runner.encode_report({"value": "x" * 100}, 20)


def test_case_and_total_time_limits_are_parent_enforced() -> None:
    limits = probe_limits(caseSeconds=0.1)
    result = runner.run_isolated({"mode": "probe", "action": "sleep", "seconds": 1}, limits, time.monotonic() + 3)
    assert result.error == "LimitError: case time limit exceeded"
    limits = probe_limits(caseSeconds=2)
    result = runner.run_isolated({"mode": "probe", "action": "sleep", "seconds": 1}, limits, time.monotonic() + 0.1)
    assert result.error == "LimitError: total time limit exceeded"


def test_memory_process_and_disk_limits_are_parent_enforced() -> None:
    memory = runner.run_isolated(
        {"mode": "probe", "action": "memory", "amount": 768 * 1024**2},
        probe_limits(memoryBytes=512 * 1024**2),
        time.monotonic() + 4,
    )
    assert memory.error and "memory limit exceeded" in memory.error
    processes = runner.run_isolated(
        {"mode": "probe", "action": "process", "amount": 5},
        probe_limits(processes=2),
        time.monotonic() + 4,
    )
    assert processes.error == "LimitError: process limit exceeded"
    disk = runner.run_isolated(
        {"mode": "probe", "action": "disk", "amount": 256 * 1024},
        probe_limits(diskBytes=64 * 1024),
        time.monotonic() + 4,
    )
    assert disk.error and "limit exceeded" in disk.error


def test_candidate_adapters_cannot_receive_expected_annotations() -> None:
    case = next(case for case in manifest()["cases"] if case["id"] == "news-article")
    adapter_input = runner.execution_case(case)
    assert runner.EXPECTED_ANNOTATIONS.isdisjoint(adapter_input)
    assert adapter_input["id"] == case["id"]
    assert adapter_input["sha256"] == case["sha256"]


def test_absolute_gate_names_classes_and_cannot_pass_by_baseline_rewrite() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    gate = runner.absolute_eligibility(report["results"])
    assert gate["eligible"]
    assert gate["representativeClasses"] == list(runner.ABSOLUTE_QUALITY_POLICY["representativeClasses"])
    assert gate["passedCases"] >= gate["minimumPassedCases"]

    changed = json.loads(json.dumps(report["results"]))
    row = next(item for item in changed if item["class"] == "news-article")
    row["quality"]["requiredMarkerRetention"]["retained"] -= 1
    assert not runner.absolute_eligibility(changed)["eligible"]

    baseline = json.loads((ROOT / "current-baseline.json").read_text())
    baseline["quality"] = runner.stable_quality(changed)
    assert baseline["quality"] == runner.stable_quality(changed)
    assert not runner.absolute_eligibility(changed)["eligible"]


def test_optional_adapter_value_cannot_execute_a_command(tmp_path: Path) -> None:
    marker = tmp_path / "executed"
    configured = f"sh -c 'touch {marker}'"
    assert runner.resolve_optional_adapter(configured) is None
    assert not marker.exists()


def test_baseline_separates_environment_from_stable_quality() -> None:
    baseline = json.loads((ROOT / "current-baseline.json").read_text())
    assert set(baseline) == {"schemaVersion", "environment", "quality"}
    assert baseline["environment"]["packages"]["trafilatura"]
    assert all("runtime" not in row for row in baseline["quality"])
    assert runner.compare_baseline(ROOT / "current-baseline.json", baseline["quality"]) == []
    changed = json.loads(json.dumps(baseline["quality"]))
    changed[0]["status"] = "changed"
    assert runner.compare_baseline(ROOT / "current-baseline.json", changed)


def test_offline_document_capability_is_visible() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    rows = {row["id"]: row for row in report["results"]}
    for case_id in ("docx", "pptx", "xlsx"):
        assert rows[case_id]["status"] == "skipped"
        assert "offline Docling" in rows[case_id]["quality"]["error"]
    for case_id in ("pdf-text", "pdf-table", "scanned-pdf"):
        assert rows[case_id]["quality"]["adapterEvidence"].get("documentConverter") != "docling"


def test_all_html_candidates_run_through_reader_and_have_explicit_decisions() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    revised = [
        row for row in report["results"]
        if row["adapter"] == runner.REVISED_HTML_ADAPTER
    ]
    html_cases = [
        case for case in manifest()["cases"]
        if case["mediaType"] == "text/html"
        and case.get("caseKind") != "acquisition-contract"
    ]
    assert len(revised) == len(html_cases)
    direct_html = [
        row["quality"].get("extractionMetrics", row["quality"])
        for row in revised
        if row["quality"].get("extractionMetrics", row["quality"])["path"]
        == "trafilatura"
    ]
    assert direct_html
    assert all(
        quality["adapterEvidence"].get("extractor")
        in {runner.REVISED_HTML_ADAPTER, "stdlib-fallback"}
        for quality in direct_html
    )
    decisions = {
        decision["candidate"]: decision for decision in report["candidateDecisions"]
    }
    expected_adapters = {runner.REVISED_HTML_ADAPTER, *runner.NODE_HTML_ADAPTERS}
    assert set(decisions) == expected_adapters
    expected_classes = {case["class"] for case in html_cases}
    assert all(
        decisions[adapter] == runner.candidate_decision(report["results"], adapter, expected_classes)
        for adapter in expected_adapters
    )
    assert all(not decision["adopt"] for decision in decisions.values())
    assert report["adoptedHtmlExtractor"] is None
    assert set(report["candidateSummary"]) == expected_adapters
    assert report["summary"] == {
        "extractionPassed": 9,
        "extractionFailed": 13,
        "acquisitionContractsPassed": 3,
        "acquisitionContractsFailed": 0,
        "skipped": 5,
        "qualityRegressions": [],
        "absoluteEligible": True,
    }
    assert all(
        summary["acquisitionContractsPassed"] == 0
        and summary["acquisitionContractsFailed"] == 0
        for summary in report["candidateSummary"].values()
    )
    assert all("runtime" not in row for row in report["results"] if row["adapter"] == "current")


def test_candidate_gate_rejects_incomplete_candidate_coverage() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    expected_classes = {
        case["class"] for case in manifest()["cases"]
        if case["mediaType"] == "text/html"
        and case.get("caseKind") != "acquisition-contract"
    }
    incomplete = [
        row for row in report["results"]
        if row["adapter"] != "defuddle" or row["class"] in {"cookie-wall", "challenge-captcha"}
    ]
    decision = runner.candidate_decision(incomplete, "defuddle", expected_classes)
    assert decision["adopt"] is False
    assert set(decision["missingCases"]) == expected_classes - {"cookie-wall", "challenge-captcha"}
    assert "candidate cases are missing" in decision["failures"]


def test_optional_adapters_are_skipped_and_report_is_bounded() -> None:
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    skipped = [row for row in report["results"] if row["adapter"] in runner.OPTIONAL_ENV]
    assert {row["adapter"] for row in skipped} == set(runner.OPTIONAL_ENV)
    assert all(row["status"] == "skipped" for row in skipped)
    assert (ROOT / "reports/current-run.json").stat().st_size <= manifest()["limits"]["reportBytes"]


def test_quality_snapshot_and_command_exit_semantics() -> None:
    baseline = json.loads((ROOT / "current-baseline.json").read_text())
    report = json.loads((ROOT / "reports/current-run.json").read_text())
    assert runner.stable_quality(report["results"]) == baseline["quality"]
    assert runner.compare_baseline(ROOT / "current-baseline.json", runner.stable_quality(report["results"])) == []
    assert report["summary"]["absoluteEligible"] is True
    assert report["absoluteEligibility"]["eligible"] is True
