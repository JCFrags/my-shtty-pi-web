export type DbTable = "sessions" | "logs" | "app_state";

type Listener = (tables: readonly DbTable[]) => void;

const listeners = new Set<Listener>();

export function onDbWrite(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function touched(...tables: DbTable[]): void {
  for (const listener of listeners) listener(tables);
}
