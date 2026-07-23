"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openStore = openStore;
exports.store = store;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_sqlite_1 = require("node:sqlite");
const sqlite_proxy_1 = require("drizzle-orm/sqlite-proxy");
const migrate_1 = require("./migrate");
const migrations_gen_1 = require("./migrations.gen");
const paths_1 = require("./paths");
const schema = __importStar(require("./schema"));
// node:sqlite instead of better-sqlite3 because the daemon runs inside
// electron and the cli under system node — two ABIs one compiled module
// can't serve, while node:sqlite ships in both runtimes.
function openStore(file = paths_1.DB_FILE) {
    if (file === paths_1.DB_FILE)
        (0, paths_1.ensureDataDir)();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    const sqlite = new node_sqlite_1.DatabaseSync(file);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    (0, migrate_1.migrate)(sqlite, migrations_gen_1.migrations);
    const db = (0, sqlite_proxy_1.drizzle)(async (sql, params, method) => {
        const stmt = sqlite.prepare(sql);
        const values = params;
        if (method === "run") {
            stmt.run(...values);
            return { rows: [] };
        }
        const rows = stmt.all(...values).map((row) => Object.values(row));
        return method === "get" ? { rows: rows[0] ?? [] } : { rows };
    }, { schema });
    return { sqlite, db };
}
let opened = null;
function store() {
    opened ??= openStore();
    return opened;
}
