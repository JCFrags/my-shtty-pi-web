# Implementation and verification plan

## Objective

Add an optional, safe Markdown-file output to `web_read`. Preserve the existing read result when `save` is absent. Do not add another Pi tool or another retrieval path.

## Phase 1: freeze the contract

1. Fix the version-one write root at `${XDG_DATA_HOME:-~/.local/share}/pi-web/exports`. Do not accept a caller-selected root.
2. Add failing schema and facade tests for the exact version-one input and result.
3. Define deterministic front matter escaping, newline handling, title behavior, and completion metadata.
4. Confirm that `query`, `view`, `maxChars`, and `contentOffset` have the same meaning for saved and returned reads.
5. Reject `fields`, `itemOffset`, `itemLimit`, `maxPages`, and `maxDepth` when `save` is present in version one.

## Phase 2: implement the local output boundary

1. Add `ReadSaveOptions` and `SavedReadResponse` SDK types.
2. Add a pure function that converts one read response into UTF-8 Markdown with fixed front matter.
3. Add a guarded writer that:
   - resolves a relative `.md` path under the fixed WebX export root;
   - checks existing components without following symbolic links;
   - creates required directories safely;
   - creates a same-directory temporary file with exclusive creation;
   - writes and flushes complete bytes;
   - installs a new destination without replacement by atomically linking the completed temporary file and then removing the temporary name;
   - uses same-directory rename for an explicit overwrite;
   - removes temporary files on failure;
   - returns byte count and SHA-256.
4. Make the facade perform the normal daemon read first. Write only after retrieval succeeds.
5. Return compact local metadata. Do not attach the complete content to the Pi result.

## Phase 3: connect the Pi surface

1. Extend `WebReadSchema` with a strict optional `save` object.
2. Update `apps/pi-webx/src/index.ts`, output formatting, active guidance, and tests.
3. Keep `/web read` as the capability gate.
4. Keep audit classification as `web.read`; store compact save metadata and failures.
5. Update the root README, extension README, daemon README where relevant, SDK README, and WebX skill.

## Tests

### Unit tests

- deterministic Markdown and front matter;
- escaping of quotes, line breaks, and delimiter-like title text;
- UTF-8 byte and character counts;
- digest correctness;
- valid nested relative paths;
- rejection of absolute, traversal, empty, malformed, and non-Markdown paths;
- existing-file refusal by default;
- explicit overwrite success;
- no partial destination after write failure;
- preservation of the old destination after failed overwrite;
- rejection of direct and intermediate symbolic links;
- race test where a directory component changes during the write;
- unchanged ordinary `web_read` behavior.

### Integration tests

- HTML main-content save;
- focused section save;
- PDF-to-Markdown save through the existing document converter;
- a bounded save that reports `complete: false`;
- cache hit and cache miss produce the same saved bytes;
- audit record contains metadata but not the full body;
- callers cannot select or escape the fixed export root;
- untrusted projects cannot save.

### Live acceptance tests

Use current public sources, not synthetic public sites:

1. Save a Fedora documentation page as main-content Markdown.
2. Save one focused section from Python documentation.
3. Save a public NIST PDF after document conversion.
4. Read selected headings from each saved file with Pi's normal file reader.
5. Confirm no browser service starts for these calls.
6. Confirm a repeat without overwrite fails and leaves the first file unchanged.
7. Confirm explicit overwrite replaces it atomically.
8. Confirm all seven existing user services remain healthy.

Delete only the acceptance files created in a dedicated temporary subdirectory of the WebX export root.

## Acceptance criteria

- One `web_read` call can save one extracted public source as a `.md` file.
- The saved body matches the normal extracted read body for the same selectors.
- Pi receives compact metadata, not the complete saved body.
- The write cannot escape the fixed export root or traverse a symbolic link.
- Existing files are protected by default.
- Retrieval or write failures do not leave partial output.
- Normal reads, search, browser, cache, and uninstall behavior do not regress.
- Tool schema, prompt guidance, SDK types, tests, installer output, and installed extension agree.

## Rollback

The change is local and reversible:

1. Remove the `save` schema property and facade branch.
2. Remove the renderer and guarded writer.
3. Restore the earlier SDK types, descriptions, and tests.
4. Reinstall the prior commit.

Do not remove Markdown files that users created with the feature. They are user-owned export files.

## Verification result

Implementation completed on 2026-08-25. Lint, all TypeScript type checks, and all workspace tests passed. Live acceptance saved and inspected:

- the Fedora 44 desktop release notes as full main-content Markdown;
- the free-threaded Python 3.14 section as focused Markdown;
- the NIST Cybersecurity Framework 2.0 PDF as focused Markdown after document conversion.

All files had mode `0600`, valid fixed front matter, source content, compact result metadata, and `complete: true`. A repeated save without overwrite failed and preserved the first file. The installer created the export root with mode `0700`. All seven user services remained active. The dedicated acceptance directory was removed after inspection.
