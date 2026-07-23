import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = path.join(os.homedir(), ".pixel");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const FAVICONS_DIR = path.join(DATA_DIR, "favicons");
export const INSTANCES_DIR = path.join(DATA_DIR, "instances");
export const DAEMON_SOCKET = path.join(DATA_DIR, "daemon.sock");
export const DB_FILE = path.join(DATA_DIR, "pixel.db");

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
