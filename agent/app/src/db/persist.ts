import { eq } from "drizzle-orm";

import { db } from "./client";
import { touched } from "./invalidate";
import { appState, sessions } from "./schema";
import type { SessionRow } from "./schema";
import { Session, store } from "../session";

function snapshotSessions(): { sessions: SessionRow[]; activeSessionId: string } {
  return {
    sessions: store.sessions.map((s) => ({
      id: s.dbId,
      sdkSessionId: s.sdkSessionId,
      createdAt: s.createdAt,
      title: s.firstUserText,
      model: s.model,
      permissionMode: s.mode,
      costUsd: s.cost,
    })),
    activeSessionId: store.active()?.dbId ?? "",
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;

function write(): void {
  const snap = snapshotSessions();
  try {
    db.transaction((tx) => {
      for (const row of snap.sessions) {
        tx.insert(sessions)
          .values(row)
          .onConflictDoUpdate({
            target: sessions.id,
            set: {
              sdkSessionId: row.sdkSessionId,
              title: row.title,
              model: row.model,
              permissionMode: row.permissionMode,
              costUsd: row.costUsd,
            },
          })
          .run();
      }
      tx.insert(appState)
        .values({ key: "activeSessionId", value: snap.activeSessionId })
        .onConflictDoUpdate({ target: appState.key, set: { value: snap.activeSessionId } })
        .run();
    });
  } catch (error) {
    console.error("failed to persist sessions", error);
    return;
  }
  touched("sessions", "app_state");
}

export function schedulePersist(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    write();
  }, 300);
}

export function flushPersist(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  write();
}

export function hydrateStore(): void {
  const rows = db.select().from(sessions).orderBy(sessions.createdAt).all();
  const active = db.select().from(appState).where(eq(appState.key, "activeSessionId")).get();
  for (const row of rows) {
    store.sessions.push(
      new Session(store.notify, {
        dbId: row.id,
        sdkSessionId: row.sdkSessionId,
        createdAt: row.createdAt,
        title: row.title,
        model: row.model,
        permissionMode: row.permissionMode,
        costUsd: row.costUsd,
      }),
    );
  }
  const at = store.sessions.findIndex((s) => s.dbId === active?.value);
  if (at >= 0) store.at = at;
  if (store.sessions.length === 0) store.add();
  store.notify();
}
