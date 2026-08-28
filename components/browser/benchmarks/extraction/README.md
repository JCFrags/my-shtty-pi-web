# Offline extraction corpus

This corpus measures the current WebX extraction paths with local synthetic fixtures. It does not start an HTTP server. It does not change acquisition or SSRF controls. The current adapter calls the production reader functions and the production Docling converter through a narrow local-file adapter.

## Run the current baseline

From the repository root, run:

```sh
pnpm benchmark:extraction
```

The command uses `uv --offline`. The runner also sets the Hugging Face and Transformers offline flags. It writes `reports/current-run.json`. It returns zero when deterministic current-adapter quality matches `current-baseline.json`. Known baseline losses do not make the command fail. A quality change or a missing baseline makes the command fail. Time and peak resident set size are recorded, bounded, and not compared.

The manifest sets these hard ceilings:

- 60 seconds for one case and 300 seconds for the corpus.
- 131,072 input bytes and 65,536 output bytes for one case.
- 4 GiB peak resident memory as a portable process approximation.
- 8 MiB temporary disk, 64 processes, 64 cases, and a 256 KiB report.

The runner checks byte, case, time, and report limits directly. It uses a private temporary directory and records peak resident set size from `getrusage`. The memory, disk, and process values are explicit portable ceilings. The runner monitors them and fails a case or run that crosses a measured ceiling. Operating systems do not provide one portable way to enforce these three limits without also changing Docling behavior. Run the benchmark in the normal project sandbox for stronger host enforcement.

An oversized fixture is an intentional clean limit error. A scanned PDF with no embedded text can return empty output or a clean error. The fixture adapter supplies declared redirect and compression metadata because the corpus does not perform network acquisition.

## Read the metrics

The report keeps each metric separate:

- Required marker retention shows each required marker.
- Forbidden boilerplate leakage shows each leaked marker.
- Heading, code block, table, and link preservation show observed and required counts.
- Structured row completeness shows observed and required rows.
- Output characters and UTF-8 bytes show result size.
- Wall time and approximate peak resident memory show resource use.

The report has no combined quality score. `allowedLoss` in the manifest explains accepted format loss. Environment and dependency versions are in a separate baseline section. Quality comparison does not use timing or memory values.

## Compare an optional adapter

No secondary extractor is installed by this benchmark. Set one command only when a reviewed local adapter already exists:

```sh
WEBX_BENCH_HTML_ADAPTER='/absolute/path/html-adapter' pnpm benchmark:extraction
WEBX_BENCH_PDF_ADAPTER='/absolute/path/pdf-adapter' pnpm benchmark:extraction
```

The runner passes the fixture path and media type as command arguments. It sends the case annotation as JSON on standard input. The adapter must return one JSON object with `content`, optional `path`, and optional `metadata` fields. The same output and time limits apply. A missing command is reported as `skipped`, not `passed`.

Use `reports/decision.md` for the decision rules. Keep the current extractor unless a candidate improves at least two weak representative classes with no new required-marker loss. Also review security, deployment, license, dependency size, and runtime before a routing change.

## Add a fixture

1. Create a small synthetic fixture in `fixtures/`. Do not copy remote content.
2. For PDF or Office bytes, update `generate_fixtures.py`. Use fixed ZIP timestamps and fixed object order.
3. Run `cd components/browser && uv run --offline python benchmarks/extraction/generate_fixtures.py`.
4. Add one manifest case. Record its SHA-256 digest, class, media type, expected path and outcome, required markers, forbidden markers, all five structure counts, and allowed loss.
5. Run `pnpm test:extraction` and inspect the full per-case report.

Use `uv run --offline python benchmarks/extraction/generate_fixtures.py --check` to detect binary fixture drift.

## Update the reviewed baseline

Do not update the baseline only to make a test pass.

1. Run the corpus and inspect every quality difference.
2. Confirm that fixture bytes and annotations did not change by accident.
3. Review all marker, boilerplate, structure, and row changes.
4. If the new current output is accepted, run:

   ```sh
   cd components/browser
   uv run --offline python benchmarks/extraction/run.py --write-baseline --no-compare
   ```

5. Review `current-baseline.json`, `reports/current-run.json`, and `reports/decision.md` together.
6. Commit the reviewed files in one change.
