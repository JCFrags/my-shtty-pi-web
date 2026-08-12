#!/usr/bin/env python3
"""Import generated Python modules and check protected authority fields."""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from typing import get_type_hints

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "generated"
TRACE = json.loads((GENERATED / "traceability.json").read_text(encoding="utf-8"))
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(GENERATED))

for entry in TRACE["schemas"]:
    module_name = "python." + Path(entry["python"]).stem
    importlib.import_module(module_name)

engine = importlib.import_module("python.engine_observation")
observation_type = getattr(engine, "Engineobservation")
fields = get_type_hints(observation_type, include_extras=True)
for forbidden in ("accepted", "rejection_reasons"):
    if forbidden in fields:
        raise AssertionError(f"worker authority field was generated: {forbidden}")

normalized = importlib.import_module("python.normalized_content_result")
normalized_type = getattr(normalized, "Normalizedcontentresult")
normalized_fields = get_type_hints(normalized_type, include_extras=True)
for required in ("normalized_markdown", "raw_evidence", "trust"):
    if required not in normalized_fields:
        raise AssertionError(f"normalized-content field is absent: {required}")

intent = importlib.import_module("python.artifact_commit_intent")
intent_type = getattr(intent, "Artifactcommitintent")
intent_fields = get_type_hints(intent_type, include_extras=True)
for required in ("publication_idempotency_key", "quarantine_reason_code", "expected_files"):
    if required not in intent_fields:
        raise AssertionError(f"commit-intent field is absent: {required}")

print(f"VALID imported {len(TRACE['schemas'])} generated Python schema modules")
