"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertInstance = upsertInstance;
exports.removeInstance = removeInstance;
exports.listInstances = listInstances;
const node_fs_1 = __importDefault(require("node:fs"));
const drizzle_orm_1 = require("drizzle-orm");
const client_1 = require("./client");
const schema_1 = require("./schema");
async function upsertInstance(row) {
    const { key, ...rest } = row;
    await (0, client_1.store)()
        .db.insert(schema_1.instances)
        .values(row)
        .onConflictDoUpdate({ target: schema_1.instances.key, set: rest });
}
async function removeInstance(key) {
    await (0, client_1.store)().db.delete(schema_1.instances).where((0, drizzle_orm_1.eq)(schema_1.instances.key, key));
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Live instances oldest-first, pruning rows whose process died without
 * cleaning up after itself. */
async function listInstances() {
    const rows = await (0, client_1.store)().db.select().from(schema_1.instances);
    const live = [];
    for (const row of rows) {
        if (alive(row.pid)) {
            live.push(row);
            continue;
        }
        await removeInstance(row.key);
        node_fs_1.default.rmSync(row.socket, { force: true });
    }
    return live.sort((a, b) => a.startedAt - b.startedAt);
}
