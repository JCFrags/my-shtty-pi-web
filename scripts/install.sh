#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
exec node "$HERE/install-manager.mjs" "$@"
