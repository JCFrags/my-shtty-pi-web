# WP1-M6 extraction decision

## Reviewed baseline

The reviewed run has 28 current-adapter cases. It also has two skipped optional-adapter slots. The current adapter retains all declared required markers in 23 cases. It records known losses instead of hiding them in one score.

Weak representative classes include these cases:

- Technical documentation loses one table value and flattens code and table structure.
- News, GitHub-like, Hacker News-like, and forum-like pages leak some navigation or footer text.
- Cookie and challenge shells lose their first heading while they keep the key challenge sentence.
- The PDF table keeps the table cells but loses the separate title.

The static adapter keeps all required content in the blog, product, Wikipedia-like, static page, bad-charset, redirect, and compressed-response cases. JSON keeps both structured rows. RSS and Atom keep their required entry text. Negotiated Markdown keeps headings, code, and its link. The plain-text path keeps all required text.

Docling keeps the required ordinary PDF text, DOCX text, PPTX text, and XLSX table cells in this reviewed environment. The image-only scanned PDF has no embedded text and is allowed to return empty output or a clean error. This case makes the OCR escalation gap visible.

## PDF route

This run does not justify a production change to use `pdftotext` first. Docling preserved the required ordinary PDF content. The production fallback remains available when Docling fails. The corpus does not show that a first-route change improves two weak representative classes. Keep Docling escalation for tables, layout, Office files, and scanned files.

## Extractor decision

No candidate adapter was configured. Both optional slots are reported as skipped. There is no measured candidate evidence.

Keep the current production routing. Do not replace an extractor.

A future candidate must improve at least two weak representative classes. It must not add a required-marker loss. It must not weaken acquisition or SSRF security. It must have an acceptable license, installed size, dependency set, deployment method, memory use, and runtime. Review each separate metric and the affected fixture output before a routing change.
