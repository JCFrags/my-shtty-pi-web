# Save a web read as Markdown

Status: implemented and live-tested on 2026-08-25. The product source is authoritative; these documents preserve the design, safety decisions, implementation plan, and review evidence.

This proposal adds an optional file-output form to `web_read`. It lets Pi read a known public URL through the normal WebX pipeline and save the complete extracted result as a Markdown file in WebX's user-owned export directory.

The feature solves one specific problem. A large page can be useful as a local working file, but returning its complete text through the Pi transcript uses context and can make later section-by-section work difficult. Direct saving preserves the same extracted content without putting it all in the model response.

This is not a browser download feature, a general file downloader, a research archive, or an unrestricted filesystem-write tool.

## Documents

- [PRODUCT.md](PRODUCT.md) defines user-visible behavior and the Pi tool contract.
- [ARCHITECTURE.md](ARCHITECTURE.md) shows how the capability fits into WebX and defines its security boundary.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) gives the build order, tests, acceptance criteria, and rollback.
- [REVIEW_AND_DECISION.md](REVIEW_AND_DECISION.md) records the self-review evidence and final design decision.

## Initial recommendation

Keep `web_read` as the only exposed tool. Add an optional `save` object rather than a new `web_save` tool. The caller provides a relative `.md` path below `~/.local/share/pi-web/exports`. WebX must not overwrite an existing file unless the caller explicitly sets `overwrite: true`.

A normal call still returns content. A save call writes the full extracted Markdown and returns only compact local-file metadata. Search behavior, browser behavior, the traffic cache, and the future research archive do not change.
