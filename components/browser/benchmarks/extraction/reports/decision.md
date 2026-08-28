# WP1-M6 extraction decision

## Reviewed offline baseline

The clean offline run has 28 current cases. It records 8 extraction passes, 14 extraction failures, 3 acquisition-contract passes, and 3 current environment skips. Two optional candidate slots are also skipped.

The adapter calls `ReaderPipeline.read` with deterministic injected acquisition. Expected annotations do not select reader behavior. All static HTML cases use the production `trafilatura` source. Feed XML also uses the production `trafilatura` source. JavaScript shell fallback uses the production Markdown candidate flow. Challenge results use the production `raw` source and `renderRequired` metadata.

The reviewed fixture semantics require source headings, code blocks, tables, and links. The technical documentation result retains two headings and one link. The other direct `trafilatura` HTML results retain no measured heading or link structure. All required code-block and table structure in direct HTML results is lost. The technical documentation result also loses one required table value. Cookie and challenge shells each lose one required heading marker. The JavaScript shell uses the Markdown fallback and retains two headings and one code block. These measured losses and retained structures are visible in the baseline.

JSON keeps both structured rows. Negotiated Markdown keeps its headings, code block, and link. Plain text keeps all required text. RSS and Atom keep their required text and declared structure.

Bad charset, redirect, and gzip cases pass separate acquisition contracts. They do not count as extraction passes. Their observed values come from the deterministic transport and reader behavior. The runner does not copy expected metadata into a result.

## Offline document capability

The benchmark does not start Docling. It does not declare RapidOCR model assets. DOCX, PPTX, and XLSX are visible environment skips. The report makes no claim that these formats work from an undeclared model cache.

PDF cases exercise the current production fallback when the Docling service is unavailable. In this clean offline run, `pdftotext` does not find useful text in the synthetic ordinary, table, or scanned PDF fixtures. The ordinary PDF and table PDF are visible failures. The scanned PDF clean error matches its reviewed empty-or-error contract.

This evidence describes offline capability only. It does not justify a routing change. It does not show that `pdftotext` should become the first PDF route. It also does not measure a working Docling service with reviewed local model assets.

## Extractor decision

No candidate adapter is present. Both reviewed candidate slots are skipped. There is no replacement evidence.

No extractor replacement is justified. Keep current production routing unchanged.

A future candidate must improve at least two weak representative classes. It must not add required-marker loss. It must keep acquisition and SSRF controls. It must use an acceptable license and deployment method. Review dependency size, installed size, memory, runtime, and every separate quality metric before a routing change.
