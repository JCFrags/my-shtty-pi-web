#!/usr/bin/env python3
"""Run the bounded WebX extraction corpus without network access."""
from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import importlib
import importlib.metadata
import json
import os
import re
import resource
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# Model libraries must not fetch assets during import or conversion.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("DOCLING_SERVE_ENABLE_REMOTE_SERVICES", "false")
os.environ.setdefault("MODELSCOPE_OFFLINE", "1")

ROOT = Path(__file__).resolve().parent
BROWSER = ROOT.parents[1]
sys.path.insert(0, str(BROWSER / "services/reader/src"))
from pi_web_reader import pipeline  # noqa: E402


class LimitError(RuntimeError):
    """A benchmark resource ceiling was crossed."""


@dataclass
class Extracted:
    content: str
    path: str
    metadata: dict[str, Any]


@dataclass
class MonitoredResult:
    value: dict[str, Any] | None
    error: str | None
    wall_ms: float
    peak_rss: int
    disk_high_water: int
    process_high_water: int


# Values are reviewed module names, not shell commands. The repository has no candidate now.
OPTIONAL_ADAPTERS: dict[str, str] = {}
OPTIONAL_ENV = {
    "secondary-html": "WEBX_BENCH_HTML_ADAPTER",
    "alternate-pdf": "WEBX_BENCH_PDF_ADAPTER",
}

# This fixed gate is independent of the reviewed baseline. A baseline rewrite cannot
# make an ineligible extraction run eligible.
ABSOLUTE_QUALITY_POLICY = {
    "representativeClasses": (
        "news-article", "blog", "product", "github-repository", "hacker-news-like",
        "reddit-forum-like", "static-html", "javascript-shell", "json-api", "rss",
        "atom", "plain-text", "negotiated-markdown", "pdf-text", "pdf-table",
    ),
    "minimumPassedCases": 7,
    "requireAllMarkers": True,
}
EXPECTED_ANNOTATIONS = {
    "expectedOutcome", "expectedPath", "requiredMarkers", "forbiddenMarkers",
    "structure", "allowedLoss", "acquisitionExpected", "caseKind",
}


def resolve_optional_adapter(configured: str | None) -> str | None:
    """Resolve only a reviewed in-repository module name."""
    return OPTIONAL_ADAPTERS.get(configured or "")


def offline_audit(event: str, _args: tuple[Any, ...]) -> None:
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo"}:
        raise RuntimeError("network access is disabled for the offline corpus")


sys.addaudithook(offline_audit)


def directory_bytes(path: Path) -> int:
    total = 0
    try:
        paths = list(path.rglob("*"))
    except FileNotFoundError:
        return 0
    for item in paths:
        try:
            if item.is_file():
                total += item.stat().st_size
        except FileNotFoundError:
            pass
    return total


def descendants(root_pid: int) -> set[int]:
    """Return the process tree on Linux, or only the root on other systems."""
    if not Path("/proc").exists():
        return {root_pid}
    seen = {root_pid}
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        task = Path(f"/proc/{pid}/task/{pid}/children")
        try:
            children = [int(value) for value in task.read_text().split()]
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            children = []
        for child in children:
            if child not in seen:
                seen.add(child)
                pending.append(child)
    return seen


def process_rss(pids: set[int]) -> int:
    total = 0
    for pid in pids:
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    total += int(line.split()[1]) * 1024
                    break
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            pass
    return total


def kill_group(process: subprocess.Popen[Any]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()


def child_limits(limits: dict[str, int]) -> None:
    os.setsid()
    if hasattr(resource, "RLIMIT_AS"):
        resource.setrlimit(resource.RLIMIT_AS, (limits["memoryBytes"], limits["memoryBytes"]))
    if hasattr(resource, "RLIMIT_CPU"):
        cpu = max(1, int(limits["caseSeconds"]) + 1)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    if hasattr(resource, "RLIMIT_FSIZE"):
        size = min(limits["diskBytes"], limits["reportBytes"])
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
    if hasattr(resource, "RLIMIT_CORE"):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run_isolated(job: dict[str, Any], limits: dict[str, int], run_deadline: float) -> MonitoredResult:
    remaining = run_deadline - time.monotonic()
    if remaining <= 0:
        return MonitoredResult(None, "LimitError: total time limit exceeded", 0, 0, 0, 0)
    case_seconds = min(float(limits["caseSeconds"]), remaining)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="webx-extraction-case-") as raw_temp:
        temp = Path(raw_temp)
        job_path = temp / "job.json"
        result_path = temp / "result.json"
        job_path.write_text(json.dumps(job), encoding="utf-8")
        command = [sys.executable, str(Path(__file__).resolve()), "--worker", str(job_path), str(result_path)]
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            preexec_fn=lambda: child_limits(limits),
        )
        peak_rss = 0
        disk_high = directory_bytes(temp)
        process_high = 1
        violation: str | None = None
        while process.poll() is None:
            tree = descendants(process.pid)
            rss = process_rss(tree)
            disk = directory_bytes(temp)
            peak_rss = max(peak_rss, rss)
            disk_high = max(disk_high, disk)
            process_high = max(process_high, len(tree))
            if rss > limits["memoryBytes"]:
                violation = "memory limit exceeded"
            elif len(tree) > limits["processes"]:
                violation = "process limit exceeded"
            elif disk > limits["diskBytes"]:
                violation = "temporary disk limit exceeded"
            elif time.monotonic() - started > case_seconds:
                violation = "case time limit exceeded" if time.monotonic() < run_deadline else "total time limit exceeded"
            if violation:
                kill_group(process)
                break
            time.sleep(0.005)
        tree = descendants(process.pid)
        peak_rss = max(peak_rss, process_rss(tree))
        disk_high = max(disk_high, directory_bytes(temp))
        process_high = max(process_high, len(tree))
        elapsed = round((time.monotonic() - started) * 1000, 3)
        if violation:
            return MonitoredResult(None, f"LimitError: {violation}", elapsed, peak_rss, disk_high, process_high)
        if process.returncode != 0:
            if process.returncode == -getattr(signal, "SIGXFSZ", 25):
                error = "LimitError: temporary disk or worker result file limit exceeded"
            elif process.returncode in {-signal.SIGKILL, -getattr(signal, "SIGSEGV", 11)} and peak_rss >= limits["memoryBytes"] * 9 // 10:
                error = "LimitError: memory limit exceeded"
            else:
                error = f"WorkerError: child exited {process.returncode}"
            return MonitoredResult(None, error, elapsed, peak_rss, disk_high, process_high)
        try:
            if result_path.stat().st_size > limits["reportBytes"]:
                raise LimitError("worker result limit exceeded")
            value = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, LimitError) as exc:
            return MonitoredResult(None, f"{type(exc).__name__}: {exc}", elapsed, peak_rss, disk_high, process_high)
        if value.get("error"):
            error = str(value["error"])[:500]
            if error.startswith("MemoryError"):
                error = "LimitError: memory limit exceeded"
            elif "Errno 27" in error:
                error = "LimitError: temporary disk or worker result file limit exceeded"
            return MonitoredResult(None, error, elapsed, peak_rss, disk_high, process_high)
        return MonitoredResult(value, None, elapsed, peak_rss, disk_high, process_high)


class FixtureAcquisition:
    """Supply deterministic HTTP responses and record observed acquisition facts."""

    def __init__(self, case: dict[str, Any], content: bytes) -> None:
        self.case = case
        self.content = content
        self.requested: list[str] = []
        self.raw_bytes = len(content)
        self.decoded_bytes = len(content)
        self.content_encoding = "identity"

    def handler(self, request: Any):
        httpx = pipeline.httpx
        assert httpx is not None
        url = str(request.url)
        self.requested.append(url)
        acquisition = self.case.get("acquisition", {})
        redirects = acquisition.get("redirects", [])
        if redirects:
            chain = [f"https://corpus.example/{self.case['file']}", *redirects]
            if url in chain[:-1]:
                return httpx.Response(302, headers={"location": chain[chain.index(url) + 1]}, request=request)
            if url != chain[-1]:
                return httpx.Response(404, request=request)
        primary = redirects[-1] if redirects else f"https://corpus.example/{self.case['file']}"
        if url == primary:
            body = self.content
            headers = {"content-type": self.case["mediaType"]}
            if charset := acquisition.get("charset"):
                headers["content-type"] += f"; charset={charset}"
            if acquisition.get("compression") == "gzip":
                body = gzip.compress(self.content, mtime=0)
                headers["content-encoding"] = "gzip"
                headers["content-length"] = str(len(body))
                self.raw_bytes = len(body)
                self.content_encoding = "gzip"
            self.decoded_bytes = len(self.content)
            return httpx.Response(200, headers=headers, content=body, request=request)
        fallback = self.case.get("fallbackFile")
        if fallback and url == primary + ".md":
            data = (ROOT / "fixtures" / fallback).read_bytes()
            if hashlib.sha256(data).hexdigest() != self.case["fallbackSha256"]:
                raise RuntimeError("fallback fixture hash mismatch")
            return httpx.Response(200, headers={"content-type": "text/markdown"}, content=data, request=request)
        return httpx.Response(404, request=request)

    def evidence(self, final_url: str) -> dict[str, Any]:
        return {
            "requestedUrls": self.requested,
            "redirectChain": self.requested[: self.requested.index(final_url) + 1] if final_url in self.requested else self.requested,
            "finalUrl": final_url,
            "contentEncoding": self.content_encoding,
            "rawBytes": self.raw_bytes,
            "decodedBytes": self.decoded_bytes,
        }


async def production_read(case: dict[str, Any], content: bytes) -> tuple[Extracted, dict[str, Any]]:
    httpx = pipeline.httpx
    if httpx is None:
        raise RuntimeError("httpx is not installed")
    acquisition = FixtureAcquisition(case, content)
    real_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any):
        # Acquisition passes its transport. The Docling client does not. A fixed 503
        # models an unavailable local worker and exercises the production PDF fallback.
        if "transport" not in kwargs:
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(503, request=request, json={"detail": "offline benchmark has no Docling service"})
            )
        return real_client(*args, **kwargs)

    pipeline.httpx.AsyncClient = client_factory
    try:
        reader = pipeline.ReaderPipeline(
            timeout_seconds=30,
            max_download_bytes=1_000_000,
            max_raw_bytes=1_000_000,
            max_redirects=5,
            resolver=lambda _host, _port: asyncio.sleep(0, result=["93.184.216.34"]),
            transport_factory=lambda _pins: httpx.MockTransport(acquisition.handler),
        )
        request = pipeline.ReadRequest(
            url=f"https://corpus.example/{case['file']}",
            max_chars=1_000_000,
            fields=tuple(case.get("fields", [])),
        )
        result = await reader.read(request)
    finally:
        pipeline.httpx.AsyncClient = real_client
    return Extracted(result.content, result.source, result.metadata), acquisition.evidence(result.url)


def validate_input_size(data: bytes, limit: int) -> None:
    if len(data) > limit:
        raise LimitError(f"input exceeds {limit} bytes")


def validate_output_size(content: str, limit: int) -> None:
    if len(content.encode("utf-8")) > limit:
        raise LimitError(f"output exceeds {limit} bytes")


def execution_case(case: dict[str, Any]) -> dict[str, Any]:
    """Return adapter input without expected quality annotations."""
    return {key: value for key, value in case.items() if key not in EXPECTED_ANNOTATIONS}


def worker_case(job: dict[str, Any]) -> dict[str, Any]:
    case = execution_case(job["case"])
    fixture = ROOT / "fixtures" / case["file"]
    data = fixture.read_bytes()
    if hashlib.sha256(data).hexdigest() != case["sha256"]:
        raise RuntimeError(f"fixture hash mismatch: {case['id']}")
    validate_input_size(data, job["limits"]["inputBytes"])
    adapter = job.get("adapter", "current")
    if adapter == "current":
        extracted, acquisition = asyncio.run(production_read(case, data))
    else:
        module_name = resolve_optional_adapter(job.get("adapterKey"))
        if module_name is None:
            raise RuntimeError("optional adapter is not in the reviewed allowlist")
        value = importlib.import_module(module_name).extract(execution_case(case), fixture)
        extracted = Extracted(str(value["content"]), str(value["path"]), dict(value.get("metadata", {})))
        acquisition = {}
    validate_output_size(extracted.content, job["limits"]["outputBytes"])
    return {"extracted": asdict(extracted), "acquisition": acquisition}


def worker_probe(job: dict[str, Any]) -> dict[str, Any]:
    action = job["action"]
    amount = int(job.get("amount", 0))
    if action == "sleep":
        time.sleep(float(job["seconds"]))
    elif action == "memory":
        value = bytearray(amount)
        for index in range(0, len(value), 4096):
            value[index] = 1
        time.sleep(1)
    elif action == "process":
        children = [subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)"]) for _ in range(amount)]
        time.sleep(2)
        for child in children:
            child.wait()
    elif action == "disk":
        with (Path(job["directory"]) / "probe.bin").open("wb") as handle:
            handle.write(b"x" * amount)
            handle.flush()
            os.fsync(handle.fileno())
        time.sleep(1)
    elif action == "output":
        return {"payload": "x" * amount}
    return {"ok": True}


def worker_main(job_path: Path, result_path: Path) -> int:
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        if job.get("mode") == "probe":
            if job.get("action") == "disk":
                job["directory"] = str(result_path.parent)
            value = worker_probe(job)
        else:
            value = worker_case(job)
        result = {"value": value}
    except Exception as exc:
        result = {"error": f"{type(exc).__name__}: {exc}"[:500]}
    result_path.write_text(json.dumps(result), encoding="utf-8")
    return 0


def count_structure(text: str, kind: str) -> int:
    if kind == "headings":
        return len(re.findall(r"(?m)^#{1,6}\s+\S", text))
    if kind == "codeBlocks":
        return len(re.findall(r"```", text)) // 2
    if kind == "tables":
        lines = text.splitlines()
        return sum(1 for line in lines if re.match(r"^\s*\|?\s*:?-+", line) and "|" in line)
    if kind == "links":
        return len(re.findall(r"\[[^]]+\]\([^)]+\)|https?://", text))
    return 0


def structured_rows(extracted: Extracted | None) -> int:
    if extracted is None:
        return 0
    returned = extracted.metadata.get("returnedItems")
    if isinstance(returned, int):
        return returned
    tables = extracted.metadata.get("tables")
    if isinstance(tables, list) and tables:
        return int(tables[0].get("rows") or 0)
    return 0


def extraction_quality(case: dict[str, Any], extracted: Extracted | None, error: str | None) -> dict[str, Any]:
    text = extracted.content if extracted else ""
    path = extracted.path if extracted else "error"
    expected = case["expectedOutcome"]
    if expected == "empty-or-error":
        outcome_ok = extracted is None or not text.strip()
    elif expected == "limit-error":
        outcome_ok = error is not None and "LimitError" in error
    elif expected == "render-required":
        outcome_ok = extracted is not None and bool(extracted.metadata.get("renderRequired"))
    else:
        outcome_ok = extracted is not None and path == case["expectedPath"]
    required = {marker: marker in text for marker in case["requiredMarkers"]}
    forbidden = {marker: marker in text for marker in case["forbiddenMarkers"]}
    measured = {
        key: structured_rows(extracted) if key == "structuredRows" else count_structure(text, key)
        for key in case["structure"]
    }
    structure_ok = {key: measured[key] >= value for key, value in case["structure"].items()}
    checks_ok = all(required.values()) and not any(forbidden.values()) and all(structure_ok.values())
    if expected in {"limit-error", "empty-or-error"} and extracted is None:
        checks_ok = True
    return {
        "outcome": "pass" if outcome_ok and checks_ok else "fail",
        "path": path,
        "requiredMarkerRetention": {"retained": sum(required.values()), "total": len(required), "markers": required},
        "forbiddenBoilerplateLeakage": {"leaked": sum(forbidden.values()), "total": len(forbidden), "markers": forbidden},
        "preservation": {key: {"observed": measured[key], "required": case["structure"][key], "pass": structure_ok[key]} for key in ("headings", "codeBlocks", "tables", "links")},
        "structuredRowCompleteness": {"observed": measured["structuredRows"], "required": case["structure"]["structuredRows"], "pass": structure_ok["structuredRows"]},
        "adapterEvidence": ({key: extracted.metadata[key] for key in ("extractor", "documentConverter", "renderRequired", "returnedItems", "totalItems") if key in extracted.metadata} if extracted else {}),
        "outputCharacters": len(text),
        "outputBytes": len(text.encode("utf-8")),
        "error": error,
    }


def acquisition_quality(case: dict[str, Any], observed: dict[str, Any], extraction: dict[str, Any]) -> dict[str, Any]:
    expected = case["acquisitionExpected"]
    checks = {key: observed.get(key) == value for key, value in expected.items()}
    marker_retention = extraction["requiredMarkerRetention"]
    reader_observed = {
        "outputBytes": extraction["outputBytes"],
        "requiredMarkerRetention": marker_retention,
    }
    acquisition = case.get("acquisition", {})
    if acquisition.get("charset"):
        checks["readerDecodedRequiredMarkers"] = (
            marker_retention["total"] > 0
            and marker_retention["retained"] == marker_retention["total"]
        )
    if acquisition.get("compression") == "gzip":
        checks["readerDecompressedRequiredMarkers"] = (
            marker_retention["total"] > 0
            and marker_retention["retained"] == marker_retention["total"]
        )
    return {
        "outcome": "pass" if all(checks.values()) else "fail",
        "contract": "acquisition",
        "observed": observed,
        "readerObserved": reader_observed,
        "checks": checks,
        "extractionMetrics": extraction,
    }


def environment() -> dict[str, Any]:
    packages = {}
    for name in ("trafilatura", "docling", "httpx"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = "missing"
    return {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "packages": packages,
        "pdftotext": tool_version("pdftotext", "-v"),
        "documentService": "not started; normal PDF uses local pdftotext and Office is skipped",
    }


def tool_version(command: str, flag: str) -> str:
    try:
        result = subprocess.run([command, flag], capture_output=True, text=True, timeout=3, check=False)
        return (result.stdout or result.stderr).splitlines()[0][:160]
    except (OSError, subprocess.SubprocessError, IndexError):
        return "missing"


def stable_quality(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = ("id", "adapter", "status", "quality")
    return [{key: item[key] for key in keys} for item in results if item["adapter"] == "current"]


def compare_baseline(path: Path, quality_rows: list[dict[str, Any]]) -> list[str]:
    if not path.exists():
        return ["baseline is missing"]
    old = json.loads(path.read_text(encoding="utf-8")).get("quality", [])
    return [] if old == quality_rows else ["deterministic quality differs from the reviewed baseline"]


def absolute_eligibility(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply fixed marker and representative-class requirements to production output."""
    current = {row["class"]: row for row in results if row["adapter"] == "current"}
    classes = ABSOLUTE_QUALITY_POLICY["representativeClasses"]
    missing = [name for name in classes if name not in current]
    marker_failures = []
    passed = 0
    for name in classes:
        row = current.get(name)
        if row is None:
            continue
        if row["status"] == "passed":
            passed += 1
        retention = row["quality"].get("requiredMarkerRetention", {})
        if retention.get("retained") != retention.get("total") or not retention.get("total"):
            marker_failures.append(name)
    failures = []
    if missing:
        failures.append("representative classes are missing")
    if ABSOLUTE_QUALITY_POLICY["requireAllMarkers"] and marker_failures:
        failures.append("required markers were lost")
    if passed < ABSOLUTE_QUALITY_POLICY["minimumPassedCases"]:
        failures.append("too few representative cases passed")
    return {
        "eligible": not failures,
        "representativeClasses": list(classes),
        "minimumPassedCases": ABSOLUTE_QUALITY_POLICY["minimumPassedCases"],
        "passedCases": passed,
        "requireAllMarkers": ABSOLUTE_QUALITY_POLICY["requireAllMarkers"],
        "markerFailures": marker_failures,
        "missingClasses": missing,
        "failures": failures,
    }


def encode_report(report: dict[str, Any], limit: int) -> bytes:
    encoded = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > limit:
        raise LimitError("report size limit exceeded")
    return encoded


def run_case(
    case: dict[str, Any],
    limits: dict[str, int],
    deadline: float,
    adapter: str = "current",
    adapter_key: str | None = None,
) -> dict[str, Any]:
    fixture = ROOT / "fixtures" / case["file"]
    data = fixture.read_bytes()
    if hashlib.sha256(data).hexdigest() != case["sha256"]:
        raise RuntimeError(f"fixture hash mismatch: {case['id']}")
    if len(data) > limits["inputBytes"]:
        monitored = MonitoredResult(None, f"LimitError: input exceeds {limits['inputBytes']} bytes", 0, 0, 0, 0)
    elif case["mediaType"] in pipeline.DOCUMENT_TYPES and case["mediaType"] != "application/pdf":
        quality = extraction_quality(case, None, "EnvironmentSkip: offline Docling service and declared model assets are unavailable")
        return {"id": case["id"], "class": case["class"], "adapter": adapter, "status": "skipped", "quality": quality, "runtime": {"wallMilliseconds": 0, "peakRssBytes": 0, "temporaryDiskHighWaterBytes": 0, "descendantProcessHighWater": 0}}
    else:
        monitored = run_isolated(
            {"case": execution_case(case), "limits": limits, "adapter": adapter, "adapterKey": adapter_key},
            limits,
            deadline,
        )
    payload = monitored.value.get("value") if monitored.value else None
    extracted = Extracted(**payload["extracted"]) if payload else None
    observed = payload.get("acquisition", {}) if payload else {}
    quality = extraction_quality(case, extracted, monitored.error)
    if case.get("caseKind") == "acquisition-contract":
        quality = acquisition_quality(case, observed, quality)
    if case.get("caseKind") == "acquisition-contract":
        status = "contract-passed" if quality["outcome"] == "pass" else "contract-failed"
    else:
        status = "passed" if quality["outcome"] == "pass" else "failed"
    return {
        "id": case["id"], "class": case["class"], "adapter": adapter, "status": status, "quality": quality,
        "runtime": {"wallMilliseconds": monitored.wall_ms, "peakRssBytes": monitored.peak_rss, "temporaryDiskHighWaterBytes": monitored.disk_high_water, "descendantProcessHighWater": monitored.process_high_water},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "reports/current-run.json")
    parser.add_argument("--baseline", type=Path, default=ROOT / "current-baseline.json")
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--no-compare", action="store_true")
    parser.add_argument("--worker", nargs=2, metavar=("JOB", "RESULT"))
    args = parser.parse_args()
    if args.worker:
        return worker_main(Path(args.worker[0]), Path(args.worker[1]))
    manifest_bytes = (ROOT / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    limits = manifest["limits"]
    if len(manifest["cases"]) > limits["cases"]:
        raise LimitError("manifest case limit exceeded")
    deadline = time.monotonic() + limits["totalSeconds"]
    run_environment = environment()
    results = [run_case(case, limits, deadline) for case in manifest["cases"]]
    for adapter, variable in OPTIONAL_ENV.items():
        configured = os.getenv(variable)
        if not configured or resolve_optional_adapter(configured) is None:
            reason = "adapter module is not configured" if not configured else "adapter module is not in the reviewed allowlist"
            results.append({"id": f"optional:{adapter}", "class": "optional-adapter", "adapter": adapter, "status": "skipped", "quality": {"reason": reason}})
            continue
        selected = [case for case in manifest["cases"] if (adapter == "secondary-html" and case["mediaType"] == "text/html") or (adapter == "alternate-pdf" and case["mediaType"] == "application/pdf")]
        results.extend(run_case(case, limits, deadline, adapter, configured) for case in selected)
    if time.monotonic() > deadline:
        raise LimitError("total time limit exceeded")
    quality_rows = stable_quality(results)
    regressions = [] if args.no_compare or args.write_baseline else compare_baseline(args.baseline, quality_rows)
    eligibility = absolute_eligibility(results)
    report = {
        "schemaVersion": 2,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "environment": run_environment,
        "limits": limits,
        "summary": {
            "extractionPassed": sum(row["status"] == "passed" for row in results),
            "extractionFailed": sum(row["status"] == "failed" for row in results),
            "acquisitionContractsPassed": sum(row["status"] == "contract-passed" for row in results),
            "acquisitionContractsFailed": sum(row["status"] == "contract-failed" for row in results),
            "skipped": sum(row["status"] == "skipped" for row in results),
            "qualityRegressions": regressions,
            "absoluteEligible": eligibility["eligible"],
        },
        "absoluteEligibility": eligibility,
        "results": results,
    }
    encoded = encode_report(report, limits["reportBytes"])
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(encoded)
    if args.write_baseline:
        args.baseline.write_text(json.dumps({"schemaVersion": 2, "environment": report["environment"], "quality": quality_rows}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Extraction corpus: {report['summary']['extractionPassed']} extraction passed, "
        f"{report['summary']['extractionFailed']} extraction failed, "
        f"{report['summary']['acquisitionContractsPassed']} acquisition contracts passed, "
        f"{report['summary']['skipped']} skipped"
    )
    if regressions:
        print("Baseline comparison: " + "; ".join(regressions), file=sys.stderr)
    if not eligibility["eligible"]:
        print("Absolute quality gate: " + "; ".join(eligibility["failures"]), file=sys.stderr)
    return 1 if regressions or not eligibility["eligible"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
