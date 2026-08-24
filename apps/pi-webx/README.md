# Pi WebX

This Pi extension presents the repository's web and browser capabilities as one small tool set.

## Tools

- `web_search`: discover public web sources.
- `web_read`: fetch and extract a known page, API, feed, PDF, or document.
- `web_research`: gather and compare bounded evidence from several sources.
- `browser_open`: open a browser when direct reading is insufficient.
- `browser_tabs`: list and close owned browser tabs and sessions.
- `browser_observe`: inspect browser content or visual state.
- `browser_act`: interact with an observed browser tab.
- `browser_debug`: request advanced diagnostics in explicit debug mode.

The default mode includes normal browser tools. Only the user changes modes with `/web off|read|browser|debug`. There is no model-facing upgrade tool.

Repeated searches and page reads use an internal short-lived RAM and SSD cache. The cache reduces rate-limit pressure and repeated website traffic. It is not a durable research library and is not exposed through recall tools.

The extension calls the local WebX SDK over a same-user Unix socket. It does not call websites, browser providers, or subprocesses directly. It fails closed when the local daemon is unavailable.

Use direct reading before browser automation. Sensitive authentication, uploads, downloads, purchases, credentials, and destructive actions require explicit user approval.
