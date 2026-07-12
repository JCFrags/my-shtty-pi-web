import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export interface LogEntry {
  at: number;
  message: string;
}

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  sdkSessionId: text("sdk_session_id"),
  createdAt: integer("created_at").notNull(),
  title: text("title").notNull().default(""),
  model: text("model").notNull().default(""),
  permissionMode: text("permission_mode").notNull().default("default"),
  costUsd: real("cost_usd").notNull().default(0),
});

export const logs = sqliteTable(
  "logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    message: text("message").notNull(),
  },
  (t) => [index("logs_session_idx").on(t.sessionId, t.id)],
);

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
