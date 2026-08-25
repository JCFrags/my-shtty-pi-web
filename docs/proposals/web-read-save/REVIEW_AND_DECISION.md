# Review and final design decision

## Review status

The requested managed-agent review could not run. The broker created reviewer and scout tasks in synchronous and asynchronous forms, but each run failed before it produced output. No other-agent opinion exists, and this document does not invent one.

The primary agent completed a focused self-review of the proposal, current WebX code, and authoritative filesystem and YAML references. The user approved proceeding with that self-review.

## Sources and findings

### Node.js filesystem API

Source: <https://nodejs.org/api/fs.html>

Node supports exclusive creation flags, hard links, file synchronization, and rename. These operations can provide complete-file publication and default no-overwrite behavior inside a directory that WebX controls. A separate existence check followed by rename is not sufficient for no-overwrite behavior because another process can create the destination between the two operations.

### Linux path resolution

Source: <https://www.man7.org/linux/man-pages/man2/openat2.2.html>

Linux `openat2` provides controls such as `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS`. They give a stronger boundary for writes below an arbitrary caller-selected directory. Node does not expose this complete interface as a simple standard filesystem operation. String normalization, prefix comparison, and pre-write symbolic-link checks do not provide the same race-resistant guarantee.

### YAML 1.2.2

Source: <https://yaml.org/spec/1.2.2/>

YAML supports quoted scalars and document markers. Fixed front matter is acceptable if WebX uses only a fixed set of keys and serializes every untrusted string as a quoted scalar. WebX must not concatenate page titles or URLs into plain YAML scalars.

## Strong parts of the proposal

- It reuses the current read and conversion pipeline.
- It keeps one exposed `web_read` tool.
- It solves transcript and model-context waste without reducing saved content.
- It does not add browser downloads or another network path.
- It protects existing files by default.
- It keeps saved files separate from cache, audit history, and the future research archive.
- It has a narrow first version: one URL and one Markdown file.

## Corrections from self-review

### Use a fixed WebX export directory

The first draft proposed project-relative writes. That design made a stronger filesystem promise than ordinary Node path validation can prove under concurrent symbolic-link changes.

Version one now writes only below:

```text
${XDG_DATA_HOME:-~/.local/share}/pi-web/exports
```

The caller chooses only a relative `.md` path below that root. WebX creates and owns the root and subdirectories. This is simpler and safer. The result returns the absolute path so Pi can read or move the file later.

### Define no-overwrite publication separately

For `overwrite: false`, WebX writes and flushes a same-directory temporary file, then creates the destination with an atomic hard link. Link creation fails if the destination already exists. WebX then removes the temporary name.

For `overwrite: true`, WebX writes and flushes a same-directory temporary file, then renames it over the destination. This gives atomic replacement on the supported local Linux filesystem.

The implementation must test these exact assumptions on Fedora. It must report a clear unsupported-filesystem error if the export directory does not support the required operation.

### Keep YAML front matter small and deterministic

Use only fixed keys: `title`, `source_url`, `retrieved_at`, and `complete`. Serialize strings with a tested YAML-safe quoted-scalar function. Do not copy arbitrary metadata keys from the source.

## Final recommendation

Build the capability with these decisions:

1. Add optional `save` to `web_read`; do not add `web_save`.
2. Save one normal or focused read as one UTF-8 Markdown file.
3. Use the fixed WebX export root.
4. Require a caller-provided relative `.md` path.
5. Refuse existing destinations by default.
6. Require explicit `overwrite: true` for replacement.
7. Return compact path, size, digest, source, and completion metadata.
8. Audit metadata and errors, but not the full saved body.
9. Exclude structured JSON, linked crawling, browser downloads, binaries, and automatic archiving from version one.
10. Add project-relative destinations only as a later feature with a separate, proven filesystem boundary.

This is the smallest design that provides the requested result without duplicating WebX retrieval or exposing a broad filesystem-write tool.
