# WP1-M7 HTML extraction decision

## Decision

Keep current Trafilatura production routing. No evaluated HTML candidate meets the full M7 gate. `adoptedHtmlExtractor` is therefore `null` in the corpus report.

The M6 reviewed baseline remains `current-baseline.json`. Candidate rows do not change that baseline. The report keeps current totals in `summary` and expanded totals per candidate in `candidateSummary`.

## Shared extraction contract

`HtmlExtractor` receives only HTML, URL, view, and query. It returns content, title, extractor identity, and metadata. `ReaderPipeline` sends production and candidate inputs through the same bounded worker protocol. Acquisition, DNS pinning, SSRF checks, redirects, response limits, worker time, memory, process, disk, and output limits remain outside the extractor.

The production worker uses current Trafilatura settings. The first candidate changes only Trafilatura settings. It enables recall, disables precision preference, disables de-duplication, and keeps Markdown links and tables. The other two adapters are benchmark-only Node workers. Defuddle returns Markdown. Mozilla Readability returns cleaned HTML, which Turndown converts with ATX headings, fenced code, inline links, and a deterministic table rule.

## Candidate results

Recall-oriented Trafilatura retains all required markers. It does not improve two weak classes. It leaks reviewed boilerplate in five classes, misses required structure in twelve classes, and loses paragraph boundaries in five classes.

Defuddle improves three weak classes. It still loses required markers in eight classes, misses required structure in nine classes, and loses paragraph boundaries in one class.

Readability with Turndown improves two weak classes. It loses a required marker in one class, leaks reviewed boilerplate in five classes, misses required structure in ten classes, and loses paragraph boundaries in six classes.

Every candidate stays within the reviewed per-case limits. In the reviewed run, each HTML case completes in less than one second. Peak process-tree resident memory stays below 160 MiB. These samples remain in candidate rows. They are evidence, not a new limit.

No candidate preserves all newly required markers, prevents all boilerplate leakage, and retains all required headings, links, fenced code, table values, and paragraph structure. Do not force a primary or fallback change.

## Dependency and scope review

Defuddle 0.19.3 is MIT. Mozilla Readability 0.6.0 is Apache-2.0. Turndown 7.2.4 is MIT. LinkeDOM 0.18.13 is ISC. They are exact root development dependencies with a locked transitive graph. They are not dependencies of `pi-web-reader` and no production extractor imports them.

Scrapling is rejected for this milestone. Its parser is part of a broader scraping system with HTTP fetching, TLS impersonation, proxy rotation, sessions, anti-bot behavior, and Playwright or Chrome automation. The reviewed project evidence does not show an equivalent fetch-independent main-content extractor. Adding it would duplicate acquisition and browser controls and would expand the trust and dependency boundary.

## Fallback quality

`useful_text` now delegates to a deterministic quality score. The score uses word and alphanumeric counts, paragraph shape, repeated-line ratio, and explicit shell or access boilerplate. Long repeated shell text can no longer pass only because it has at least 80 characters. The score and its signals are present in static extraction metadata.

Candidate smoke now records the corpus absolute gate, every candidate decision, and the selected extractor identity. The existing cutover flow consumes this smoke evidence. This adds corpus evidence without changing deployment routing.

Acquisition contracts run only for current production routing. HTML candidates share that routing but do not duplicate acquisition cases. Candidate totals therefore cannot create acquisition failures. The current summary remains 9 extraction passes, 13 extraction failures, 3 acquisition-contract passes, no acquisition-contract failures, and 5 skips.
