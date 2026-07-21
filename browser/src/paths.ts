import os from "node:os";
import path from "node:path";

/** Layout of the shared ~/.pixel-browser data directory. The cli package
 * hardcodes the same locations, so changes here must be mirrored there. */
export const DATA_DIR = path.join(os.homedir(), ".pixel-browser");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const FAVICONS_DIR = path.join(DATA_DIR, "favicons");
export const INSTANCES_DIR = path.join(DATA_DIR, "instances");
export const LAST_URL_FILE = path.join(DATA_DIR, "last-url");
export const DAEMON_SOCKET = path.join(DATA_DIR, "daemon.sock");
