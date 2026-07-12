import { useQuery } from "@tanstack/react-query";
import { eq } from "drizzle-orm";

import { db } from "./client";
import { logs } from "./schema";
import type { LogEntry } from "./schema";

export const keys = {
  sessions: ["sessions"] as const,
  appState: ["app_state"] as const,
  logs: {
    all: ["logs"] as const,
    bySession: (sessionId: string) => ["logs", "session", sessionId] as const,
  },
};

function readSessionLog(sessionId: string): LogEntry[] {
  return db
    .select({ at: logs.at, message: logs.message })
    .from(logs)
    .where(eq(logs.sessionId, sessionId))
    .orderBy(logs.id)
    .all();
}

export function useSessionLog(sessionId: string): readonly LogEntry[] {
  const query = useQuery({
    queryKey: keys.logs.bySession(sessionId),
    queryFn: () => readSessionLog(sessionId),
    initialData: () => readSessionLog(sessionId),
  });
  return query.data;
}
