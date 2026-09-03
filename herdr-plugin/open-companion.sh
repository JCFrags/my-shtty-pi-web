#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
args=(open --no-merge)
if [[ -n "${TERMINAL_BROWSER_COMPANION_URL:-}" ]]; then
  args=(open "$TERMINAL_BROWSER_COMPANION_URL" --no-merge)
fi
exec node "$root/cli/dist/main.js" "${args[@]}"
