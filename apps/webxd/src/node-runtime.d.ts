declare module "node:net" {
  export interface Socket {
    write(data: string): boolean;
    end(): void;
    destroy(error?: Error): void;
    on(event: "data", listener: (data: Uint8Array) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: () => void): this;
    once(event: "connect", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
  }
  export interface Server {
    listen(path: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export function createConnection(options: { path: string } | { host: string; port: number }): Socket;
  export function createServer(listener: (socket: Socket) => void): Server;
}
declare module "node:crypto" {
  export function randomBytes(size: number): { toString(encoding: "hex"): string };
  export function createHash(algorithm: "sha256"): { update(data: string | Uint8Array): { digest(encoding: "hex"): string } };
}
declare module "node:dns/promises" {
  export function lookup(hostname: string, options: { all: true; verbatim: true }): Promise<readonly { address: string; family: number }[]>;
}
declare module "node:fs/promises" {
  export function chmod(path: string, mode: number): Promise<void>;
  export function lstat(path: string): Promise<{ isSocket(): boolean }>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  export function unlink(path: string): Promise<void>;
  export function writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:process" {
  const process: {
    readonly pid: number;
    readonly env: Record<string, string | undefined>;
    cwd(): string;
    on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
    exitCode?: number;
  };
  export default process;
  export const pid: number;
}
