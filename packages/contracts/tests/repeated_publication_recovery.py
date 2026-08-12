#!/usr/bin/env python3
"""Exercise repeated publication recovery across an SQLite restart boundary."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[1]
SEMANTICS: Final = ROOT / "semantics" / "artifact-commit-intent-semantics.json"
INTENT_ID: Final = "01j4w4j9a3jpsk9r7jcrg29q01"
INTENT_KEY: Final = "page-version:01j4w4j7mr6c9s7cezz9n5f2qp"
PUBLICATION_KEY: Final = f"commit-intent:{INTENT_ID}"

EFFECTS: Final = {
    "visit_receipt": ("visit_receipts", "01j4w4j0k7hm9j9tx3jz8s2n5q"),
    "page_version": ("page_versions", "01j4w4j7mr6c9s7cezz9n5f2qp"),
    "artifact": ("artifacts", "01j4w4j8v3wx04ssprfy0dnt80"),
    "index_projection": ("index_outbox", "01j4w4j9a3jpsk9r7jcrg29q02"),
    "wiki_delivery": ("wiki_outbox", "01j4w4j9a3jpsk9r7jcrg29q03"),
}


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE commit_intents (
            commit_intent_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            publication_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('prepared','renamed','published','completed'))
        ) STRICT;

        CREATE TABLE visit_receipts (
            effect_id TEXT PRIMARY KEY,
            publication_key TEXT NOT NULL UNIQUE REFERENCES commit_intents(publication_key)
        ) STRICT;
        CREATE TABLE page_versions (
            effect_id TEXT PRIMARY KEY,
            publication_key TEXT NOT NULL UNIQUE REFERENCES commit_intents(publication_key)
        ) STRICT;
        CREATE TABLE artifacts (
            effect_id TEXT PRIMARY KEY,
            publication_key TEXT NOT NULL UNIQUE REFERENCES commit_intents(publication_key)
        ) STRICT;
        CREATE TABLE index_outbox (
            effect_id TEXT PRIMARY KEY,
            publication_key TEXT NOT NULL UNIQUE REFERENCES commit_intents(publication_key)
        ) STRICT;
        CREATE TABLE wiki_outbox (
            effect_id TEXT PRIMARY KEY,
            publication_key TEXT NOT NULL UNIQUE REFERENCES commit_intents(publication_key)
        ) STRICT;
        """
    )


def publish_before_crash(connection: sqlite3.Connection) -> None:
    """Commit all effects and published state, but do not complete the intent."""
    with connection:
        connection.execute(
            "INSERT INTO commit_intents VALUES (?, ?, ?, 'published')",
            (INTENT_ID, INTENT_KEY, PUBLICATION_KEY),
        )
        for table, effect_id in EFFECTS.values():
            connection.execute(
                f"INSERT INTO {table} (effect_id, publication_key) VALUES (?, ?)",
                (effect_id, PUBLICATION_KEY),
            )


def replay_recovery(connection: sqlite3.Connection) -> dict[str, str]:
    """Replay publication with stable keys, then complete or read the terminal result."""
    observed: dict[str, str] = {}
    with connection:
        row = connection.execute(
            "SELECT state, publication_key FROM commit_intents WHERE idempotency_key = ?",
            (INTENT_KEY,),
        ).fetchone()
        if row is None or row[1] != PUBLICATION_KEY:
            raise AssertionError("recovery did not find the stable intent publication key")
        if row[0] not in {"published", "completed"}:
            raise AssertionError(f"unexpected recovery state: {row[0]}")

        for effect_kind, (table, effect_id) in EFFECTS.items():
            connection.execute(
                f"""
                INSERT INTO {table} (effect_id, publication_key) VALUES (?, ?)
                ON CONFLICT(publication_key) DO NOTHING
                """,
                (effect_id, PUBLICATION_KEY),
            )
            effect_row = connection.execute(
                f"SELECT effect_id, publication_key FROM {table} WHERE publication_key = ?",
                (PUBLICATION_KEY,),
            ).fetchone()
            if effect_row != (effect_id, PUBLICATION_KEY):
                raise AssertionError(f"{effect_kind} changed identity during recovery")
            observed[effect_kind] = effect_row[0]

        if row[0] == "published":
            connection.execute(
                "UPDATE commit_intents SET state = 'completed' WHERE commit_intent_id = ?",
                (INTENT_ID,),
            )
    return observed


def assert_one_stable_effect(connection: sqlite3.Connection) -> None:
    intent = connection.execute(
        "SELECT state, publication_key FROM commit_intents WHERE commit_intent_id = ?",
        (INTENT_ID,),
    ).fetchone()
    if intent != ("completed", PUBLICATION_KEY):
        raise AssertionError(f"intent did not complete with its stable key: {intent}")

    for effect_kind, (table, effect_id) in EFFECTS.items():
        rows = connection.execute(
            f"SELECT effect_id, publication_key FROM {table} ORDER BY effect_id"
        ).fetchall()
        if rows != [(effect_id, PUBLICATION_KEY)]:
            raise AssertionError(f"{effect_kind} was duplicated or changed: {rows}")


def main() -> int:
    semantics = json.loads(SEMANTICS.read_text(encoding="utf-8"))
    machine_effects = semantics["recovery_idempotency"]["forbid_duplicate_effects"]
    if machine_effects != list(EFFECTS):
        raise AssertionError(
            f"machine duplicate-effect list does not match harness: {machine_effects}"
        )

    with tempfile.TemporaryDirectory(prefix="webx-intent-recovery-") as directory:
        database = Path(directory) / "recovery.sqlite3"
        connection = connect(database)
        initialize(connection)
        publish_before_crash(connection)
        state = connection.execute(
            "SELECT state FROM commit_intents WHERE commit_intent_id = ?", (INTENT_ID,)
        ).fetchone()
        if state != ("published",):
            raise AssertionError("crash boundary must be after publication and before completion")
        connection.close()

        replays: list[dict[str, str]] = []
        for _ in range(2):
            connection = connect(database)
            replays.append(replay_recovery(connection))
            connection.close()

        connection = connect(database)
        assert_one_stable_effect(connection)
        connection.close()

    if replays[0] != replays[1] or replays[0] != {
        effect_kind: effect_id for effect_kind, (_, effect_id) in EFFECTS.items()
    }:
        raise AssertionError(f"recovery did not return stable effect IDs: {replays}")

    print(
        "VALID repeated publication recovery: restart boundary, two replays, "
        "five effects, one stable row and ID per publication key"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
