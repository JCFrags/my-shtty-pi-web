import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, createDb, createReplica, type ClientProxy } from "@pixel/db";

import { migrations } from "../../migrations";
import { schema, type AppShape, type LogEntry } from "./schema";

export type Db = Awaited<ReturnType<typeof createDb<AppShape>>>;
export type Client = ClientProxy<AppShape>;
export type Replica = ReturnType<typeof createReplica>;

export type DbConnection = {
  client: Client;
  replica: Replica;
  flush: () => Promise<void>;
  close: () => Promise<void>;
};

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_DATA_DIR = path.join(APP_DIR, ".data/agent-db");

let shared: Promise<DbConnection> | null = null;
let resolved: DbConnection | null = null;

export function getDb(): Promise<DbConnection> {
  return (shared ??= initDb().then((conn) => (resolved = conn)));
}

export function getDbSync(): DbConnection | null {
  return resolved;
}

export async function appendLog(collectionId: string, entry: LogEntry): Promise<void> {
  const { replica } = await getDb();
  await replica.postMessage({
    kind: "write",
    op: { type: "collection.concat", collectionId, data: [entry] },
  });
}

export async function initDb(dataDir = DEFAULT_DATA_DIR): Promise<DbConnection> {
  const replica = createReplica({
    send: (event) => db.postMessage(event),
    maxPageSizeBytes: 1024 * 1024,
  });
  const db = await createDb({
    path: dataDir,
    schema,
    migrations,
    send: (event) => replica.postMessage(event),
  });
  await replica.postMessage({ kind: "connect", version: 0 });
  const client = createClient<AppShape>(replica);
  return {
    client,
    replica,
    flush: () => db.flush(),
    close: () => db.close(),
  };
}
