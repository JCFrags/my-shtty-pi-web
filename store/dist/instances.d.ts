import type { InstanceRow, NewInstanceRow } from "./schema";
export declare function upsertInstance(row: NewInstanceRow): Promise<void>;
export declare function removeInstance(key: string): Promise<void>;
/** Live instances oldest-first, pruning rows whose process died without
 * cleaning up after itself. */
export declare function listInstances(): Promise<InstanceRow[]>;
