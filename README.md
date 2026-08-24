# Pi web tools

This repository is the single source for Pi's internet tools.

It contains:

- web search, direct page reading, research, recall, and artifact access;
- browser automation with explicit sessions and tabs;
- a Tauri desktop workspace for live viewing and user control;
- PDF and office-document conversion;
- the Pi extension that presents these capabilities as one tool set;
- local deployment files.

The components can share infrastructure when that gives a clear benefit. They remain separate where separation keeps simple operations reliable. Search and direct reading do not require the visual browser. Browser automation and the desktop workspace are available for dynamic pages, interaction, and user supervision.

## Main directories

- `apps/pi-webx`: Pi extension.
- `apps/webxd`: local authority for web and browser operations.
- `components/browser`: browser coordinator, backends, Tauri workspace, reader, Docling integration, and browser protocol.
- `packages/sdk`: client interface used by the Pi extension.
- `packages/artifacts`: bounded large-result storage primitives.
- `packages/policy`: destination and ownership policy primitives.
- `packages/test-fixtures`: local deterministic fixtures.
- `deploy`: retained local deployment files.

See [`FUTURE_FEATURES.md`](FUTURE_FEATURES.md) for useful ideas intentionally deferred until the core is stable.

## Current state

The source is retained for consolidation and rebuilding. It is not installed or connected to Pi on this computer. The next work is to simplify component boundaries, replace copied build output with one packaging path, and create one clear installer.
