# AgentCursor selective port

This package selectively ports MIT-licensed path and persona code from AgentCursor 0.3.0.

- Repository: https://github.com/kumard3/agentcursor
- Commit: `b23c633c66fd240f836f5edd1034f6fcf678e237`
- Version: `0.3.0`
- Vendored source SHA-256: `b37f058d396229cdcc5027a2eba9eb4b4679c1d8b197ce7fbd413073609c47f9`
- Upstream paths: `src/path-engine/*`, `src/persona/index.ts`, and `src/persona/typing.ts`
- Local paths: `src/vendor/agentcursor/path-engine/*`, `src/vendor/agentcursor/persona/*`

Local changes replace the upstream protocol import with the minimal local types in `src/vendor/agentcursor/protocol.ts`. No MCP, extension, stock transport, macOS driver, or SDK facade is included.

To update, review the pinned upstream diff, copy only these source files, keep the local protocol adapter, run the deterministic motor tests, review the license, and update this file with the new exact commit and modifications.
