import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-smoke-"));
process.env.AGENT_DATA_DIR = dataDir;

const { appendLog, closeDb, createSession, db, openDb } = await import("../src/db/client");
const { migrate } = await import("../src/db/migrate");
const { migrations } = await import("../src/db/migrations.gen");
const { logs, sessions } = await import("../src/db/schema");
const { asc, eq } = await import("drizzle-orm");

const file = path.join(dataDir, "agent.db");
assert.ok(fs.existsSync(file), "db file created in AGENT_DATA_DIR");

const appliedIds = db.all<{ id: string }>(
  (await import("drizzle-orm")).sql`SELECT id FROM migration ORDER BY id`,
);
assert.deepEqual(
  appliedIds.map((row) => row.id),
  migrations.map((m) => m.id).sort(),
  "all embedded migrations recorded",
);

createSession({ id: "smoke", createdAt: 1 });
appendLog("smoke", { at: 10, message: "one" });
appendLog("smoke", { at: 11, message: "two" });
appendLog("smoke", { at: 12, message: "three" });

const entries = db
  .select({ at: logs.at, message: logs.message })
  .from(logs)
  .where(eq(logs.sessionId, "smoke"))
  .orderBy(asc(logs.id))
  .all();
assert.deepEqual(
  entries,
  [
    { at: 10, message: "one" },
    { at: 11, message: "two" },
    { at: 12, message: "three" },
  ],
  "log entries read back in insert order",
);

const orphan = () => appendLog("no-such-session", { at: 1, message: "x" });
assert.throws(orphan, /FOREIGN KEY/, "foreign keys enforced");

closeDb();

const reopened = openDb(file);
const count = reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM migration").get() as { n: number };
assert.equal(count.n, migrations.length, "reopen applies nothing new");
const rows = reopened.db.select().from(sessions).all();
assert.equal(rows.length, 1, "data survives reopen");
reopened.sqlite.prepare("INSERT INTO migration (id, time_completed) VALUES (?, ?)").run("9999_from_the_future", 1);
assert.throws(
  () => migrate(reopened.sqlite, migrations),
  /newer version/,
  "downgrade guard refuses unknown migration ids",
);
reopened.sqlite.close();

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("db smoke: all assertions passed");
