#!/usr/bin/env bash
set -euo pipefail

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$plugin_dir/.." && pwd -P)"
args=(open --no-merge)
if [[ -n "${TERMINAL_BROWSER_COMPANION_URL:-}" ]]; then
  args=(open "$TERMINAL_BROWSER_COMPANION_URL" --no-merge)
fi
exec bash "$root/herdr-plugin/launch.sh" "${args[@]}"
