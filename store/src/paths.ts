import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();


function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");

const RUNTIME_HOME = process.env.XDG_RUNTIME_DIR ?? STATE_HOME;

export const DATA_DIR = path.join(DATA_HOME, "pixel");
export const LOGS_DIR = path.join(STATE_HOME, "pixel", "logs");
export const FAVICONS_DIR = path.join(CACHE_HOME, "pixel", "favicons");
export const INSTANCES_DIR = path.join(RUNTIME_HOME, "pixel", "instances");
export const AGENT_SOCKETS_DIR = path.join(RUNTIME_HOME, "pixel", "agent-browser");
export const DAEMON_SOCKET = path.join(RUNTIME_HOME, "pixel", "daemon.sock");
export const DB_FILE = path.join(DATA_DIR, "pixel.db");

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
