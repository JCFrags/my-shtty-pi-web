import { getDb } from "./index";
import type { ItemRow, SessionRow } from "./schema";
import { Session, store, type Item, type ToolCall } from "../session";

function flattenItems(items: Item[]): ItemRow[] {
  const rows: ItemRow[] = [];
  const emitTool = (call: ToolCall, parentToolId: string | null) => {
    rows.push({
      kind: "tool",
      text: "",
      tool: {
        toolId: call.id,
        name: call.name,
        detail: call.detail,
        status: call.status,
        parentToolId,
      },
    });
    for (const kid of call.kids) emitTool(kid, call.id);
  };
  for (const item of items) {
    if (item.kind === "tool") emitTool(item.call, null);
    else rows.push({ kind: item.kind, text: item.text, tool: null });
  }
  return rows;
}

function rebuildItems(rows: ItemRow[]): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, ToolCall>();
  for (const row of rows) {
    if (row.kind !== "tool" || !row.tool) {
      if (row.kind !== "tool") items.push({ kind: row.kind, text: row.text });
      continue;
    }
    const call: ToolCall = {
      id: row.tool.toolId,
      name: row.tool.name,
      detail: row.tool.detail,
      input: {},
      status: row.tool.status,
      kids: [],
    };
    calls.set(call.id, call);
    const parent = row.tool.parentToolId ? calls.get(row.tool.parentToolId) : undefined;
    if (parent) parent.kids.push(call);
    else items.push({ kind: "tool", call });
  }
  return items;
}

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
      items: flattenItems(s.legacyItems),
      log: s.logRef,
    })),
    activeSessionId: store.active()?.dbId ?? "",
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

function write(): Promise<void> {
  const snap = snapshotSessions();
  writing = getDb()
    .then(async ({ client }) => {
      await client.sessions.set(snap.sessions);
      await client.activeSessionId.set(snap.activeSessionId);
    })
    .catch((error) => {
      console.error("failed to persist sessions", error);
    });
  return writing;
}

export function schedulePersist(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void write();
  }, 300);
}

export async function flushPersist(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await write();
  const { flush } = await getDb();
  await flush();
}

export async function hydrateStore(): Promise<void> {
  const { client } = await getDb();
  const rows = client.sessions.read();
  const activeId = client.activeSessionId.read();
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
        items: rebuildItems(row.items),
        log: row.log,
      }),
    );
  }
  const at = store.sessions.findIndex((s) => s.dbId === activeId);
  if (at >= 0) store.at = at;
  if (store.sessions.length === 0) store.add();
  store.notify();
}
