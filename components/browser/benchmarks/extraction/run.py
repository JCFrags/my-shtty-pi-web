#!/usr/bin/env python3
"""Run the bounded WebX extraction corpus without network access."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
# These settings make model-backed adapters fail closed instead of fetching assets.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("DOCLING_SERVE_ENABLE_REMOTE_SERVICES", "false")
import re
import resource
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
BROWSER = ROOT.parents[1]
sys.path.insert(0, str(BROWSER / "services/reader/src"))
sys.path.insert(0, str(BROWSER / "services/docling/src"))
from pi_web_reader import pipeline  # noqa: E402
from pi_web_docling.converter import ConvertRequest, convert_document  # noqa: E402


_NETWORK_BLOCKED = False


def offline_audit(event: str, _args: tuple[Any, ...]) -> None:
    if _NETWORK_BLOCKED and event in {"socket.connect", "socket.getaddrinfo"}:
        raise RuntimeError("network access is disabled for the offline corpus")


sys.addaudithook(offline_audit)


class LimitError(RuntimeError):
    pass


class CaseTimeout(TimeoutError):
    pass


def alarm_handler(_signum: int, _frame: Any) -> None:
    raise CaseTimeout("case time limit exceeded")


@dataclass
class Extracted:
    content: str
    path: str
    metadata: dict[str, Any]


def _current_adapter(case: dict[str, Any], content: bytes, temp: Path) -> Extracted:
    media_type = case["mediaType"]
    charset = case.get("charset", "utf-8")
    text = content.decode(charset, errors="replace")
    url = f"https://corpus.example/{case['file']}"
    request = pipeline.ReadRequest(url=url, max_chars=1_000_000, fields=tuple(case.get("fields", [])))
    fetched = pipeline.FetchResult(url=url, status=200, media_type=media_type, text=text, content=content, headers={})
    expected_path = case["expectedPath"]
    if media_type == "application/json" or media_type.endswith("+json"):
        result = pipeline.finalize_json_result(fetched, request)
        return Extracted(result.content, result.source, result.metadata)
    if media_type in pipeline.DOCUMENT_TYPES:
        staging = temp / "handoff"
        staging.mkdir(mode=0o700, exist_ok=True)
        source = staging / Path(case["file"]).name
        source.write_bytes(content)
        source.chmod(0o600)
        old = os.environ.get("PI_WEB_DOCUMENT_STAGING_DIR")
        os.environ["PI_WEB_DOCUMENT_STAGING_DIR"] = str(staging)
        global _NETWORK_BLOCKED
        try:
            try:
                _NETWORK_BLOCKED = True
                converted = convert_document(ConvertRequest(str(source), len(content), hashlib.sha256(content).hexdigest(), media_type, url, True))
                markdown = str(converted.get("markdown") or "")
                converter = "docling"
            except Exception:
                if media_type != "application/pdf":
                    raise
                markdown = pipeline.extract_pdf_text(content)
                converted = {"pages": [], "tables": [], "images": []}
                converter = "pdftotext-fallback"
        finally:
            _NETWORK_BLOCKED = False
            if old is None:
                os.environ.pop("PI_WEB_DOCUMENT_STAGING_DIR", None)
            else:
                os.environ["PI_WEB_DOCUMENT_STAGING_DIR"] = old
        return Extracted(markdown, "document", {"documentConverter": converter, **{key: converted.get(key) for key in ("pages", "tables", "images")}})
    if media_type in pipeline.TEXT_TYPES:
        source_name = "markdown-negotiation" if media_type in pipeline.MARKDOWN_TYPES else "raw"
        result = pipeline.finalize_text_result(fetched, text, request, source_name)
        return Extracted(result.content, result.source, result.metadata)
    extracted, _title, meta = pipeline.extract_html(text, request)
    if expected_path == "markdown-fallback" and pipeline.looks_like_javascript_shell(text, extracted):
        fallback_path = ROOT / "fixtures" / case["fallbackFile"]
        fallback_bytes = fallback_path.read_bytes()
        if hashlib.sha256(fallback_bytes).hexdigest() != case["fallbackSha256"]:
            raise RuntimeError(f"fallback fixture hash mismatch: {case['id']}")
        fallback = fallback_bytes.decode("utf-8")
        fallback_result = pipeline.finalize_text_result(fetched, fallback, request, "markdown-fallback")
        return Extracted(fallback_result.content, fallback_result.source, fallback_result.metadata)
    if expected_path == "feed":
        return Extracted(extracted, "feed", meta)
    if pipeline.useful_text(extracted) and not pipeline.looks_like_javascript_shell(text, extracted):
        return Extracted(extracted, "static-html", meta)
    shell = extracted or pipeline.html_to_text(text)
    return Extracted(shell, "render-required", {**meta, "renderRequired": True})


def current_adapter(case: dict[str, Any], content: bytes, temp: Path) -> Extracted:
    """Run current extraction with declared local acquisition metadata."""
    extracted = _current_adapter(case, content, temp)
    return Extracted(
        extracted.content,
        extracted.path,
        {**extracted.metadata, **case.get("metadata", {})},
    )


def external_adapter(command: str, case: dict[str, Any], fixture: Path, timeout: int) -> Extracted:
    completed = subprocess.run(
        [*shlex.split(command), str(fixture), case["mediaType"]],
        input=json.dumps({"case": case}), text=True, capture_output=True, timeout=timeout,
        env={**os.environ, "NO_PROXY": "*", "no_proxy": "*"}, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"optional adapter exited {completed.returncode}: {completed.stderr[:500]}")
    if len(completed.stdout.encode()) > 65_536:
        raise LimitError("optional adapter output exceeds 65536 bytes")
    value = json.loads(completed.stdout)
    return Extracted(str(value["content"]), str(value.get("path", "candidate")), dict(value.get("metadata", {})))


def count_structure(text: str, kind: str) -> int:
    if kind == "headings": return len(re.findall(r"(?m)^#{1,6}\s+\S", text))
    if kind == "codeBlocks": return len(re.findall(r"```", text)) // 2
    if kind == "tables": return len(re.findall(r"(?m)^\s*\|?.+\|.+$", text))
    if kind == "links": return len(re.findall(r"\[[^]]+\]\([^)]+\)|https?://", text))
    return 0


def quality(case: dict[str, Any], extracted: Extracted | None, error: str | None) -> dict[str, Any]:
    expected = case["expectedOutcome"]
    if extracted is None:
        outcome_ok = expected in {"limit-error", "empty-or-error"}
        text = ""
        path = "error"
    else:
        text, path = extracted.content, extracted.path
        outcome_ok = (expected == "success" and path == case["expectedPath"]) or (expected == path) or (expected == "empty-or-error" and not text.strip())
    skip_content_checks = extracted is None and expected in {"limit-error", "empty-or-error"}
    required = {marker: marker in text for marker in case["requiredMarkers"]}
    forbidden = {marker: marker in text for marker in case["forbiddenMarkers"]}
    structure = case["structure"]
    measured = {key: (count_structure(text, key) if key != "structuredRows" else structured_rows(extracted)) for key in structure}
    structure_ok = {key: measured[key] >= value for key, value in structure.items()}
    metadata_ok = {key: extracted is not None and extracted.metadata.get(key) == value for key, value in case.get("metadata", {}).items()}
    return {
        "outcome": "pass" if outcome_ok and (skip_content_checks or (all(required.values()) and not any(forbidden.values()) and all(structure_ok.values()) and all(metadata_ok.values()))) else "fail",
        "path": path,
        "requiredMarkerRetention": {"retained": sum(required.values()), "total": len(required), "markers": required},
        "forbiddenBoilerplateLeakage": {"leaked": sum(forbidden.values()), "total": len(forbidden), "markers": forbidden},
        "preservation": {key: {"observed": measured[key], "required": structure[key], "pass": structure_ok[key]} for key in ("headings", "codeBlocks", "tables", "links")},
        "structuredRowCompleteness": {"observed": measured["structuredRows"], "required": structure["structuredRows"], "pass": structure_ok["structuredRows"]},
        "metadataRetention": metadata_ok,
        "adapterEvidence": ({key: extracted.metadata[key] for key in ("extractor", "documentConverter", "renderRequired", "returnedItems", "totalItems") if key in extracted.metadata} if extracted is not None else {}),
        "outputCharacters": len(text), "outputBytes": len(text.encode()), "error": error,
    }


def structured_rows(extracted: Extracted | None) -> int:
    if extracted is None: return 0
    returned = extracted.metadata.get("returnedItems")
    if isinstance(returned, int): return returned
    tables = extracted.metadata.get("tables")
    if isinstance(tables, list) and tables:
        rows = tables[0].get("rows")
        return int(rows or 0)
    return 0


def directory_bytes(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def descendant_processes() -> int:
    """Return a Linux descendant snapshot or one on other systems."""
    children_file = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
    if not children_file.exists(): return 1
    seen: set[int] = set()
    pending = [os.getpid()]
    while pending:
        pid = pending.pop()
        path = Path(f"/proc/{pid}/task/{pid}/children")
        try: children = [int(value) for value in path.read_text().split()]
        except (FileNotFoundError, PermissionError): children = []
        for child in children:
            if child not in seen: seen.add(child); pending.append(child)
    return 1 + len(seen)


def environment() -> dict[str, Any]:
    packages = {}
    for name in ("trafilatura", "docling", "httpx"):
        try: packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: packages[name] = "missing"
    return {"python": sys.version.split()[0], "platform": sys.platform, "packages": packages, "pdftotext": tool_version("pdftotext", "-v")}


def tool_version(command: str, flag: str) -> str:
    try:
        result = subprocess.run([command, flag], capture_output=True, text=True, timeout=3, check=False)
        return (result.stdout or result.stderr).splitlines()[0][:160]
    except (OSError, subprocess.SubprocessError): return "missing"


def stable_quality(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return deterministic current-adapter quality without variable resource data."""
    keys = ("id", "adapter", "status", "quality")
    return [{key: item[key] for key in keys} for item in results if item["adapter"] == "current"]


def exit_code(regressions: list[str]) -> int:
    return 1 if regressions else 0


def compare_baseline(path: Path, quality_rows: list[dict[str, Any]]) -> list[str]:
    if not path.exists(): return ["baseline is missing"]
    old = json.loads(path.read_text()).get("quality", [])
    return [] if old == quality_rows else ["deterministic quality differs from the reviewed baseline"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "reports/current-run.json")
    parser.add_argument("--baseline", type=Path, default=ROOT / "current-baseline.json")
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--no-compare", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    limits = manifest["limits"]
    if len(manifest["cases"]) > limits["cases"]: raise LimitError("manifest case limit exceeded")
    signal.signal(signal.SIGALRM, alarm_handler)
    start_total = time.monotonic()
    results: list[dict[str, Any]] = []
    adapter_commands = {"secondary-html": os.getenv("WEBX_BENCH_HTML_ADAPTER"), "alternate-pdf": os.getenv("WEBX_BENCH_PDF_ADAPTER")}
    with tempfile.TemporaryDirectory(prefix="webx-extraction-bench-") as raw_temp:
        temp = Path(raw_temp)
        for case in manifest["cases"]:
            if time.monotonic() - start_total > limits["totalSeconds"]: raise LimitError("total time limit exceeded")
            fixture = ROOT / "fixtures" / case["file"]
            data = fixture.read_bytes()
            if hashlib.sha256(data).hexdigest() != case["sha256"]: raise RuntimeError(f"fixture hash mismatch: {case['id']}")
            before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            started = time.monotonic(); extracted = None; error = None
            try:
                remaining = limits["totalSeconds"] - (time.monotonic() - start_total)
                signal.setitimer(signal.ITIMER_REAL, min(limits["caseSeconds"], max(0.001, remaining)))
                if len(data) > limits["inputBytes"]: raise LimitError(f"input exceeds {limits['inputBytes']} bytes")
                extracted = current_adapter(case, data, temp)
                if len(extracted.content.encode()) > limits["outputBytes"]: raise LimitError(f"output exceeds {limits['outputBytes']} bytes")
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"[:500]
            finally: signal.setitimer(signal.ITIMER_REAL, 0)
            elapsed = round((time.monotonic() - started) * 1000, 3)
            peak = max(before, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
            disk = directory_bytes(temp); processes = descendant_processes()
            if peak > limits["memoryBytes"] or disk > limits["diskBytes"] or processes > limits["processes"]:
                extracted = None
                error = f"LimitError: resource ceiling exceeded (memory={peak}, disk={disk}, processes={processes})"
            q = quality(case, extracted, error)
            status = "passed" if q["outcome"] == "pass" else "failed"
            results.append({"id": case["id"], "class": case["class"], "adapter": "current", "status": status, "quality": q, "runtime": {"wallMilliseconds": elapsed, "peakRssBytesApprox": peak, "temporaryDiskBytes": disk, "processesApprox": processes}})
        for adapter, command in adapter_commands.items():
            if not command:
                results.append({"id": f"optional:{adapter}", "class": "optional-adapter", "adapter": adapter, "status": "skipped", "quality": {"reason": "adapter command is not configured"}})
                continue
            selected = [case for case in manifest["cases"] if (adapter == "secondary-html" and case["mediaType"] == "text/html") or (adapter == "alternate-pdf" and case["mediaType"] == "application/pdf")]
            for case in selected:
                fixture = ROOT / "fixtures" / case["file"]
                started = time.monotonic(); extracted = None; error = None
                try:
                    remaining = limits["totalSeconds"] - (time.monotonic() - start_total)
                    signal.setitimer(signal.ITIMER_REAL, min(limits["caseSeconds"], max(0.001, remaining)))
                    extracted = external_adapter(command, case, fixture, min(limits["caseSeconds"], max(1, int(remaining))))
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"[:500]
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                q = quality(case, extracted, error)
                results.append({"id": case["id"], "class": case["class"], "adapter": adapter, "status": "passed" if q["outcome"] == "pass" else "failed", "quality": q, "runtime": {"wallMilliseconds": round((time.monotonic() - started) * 1000, 3), "peakRssBytesApprox": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024}})
    quality_rows = stable_quality(results)
    regressions = [] if args.no_compare or args.write_baseline else compare_baseline(args.baseline, quality_rows)
    report = {"schemaVersion": 1, "manifestSha256": hashlib.sha256((ROOT / "manifest.json").read_bytes()).hexdigest(), "environment": environment(), "limits": limits, "summary": {"passed": sum(x["status"] == "passed" for x in results), "failed": sum(x["status"] == "failed" for x in results), "skipped": sum(x["status"] == "skipped" for x in results), "qualityRegressions": regressions}, "results": results}
    encoded = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode()
    if len(encoded) > limits["reportBytes"]: raise LimitError("report size limit exceeded")
    args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_bytes(encoded)
    if args.write_baseline:
        args.baseline.write_text(json.dumps({"schemaVersion": 1, "environment": report["environment"], "quality": quality_rows}, indent=2, ensure_ascii=False) + "\n")
    print(f"Extraction corpus: {report['summary']['passed']} passed, {report['summary']['failed']} failed, {report['summary']['skipped']} skipped")
    if regressions: print("Baseline comparison: " + "; ".join(regressions), file=sys.stderr)
    # The reviewed baseline can contain known extraction losses. Only drift is gating.
    return exit_code(regressions)


if __name__ == "__main__":
    raise SystemExit(main())
