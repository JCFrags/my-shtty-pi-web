# Offline extraction corpus

This corpus measures the current WebX reader with local synthetic fixtures. The current adapter calls `ReaderPipeline.read`. An injected HTTPX transport supplies deterministic responses. Expected annotations only assess the result. They never select a reader branch.

The process audit hook rejects DNS and socket connections. The runner also sets the Hugging Face, Transformers, ModelScope, and Docling offline flags. It does not use an undeclared model cache.

## Run the reviewed baseline

From the repository root, run:

```sh
pnpm benchmark:extraction
```

The command uses `uv --offline`. It writes `reports/current-run.json`. It returns zero when deterministic quality matches `current-baseline.json`. A reviewed loss can remain in the baseline. Drift or a missing baseline makes the command fail.

The offline benchmark does not start the Docling service. It does not declare or package the RapidOCR model assets. Office cases are visible environment skips for this reason. PDF cases exercise the exact production behavior when the Docling service is unavailable. Production then tries its local `pdftotext` fallback. The report does not claim cache-dependent Docling or OCR success.

## Acquisition contracts

Bad charset, redirect, and compressed response cases are acquisition contracts. The deterministic transport supplies bytes and HTTP headers. The reader observes decoding, redirect, and decompression behavior. The runner compares independent observed values with `acquisitionExpected`.

These rows use `contract-passed` or `contract-failed`. They are not extraction successes. Their extraction marker and structure measurements remain nested under `extractionMetrics` for review.

## Resource ceilings

The manifest sets these ceilings:

- 60 seconds for one case and 300 seconds for the complete run.
- 131,072 input bytes and 65,536 extracted output bytes for one case.
- 4 GiB resident memory for each isolated process tree.
- 8 MiB temporary disk for each isolated case.
- 64 processes in each isolated process tree.
- 64 cases and a 256 KiB final report.

The parent starts each case in a new process group. It sets address-space, CPU, file-size, and core-file limits where the operating system supports them. It checks wall time, all Linux descendants, summed resident memory, and temporary-directory size every 5 milliseconds. It kills the full process group when a measured ceiling is crossed. It also enforces one total monotonic deadline.

Resident memory is a summed Linux `/proc` measurement. On systems without `/proc`, the OS address-space limit remains the portable approximation. Temporary disk uses an OS per-file limit plus a 5 millisecond directory high-water sample. A portable per-directory disk quota is not available. The final report and worker result have separate finite size checks. Regression tests create deterministic violations for case time, total time, input, extracted output, worker report, memory, process count, and disk.

## Read the metrics

The report keeps these metrics separate:

- Required marker retention.
- Forbidden boilerplate leakage.
- Heading preservation.
- Code block preservation.
- Table preservation.
- Link preservation.
- Structured row completeness.
- Output characters and UTF-8 bytes.
- Wall time, peak process-tree resident memory, temporary-disk high-water, and descendant-process high-water.

Representative fixture requirements come from reviewed fixture semantics. A source heading, code block, table, or link has a nonzero requirement. If current extraction flattens it, the baseline records a visible failure.

## Optional adapters

Environment variables cannot contain commands. They can only name an adapter in the fixed `OPTIONAL_ADAPTERS` module registry in `run.py`. The registry is empty because this repository has no reviewed candidate. Any missing or unknown value is a visible skip. A future reviewed module runs inside the same isolated worker and receives the same limits.

## Add a fixture

1. Create a small synthetic fixture in `fixtures/`. Do not copy remote content.
2. For PDF or Office bytes, update `generate_fixtures.py`. Use fixed ZIP timestamps and fixed object order.
3. Run `cd components/browser && uv run --offline python benchmarks/extraction/generate_fixtures.py`.
4. Add one manifest case. Record its SHA-256 digest, class, media type, expected production path, expected outcome, required markers, forbidden markers, all five structure counts, and allowed loss.
5. Run `pnpm test:extraction`. Inspect all report rows.

Use `uv run --offline python benchmarks/extraction/generate_fixtures.py --check` to detect binary fixture drift.

## Update the reviewed baseline

Do not update the baseline only to make a test pass.

1. Run the corpus from a clean offline state.
2. Inspect every deterministic difference.
3. Confirm all fixture hashes and annotations.
4. Review marker, boilerplate, structure, row, acquisition, and environment results.
5. Run:

   ```sh
   cd components/browser
   uv run --offline python benchmarks/extraction/run.py --write-baseline --no-compare
   ```

6. Review `current-baseline.json`, `reports/current-run.json`, and `reports/decision.md` together.
7. Commit the reviewed files in one change.
