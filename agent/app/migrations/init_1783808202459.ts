import type { KyjuMigration } from "@pixel/db"

const migration: KyjuMigration = {
  version: 1,
  operations: [
    {
      "op": "add",
      "key": "sessions",
      "kind": "collection",
      "debugName": "sessions"
    },
    {
      "op": "add",
      "key": "items",
      "kind": "collection",
      "debugName": "items"
    },
    {
      "op": "add",
      "key": "activeSessionId",
      "kind": "data",
      "hasDefault": true,
      "default": ""
    }
  ],
}

export default migration
