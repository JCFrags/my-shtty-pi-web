"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lastUrl = lastUrl;
exports.setLastUrl = setLastUrl;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const client_1 = require("./client");
const paths_1 = require("./paths");
// Sync on purpose: node:sqlite is synchronous underneath, and callers like
// the browser session constructor cannot await.
function getAppState(key) {
    const row = (0, client_1.store)()
        .sqlite.prepare("SELECT value FROM app_state WHERE key = ?")
        .get(key);
    return row?.value ?? null;
}
function setAppState(key, value) {
    (0, client_1.store)()
        .sqlite.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
}
const LEGACY_LAST_URL_FILE = node_path_1.default.join(paths_1.DATA_DIR, "last-url");
function lastUrl() {
    const stored = getAppState("last-url");
    if (stored !== null)
        return stored;
    try {
        const legacy = node_fs_1.default.readFileSync(LEGACY_LAST_URL_FILE, "utf8").trim();
        node_fs_1.default.rmSync(LEGACY_LAST_URL_FILE, { force: true });
        if (legacy) {
            setAppState("last-url", legacy);
            return legacy;
        }
    }
    catch { }
    return null;
}
function setLastUrl(url) {
    setAppState("last-url", url);
}
