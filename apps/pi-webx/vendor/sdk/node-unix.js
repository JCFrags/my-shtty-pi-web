import { createConnection } from "node:net";
const MAX_LINE_BYTES = 2_097_152;
/** Create one real same-user Unix NDJSON connection for WebX transport use. */
export const nodeNdjsonConnectionFactory = async (socketPath) => {
    const socket = createConnection({ path: socketPath });
    await connected(socket);
    return new NodeNdjsonConnection(socket);
};
class NodeNdjsonConnection {
    socket;
    #closed = false;
    #used = false;
    constructor(socket) {
        this.socket = socket;
    }
    send(line, signal) {
        if (this.#closed || this.#used)
            return Promise.reject(new Error("Unix NDJSON connection is not available"));
        this.#used = true;
        return new Promise((resolve, reject) => {
            let buffered = "";
            let settled = false;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener("abort", aborted);
                if (error === undefined && value !== undefined)
                    resolve(value);
                else
                    reject(error ?? new Error("Unix NDJSON connection closed without a response"));
            };
            const aborted = () => { this.socket.destroy(); finish(new DOMException("request was cancelled", "AbortError")); };
            if (signal?.aborted) {
                aborted();
                return;
            }
            signal?.addEventListener("abort", aborted, { once: true });
            this.socket.on("data", (chunk) => {
                buffered += new TextDecoder().decode(chunk, { stream: true });
                if (new TextEncoder().encode(buffered).byteLength > MAX_LINE_BYTES) {
                    this.socket.destroy();
                    finish(new Error("Unix NDJSON response line is too large"));
                    return;
                }
                const newline = buffered.indexOf("\n");
                if (newline >= 0)
                    finish(undefined, buffered.slice(0, newline));
            });
            this.socket.on("error", (error) => finish(error));
            this.socket.on("close", () => finish());
            this.socket.write(`${line}\n`);
        });
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.socket.end();
    }
}
function connected(socket) {
    return new Promise((resolve, reject) => {
        const failed = (error) => reject(error);
        socket.once("error", failed);
        socket.once("connect", () => { socket.off("error", failed); resolve(); });
    });
}
