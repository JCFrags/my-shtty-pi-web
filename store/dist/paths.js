"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB_FILE = exports.DAEMON_SOCKET = exports.INSTANCES_DIR = exports.FAVICONS_DIR = exports.LOGS_DIR = exports.DATA_DIR = void 0;
exports.ensureDataDir = ensureDataDir;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
/** Layout of the shared ~/.pixel data directory. */
exports.DATA_DIR = node_path_1.default.join(node_os_1.default.homedir(), ".pixel");
exports.LOGS_DIR = node_path_1.default.join(exports.DATA_DIR, "logs");
exports.FAVICONS_DIR = node_path_1.default.join(exports.DATA_DIR, "favicons");
exports.INSTANCES_DIR = node_path_1.default.join(exports.DATA_DIR, "instances");
exports.DAEMON_SOCKET = node_path_1.default.join(exports.DATA_DIR, "daemon.sock");
exports.DB_FILE = node_path_1.default.join(exports.DATA_DIR, "pixel.db");
const LEGACY_DATA_DIR = node_path_1.default.join(node_os_1.default.homedir(), ".pixel-browser");
/** Data used to live in ~/.pixel-browser. Move it once, and leave a symlink
 * behind so tools that still write the old path land in the same place. */
function ensureDataDir() {
    try {
        if (!node_fs_1.default.existsSync(exports.DATA_DIR) && node_fs_1.default.lstatSync(LEGACY_DATA_DIR).isDirectory()) {
            node_fs_1.default.renameSync(LEGACY_DATA_DIR, exports.DATA_DIR);
            node_fs_1.default.symlinkSync(exports.DATA_DIR, LEGACY_DATA_DIR);
        }
    }
    catch { }
    node_fs_1.default.mkdirSync(exports.DATA_DIR, { recursive: true });
}
