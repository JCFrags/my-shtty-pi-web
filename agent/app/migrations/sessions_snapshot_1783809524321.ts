import type { KyjuMigration } from "@pixel/db"

const migration: KyjuMigration = {
  version: 2,
  operations: [
    {
      "op": "remove",
      "key": "items",
      "kind": "collection"
    },
    {
      "op": "alter",
      "key": "sessions",
      "changes": {
        "kindChanged": {
          "from": "collection",
          "to": "data"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // sessions changed kind from collection to data; the old collection rows
    // used a different shape, so start the array field empty.
    result.sessions = []
    return result
  },
}

export default migration
