# Architecture

## Design objective

Pi Web Workspace makes browser execution feel native to Pi without embedding website execution into Pi or Tauri. Pi remains an ordinary terminal application. `pi-browserd` coordinates identities, processes, queues, profiles, browser backends, search, reading, and artifacts. Chromium or Lightpanda executes the website. Tauri renders a local control shell and the backend’s viewport frames.

## Process model

`pi-browserd` is one user-level daemon. Pi processes connect through newline-delimited JSON-RPC 2.0 over `$XDG_RUNTIME_DIR/pi-web/browserd.sock`. The workspace connects through a loopback HTTP/WebSocket endpoint written to a user-only `browserd.json` descriptor. A per-start capability token authenticates that loopback path; Pi clients on the Unix socket do not need it. Viewport frames use the backend’s dedicated stream and never traverse the normal event bus.

Each Pi process has a `clientId`; each logical Pi session has an `agentId`. The daemon keeps browser state when a client disconnects. The workspace can restart without restarting browsers. Registry snapshots contain coordinator IDs and launch metadata, never passwords or model prompts.

## Browser model

A `BrowserHost` is an actual backend browser process/session. A `BrowserSession` is work owned by one Pi agent. A `TabInfo` is explicitly owned by an agent and session. Persistent profiles map to exactly one Chromium host. Multiple sessions can intentionally share a persistent host through separate owned tabs.

The default adapter uses an `AGENT_BROWSER_NAMESPACE=pi-web-v1` namespace and a unique backend `--session` per host. Since agent-browser operations may act on a focused tab, the adapter treats tab focus plus one action/observation/result collection as an atomic operation. The coordinator also retains a host queue so backend differences do not leak into clients.

## Reader routing

`web_read` first asks the reader service for text. The reader performs Markdown content negotiation, original text handling, `.md`/`index.md`, nearest `llms.txt`, optional `llms-full.txt`, and Trafilatura extraction. A detected client-rendered shell returns `renderRequired` rather than launching an unowned browser. The coordinator then renders through an agent-owned transient Lightpanda session and records a Chromium escalation if Lightpanda fails. Active authenticated tabs are read directly through the browser backend.

PDF and office bytes are converted by Docling. Original bytes, Markdown, and large structured results enter the artifact store; Pi sees a bounded initial section and artifact identifiers.

Search, reader, and Pi RPC operations have no fixed deadline by default. Deployments may opt into timeouts through environment or configuration values. Response and observation bounds do not discard data: complete content is persisted and pageable through artifacts.

## Failure behavior

Errors are JSON-RPC errors with stable classes and structured data. A capability gap is `unsupported`; it is never represented as success. Engine escalation is limited to documented reader routing and records each attempt. Live sessions are never migrated between engines. Browser/daemon recovery reconstructs known state where the backend still exists and reports failed recovery otherwise.
