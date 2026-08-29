# AgentCursor selective port

This spike selectively ports the MIT-licensed path engine and persona code from AgentCursor 0.3.0.

- Upstream: https://github.com/kumard3/agentcursor
- Pinned commit: `b23c633c66fd240f836f5edd1034f6fcf678e237`
- Upstream version: `0.3.0`
- Ported source: `src/path-engine/*`, `src/persona/index.ts`, and `src/persona/typing.ts`
- Local location: `src/agentcursor/`

The local protocol types are reduced to the types that the port needs. The implementation stays otherwise close to upstream. The spike does not include AgentCursor MCP, its Chrome extension, its stock drivers, or its SDK facade.

See `LICENSE` in this directory and `docs/browser-rebuild/AGENTCURSOR-ASSESSMENT.md`.
