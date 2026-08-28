# Upstream components and attribution

Pi Web Workspace wraps rather than forks its initial browser driver. Verify versions when changing pins.

- Pi coding agent and extension APIs: earendil-works/pi.
- agent-browser native daemon, dashboard concepts, session namespace, compact refs, and JPEG stream: vercel-labs/agent-browser, Apache-2.0.
- Lightpanda browser: lightpanda-io/browser, AGPL-3.0.
- Chromium: Chromium project licenses.
- SearXNG: searxng/searxng, AGPL-3.0.
- Trafilatura: adbar/trafilatura, Apache-2.0.
- Defuddle benchmark adapter: kepano/defuddle, MIT.
- Mozilla Readability benchmark adapter: mozilla/readability, Apache-2.0.
- Turndown benchmark converter: mixmark-io/turndown, MIT.
- LinkeDOM benchmark DOM implementation: WebReflection/linkedom, ISC.
- Docling: docling-project/docling, MIT.
- TOON TypeScript implementation/specification: toon-format projects and their licenses.
- Tauri: tauri-apps/tauri, Apache-2.0/MIT.
- PinchTab remains an optional adapter target and retains its upstream license.

The workspace UI borrows protocol and interaction concepts, not bundled source, from the agent-browser dashboard in this initial implementation. Any later copied or adapted source must retain upstream notices.
