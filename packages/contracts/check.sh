#!/usr/bin/env bash
set -euo pipefail

exec uv run --no-project \
  --with 'jsonschema[format-nongpl]==4.25.1' \
  --with 'pyyaml==6.0.3' \
  --with 'referencing==0.36.2' \
  python "$(dirname "$0")/validate_contracts.py"
