#!/usr/bin/env bash
set -euo pipefail

contract_root=$(dirname "$0")

uv run --no-project \
  --with 'jsonschema[format-nongpl]==4.25.1' \
  --with 'pyyaml==6.0.3' \
  --with 'referencing==0.36.2' \
  python "$contract_root/validate_contracts.py"

uv run --no-project \
  --with 'pyyaml==6.0.3' \
  python "$contract_root/validate_openapi.py"

python "$contract_root/tests/shipped_route_inventory.py"
python "$contract_root/tests/repeated_publication_recovery.py"
python "$contract_root/tests/generated/check_generated.py"
uv run --no-project \
  --with 'pyyaml==6.0.3' \
  python "$contract_root/tests/generated/check_openapi_generated.py"
