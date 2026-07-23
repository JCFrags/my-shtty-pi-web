import type { DatabaseSync } from "node:sqlite";
export interface Migration {
    id: string;
    statements: string[];
}
export declare function migrate(sqlite: DatabaseSync, migrations: Migration[]): void;
