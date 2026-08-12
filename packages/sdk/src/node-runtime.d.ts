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
  export function createConnection(options: { path: string }): Socket;
}
