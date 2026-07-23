import { DatabaseSync } from "node:sqlite";
import * as schema from "./schema";
export type Store = ReturnType<typeof openStore>;
export declare function openStore(file?: string): {
    sqlite: DatabaseSync;
    db: import("drizzle-orm/sqlite-proxy").SqliteRemoteDatabase<typeof schema>;
};
export declare function store(): Store;
