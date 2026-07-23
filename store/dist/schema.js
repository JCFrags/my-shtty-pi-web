"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appState = exports.instances = void 0;
const sqlite_core_1 = require("drizzle-orm/sqlite-core");
exports.instances = (0, sqlite_core_1.sqliteTable)("instances", {
    /** unique per pane: the pid for dedicated processes, pid-session for daemon sessions */
    key: (0, sqlite_core_1.text)("key").primaryKey(),
    pid: (0, sqlite_core_1.integer)("pid").notNull(),
    tty: (0, sqlite_core_1.text)("tty"),
    socket: (0, sqlite_core_1.text)("socket").notNull(),
    cdpPort: (0, sqlite_core_1.integer)("cdp_port"),
    url: (0, sqlite_core_1.text)("url").notNull().default(""),
    title: (0, sqlite_core_1.text)("title").notNull().default(""),
    favicon: (0, sqlite_core_1.text)("favicon"),
    loading: (0, sqlite_core_1.integer)("loading", { mode: "boolean" }).notNull().default(false),
    canGoBack: (0, sqlite_core_1.integer)("can_go_back", { mode: "boolean" }).notNull().default(false),
    canGoForward: (0, sqlite_core_1.integer)("can_go_forward", { mode: "boolean" }).notNull().default(false),
    findMatches: (0, sqlite_core_1.text)("find_matches", { mode: "json" }).$type(),
    zoom: (0, sqlite_core_1.real)("zoom").notNull().default(1),
    tabs: (0, sqlite_core_1.text)("tabs", { mode: "json" }).$type(),
    viewport: (0, sqlite_core_1.text)("viewport", { mode: "json" }).$type(),
    startedAt: (0, sqlite_core_1.integer)("started_at").notNull(),
});
exports.appState = (0, sqlite_core_1.sqliteTable)("app_state", {
    key: (0, sqlite_core_1.text)("key").primaryKey(),
    value: (0, sqlite_core_1.text)("value").notNull(),
});
