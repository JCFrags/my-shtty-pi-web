import type { KyjuMigration } from "@pixel/db"
import { makeCollection } from "@pixel/db/schema"

const migration: KyjuMigration = {
  version: 3,
  operations: [
    {
      "op": "alter",
      "key": "sessions",
      "changes": {
        "typeHash": {
          "from": "2fa2db4e1f91c865",
          "to": "6953c3e0ea37cc20"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    result.sessions = (result.sessions ?? []).map((row: any) => ({
      ...row,
      title: row.items?.find((item: any) => item.kind === "user")?.text ?? "",
      log: makeCollection(`log-${row.id}`),
    }))
    return result
  },
}

export default migration
