# Future feature ideas

This file preserves useful ideas from the earlier WebX platform plan. These items are not commitments. Most are incomplete or only represented by schemas, placeholders, or deployment plans.

The first goal is a small and reliable Pi internet tool set: search, direct page reading, document conversion, browser control, a visible desktop workspace, and one simple installation path.

## Search and discovery

- Search several public providers through a self-hosted search service.
- Search a local collection of previously read pages.
- Add facets and filters for source, date, content type, and collection.
- Support feeds such as RSS and Atom.
- Optionally add a private local search engine for a larger saved corpus.

## Separate research archive extension

A future extension can preserve websites for long-term research and gradually build a local library or encyclopedia from high-quality sources. It must remain separate from the core Pi web tools so that storage, indexing, retention, and archival complexity do not affect normal search, reading, or browser control.

Possible features:

- Save reviewed copies of useful public pages and their source provenance.
- Search the local collection before using the public internet.
- Track page versions and meaningful changes.
- Build curated topics from stronger sources gathered over long-term use.
- Run bounded multi-source research with citations and disagreement checks.
- Resume a long research task from a saved manifest.
- Forget one saved version or an entire URL.
- Export and import source collections.
- Operate as its own Pi extension with its own storage and retention controls.

The core web tools can use a short-lived RAM and SSD cache to reduce repeated traffic. That cache is not a research archive and is not exposed as recall tools.

## Crawling and monitoring

Crawl4AI remains an internal capability rather than a separate Pi tool. `web_search` uses fixed recipes and never follows links. `web_read` and `web_research` expose bounded linked traversal only when their task needs it. Future work can add:

- Pause, resume, cancel, and inspect a long crawl.
- Watch selected pages or feeds and report changes.
- Schedule optional refreshes without turning the core tools into a large crawler platform.

## Documents

- Inspect and convert PDF and office documents.
- Add OCR for scanned documents.
- Extract scholarly metadata, tables, and document structure.
- Split large documents into useful sections while keeping links to the original bytes.
- Preserve conversion warnings and provenance.

## Media

- Inspect media metadata.
- Acquire user-approved public media.
- Transcribe audio and video.
- Acquire image galleries.
- Record approved streams.

These features should remain optional and separate from basic page reading.

## Browser and visual workspace

- Keep persistent browser profiles and signed-in sessions.
- Support more than one browser engine when each engine has a clear benefit.
- Let Pi control tabs without relying on one process-wide focused tab.
- Show live browser activity in the Tauri desktop app.
- Let the user take control and return control to Pi safely.
- Keep screenshots, downloads, uploads, console output, and network diagnostics available when needed.
- Save and restore selected sessions only if this can be reliable and simple.

## Artifacts and page history

- Store large results by content hash instead of putting all content into the model context.
- Read artifacts in bounded sections.
- Verify stored content and quarantine corrupt files.
- Keep visit receipts and source provenance.
- Add safe import, export, backup, restore, and archive replay only when the core storage model is stable.

## Wiki and knowledge integrations

- Publish selected page or research updates to an external notes or wiki system.
- Use an explicit delivery queue with acknowledgement and retry.
- Support backfill for a newly connected consumer.

This should be an optional integration. Web research must not depend on a wiki service.

## Privacy, policy, and approvals

- Block requests to private, loopback, metadata, and unsafe network destinations.
- Check every redirect and pin the approved destination at connection time.
- Keep owner boundaries for saved pages, artifacts, browser sessions, and approvals.
- Require explicit approval for sensitive uploads, downloads, credentials, or external actions.
- Add retention controls for saved pages and artifacts.
- Keep an audit trail for important state changes without storing secrets.

## Operations

- Report health, versions, capabilities, and active browser engines.
- Support cancellation and bounded resource use for long operations.
- Add a local status view for jobs and services.
- Provide backup verification and safe restore.
- Add monitoring only when it solves a demonstrated reliability problem.

## Optional local models

- Use a local model for extraction, classification, transcription, or summarization when it gives a measured benefit.
- Support CPU and GPU runtimes through one optional gateway.
- Keep all core internet tools functional without a local model.

## Design rules for future work

- Add a feature only after the current foundation is reliable.
- Prefer one implementation over copied snapshots.
- Share a component when sharing reduces work or improves the user experience.
- Keep components separate when forced sharing adds complexity or creates a single point of failure.
- Keep simple search and reading independent from browser automation.
- Keep optional features disabled and removable.
- Require a clear user benefit before adding a service, database, queue, container, or public API.
