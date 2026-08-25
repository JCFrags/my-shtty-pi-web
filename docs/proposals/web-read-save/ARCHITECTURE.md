# Architecture and system fit

## Placement

The feature stays under `web_read` because it changes the delivery of an existing read result. It does not discover URLs, control a browser, or download arbitrary response bytes.

The flow is:

```text
Pi web_read call
  -> Pi extension schema and trust check
  -> SDK facade validates save options and export-relative path
  -> existing SDK read request
  -> webxd destination policy, cache, reader, Crawl4AI, or document converter
  -> extracted read response
  -> facade renders deterministic Markdown
  -> guarded atomic write below WebX's user-owned export directory
  -> compact Pi result and normal private audit record
```

This placement has two useful properties:

1. The daemon and extraction services keep one read implementation.
2. The facade already receives the trusted Pi working directory in `FacadeRequestOptions.cwd`, while the daemon request currently does not.

The content still crosses the private same-user Unix socket between `webxd` and the facade. It does not cross the model transcript. Existing direct reads have a 1,000,000-character source bound and the runtime has a 4 MiB response bound, so the initial save form does not require a new streaming protocol.

## Component changes

### Pi extension

- Add the optional `save` object to `WebReadSchema`.
- Update tool descriptions, prompt guidance, README text, and the bundled WebX skill.
- Keep the operation name `web.read` and the existing read capability mode.
- Present compact save metadata instead of `untrustedContent` for a save call.
- Audit the input and compact result through the existing `web.read` audit path.

### SDK

- Add `ReadSaveOptions` and `SavedReadResponse` types.
- Extend only the facade request shape. Keep the daemon `ReadRequest` focused on network retrieval.
- Add a small Markdown renderer and a guarded local writer behind narrow interfaces so they can be tested without internet access.

### Web authority and services

- No new SearXNG, reader, Crawl4AI, Docling, browser, or Tauri route is needed.
- No browser session starts.
- No new cache entry is needed. The normal read cache remains responsible for traffic reduction.

### Audit and storage

The existing private audit record should contain:

- URL and read selectors;
- requested relative destination and overwrite choice;
- final relative path, byte count, digest, completion state, and source metadata;
- exact failure stage when the operation fails.

The audit record must not duplicate the complete saved document. The saved file is user-owned export data. It is not traffic-cache data, audit data, or part of the future research archive. Uninstall must not delete it.

## Filesystem boundary

`${XDG_DATA_HOME:-~/.local/share}/pi-web/exports` is the fixed write root. Version one accepts only normalized relative paths and rejects:

- absolute paths;
- empty paths;
- `.` or `..` segments;
- NUL bytes;
- paths whose normalized form changes their meaning;
- non-`.md` suffixes;
- any existing symbolic-link component;
- an existing destination when overwrite is false.

The installer creates the export root with mode `0700`. The writer creates missing directories with mode `0700` and files with mode `0600`. It writes a temporary file in the destination directory, flushes and closes it, then installs the completed file atomically. Temporary files are removed after a failure.

Path validation and the final write must be one guarded operation. A string prefix check is not sufficient. WebX owns the export root and its subdirectories, rejects symbolic-link components, and does not permit callers to select another root. This narrower boundary avoids claiming safe arbitrary project-relative writes through Node path checks. A future project-directory option would require a separate filesystem design, such as a small Linux helper using directory-relative resolution controls.

## Trust model

The project must pass Pi's existing `ctx.isProjectTrusted()` check before any WebX call. Retrieval still uses the existing public-destination and connection-bound egress controls.

Saved web content is data, not instructions. Front matter uses fixed keys. The file should include a short generated note that its body came from an external source, unless this harms an established Markdown consumer.

Saving a new file is reversible. Overwriting can destroy user work, so it requires the explicit `overwrite: true` input. The implementation must not infer overwrite permission from a previous call.

## Deliberate exclusions

Version one does not:

- expose a new `web_save` tool;
- save search result sets;
- save several crawled pages in one call;
- fetch through browser automation;
- support authenticated or private URLs;
- save arbitrary binaries, browser downloads, images, or attachments;
- convert structured JSON projections to tables;
- create a durable website archive or model-facing recall system;
- choose a destination without a caller-provided path.
