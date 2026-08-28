# Reader runtime boundaries

## Queue deadline

The reader starts the total request timeout before it waits for an acquisition slot. A saturated queue cannot extend the request deadline. The same deadline covers DNS checks, acquisition, redirects, decompression, extraction, and document conversion.

## Extraction workers

HTML extraction and local PDF text extraction run in child processes. One bounded semaphore limits both worker types. A separate worker timeout starts before the worker semaphore wait. Cancellation, timeout, worker failure, and excess output kill and reap the process group.

Workers use bounded pipes. The parent rejects output above 16 MiB. The HTML worker also checks its output before it writes. The HTML worker has CPU and open-file limits. PDF input and output use pipes, so local PDF extraction creates no temporary files. Docling handoff keeps one private staged file and always removes it.

The process count and timeout settings have fixed upper bounds. Acquisition byte limits continue to bound worker input. These worker controls do not change URL validation, DNS pinning, redirects, raw-byte limits, or decompressed-byte limits.

## Startup compatibility

Reader startup requires HTTPX 0.28.1 and httpcore 1.0.9. It checks the private HTTPX/httpcore pool hook used for DNS pinning and the HTTPX decoder hook used for separate raw and decompressed byte limits. Startup fails closed if a version or hook differs.
