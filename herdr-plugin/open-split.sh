#!/usr/bin/env bash
set -euo pipefail
plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$plugin_dir/.." && pwd -P)"
exec bash "$root/herdr-plugin/launch.sh" open --split right
