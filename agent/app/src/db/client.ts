import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { touched } from "./invalidate";
import { migrate } from "./migrate";
import { migrations } from "./migrations.gen";
import * as schema from "./schema";
import type { LogEntry } from "./schema";

export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite, migrations);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("no package.json above " + import.meta.url);
    dir = parent;
  }
  return dir;
}

const dataDir = process.env.AGENT_DATA_DIR ?? path.join(packageRoot(), ".data");
const connection = openDb(path.join(dataDir, "agent.db"));

export const db = connection.db;

export function closeDb(): void {
  connection.sqlite.close();
}

export function createSession(row: { id: string; createdAt: number }): void {
  db.insert(schema.sessions).values(row).onConflictDoNothing().run();
  touched("sessions");
}

export function appendLog(sessionId: string, entry: LogEntry): void {
  db.insert(schema.logs).values({ sessionId, ...entry }).run();
  touched("logs");
}
