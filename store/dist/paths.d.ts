/** Layout of the shared ~/.pixel data directory. */
export declare const DATA_DIR: string;
export declare const LOGS_DIR: string;
export declare const FAVICONS_DIR: string;
export declare const INSTANCES_DIR: string;
export declare const DAEMON_SOCKET: string;
export declare const DB_FILE: string;
/** Data used to live in ~/.pixel-browser. Move it once, and leave a symlink
 * behind so tools that still write the old path land in the same place. */
export declare function ensureDataDir(): void;
