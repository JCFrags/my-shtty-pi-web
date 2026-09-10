#!/usr/bin/env bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != 1 || -z "${HERDR_WORKSPACE_ID:-}" || -z "${HERDR_TAB_ID:-}" || -z "${HERDR_PANE_ID:-}" ]]; then
  echo "Select a Pi pane before opening its browser companion." >&2
  exit 1
fi

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$plugin_dir/.." && pwd -P)"
pane_json="$("${HERDR_BIN_PATH:-herdr}" pane get "$HERDR_PANE_ID")"
project_dir="$(node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const p=JSON.parse(s).result?.pane; process.stdout.write(p?.foreground_cwd || p?.cwd || ""); });' <<<"$pane_json")"
if [[ -z "$project_dir" || "$project_dir" != /* ]]; then
  echo "Could not determine the selected Pi pane project directory." >&2
  exit 1
fi

export TERMINAL_BROWSER_OWNER_WORKSPACE_ID="$HERDR_WORKSPACE_ID"
export TERMINAL_BROWSER_OWNER_TAB_ID="$HERDR_TAB_ID"
export TERMINAL_BROWSER_OWNER_PANE_ID="$HERDR_PANE_ID"
export TERMINAL_BROWSER_OWNER_PROJECT_DIR="$project_dir"
exec bash "$root/herdr-plugin/launch.sh" companion open
