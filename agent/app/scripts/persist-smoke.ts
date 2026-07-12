import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-persist-smoke-"));
process.env.AGENT_DATA_DIR = dataDir;

const { Session, store } = await import("../src/session");
const { flushPersist, hydrateStore } = await import("../src/db/persist");
const { appendLog, closeDb } = await import("../src/db/client");

const restored = (dbId: string, title: string, createdAt: number) =>
  new Session(store.notify, {
    dbId,
    sdkSessionId: null,
    createdAt,
    title,
    model: "test-model",
    permissionMode: "default",
    costUsd: 0.25,
    items: [{ kind: "user", text: "hi" }],
  });

store.sessions.push(restored("s1", "first", 100), restored("s2", "second", 200));
store.at = 1;
flushPersist();

appendLog("s2", { at: 1, message: JSON.stringify({ type: "app_error", text: "smoke" }) });

store.sessions[0].firstUserText = "renamed";
flushPersist();

store.sessions.length = 0;
store.at = 0;
hydrateStore();

assert.equal(store.sessions.length, 2, "both sessions hydrate");
assert.deepEqual(
  store.sessions.map((s) => s.firstUserText),
  ["renamed", "second"],
  "upsert updated the renamed title",
);
assert.equal(store.active().dbId, "s2", "active session restored");
assert.equal(store.sessions[0].legacyItems.length, 1, "items json round-trips");
assert.equal(store.sessions[0].cost, 0.25, "cost round-trips");

flushPersist();
closeDb();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("persist smoke: all assertions passed");
