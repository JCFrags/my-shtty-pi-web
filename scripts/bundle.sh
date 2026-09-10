#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/node_modules/.bin/esbuild" "$1" \
  --bundle --platform=node --format=cjs \
  --external:electron '--external:*.node' \
  --alias:pixel-react="$ROOT/engine/packages/pixel-react/src/index.ts" \
  --alias:pixel-terminals="$ROOT/terminals/src/index.ts" \
  --alias:pixel-store="$ROOT/store/src/index.ts" \
  --define:process.env.NODE_ENV='"production"' \
  --define:process.env.WS_NO_BUFFER_UTIL='"1"' \
  --define:process.env.WS_NO_UTF_8_VALIDATE='"1"' \
  --metafile="$2.meta.json" \
  --sourcemap --outfile="$2" --log-level=warning

printf '{"type":"commonjs"}\n' > "$(dirname "$2")/package.json"
