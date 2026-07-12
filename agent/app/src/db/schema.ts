import { createSchema, f } from "@pixel/db/schema";
import { z } from "zod";

const toolRow = z.object({
  toolId: z.string(),
  name: z.string(),
  detail: z.string(),
  status: z.enum(["running", "ok", "error"]),
  parentToolId: z.string().nullable(),
});

const itemRow = z.object({
  kind: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  tool: toolRow.nullable(),
});

const logEntry = z.object({
  at: z.number(),
  message: z.string(),
});

const sessionRow = z.object({
  id: z.string(),
  sdkSessionId: z.string().nullable(),
  createdAt: z.number(),
  title: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  costUsd: z.number(),
  // transcript from before the log collection existed; empty for new sessions
  items: z.array(itemRow),
  log: f.collection(logEntry),
});

export const schema = createSchema({
  sessions: f.array(sessionRow).default([]),
  activeSessionId: f.string().default(""),
});

export type SessionRow = z.infer<typeof sessionRow>;
export type ItemRow = z.infer<typeof itemRow>;
export type LogEntry = z.infer<typeof logEntry>;
export type AppShape = (typeof schema)["shape"];
