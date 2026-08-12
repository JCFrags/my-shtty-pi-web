import { ResponseLimitError } from "./errors.js";
export class HttpTransport {
    options;
    #fetch;
    #retryCount;
    constructor(options) {
        this.options = options;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#retryCount = options.retryCount ?? 1;
    }
    async request(request) {
        let lastError;
        for (let attempt = 0; attempt <= this.#retryCount; attempt += 1) {
            try {
                const response = await this.#fetch(new URL(request.path, this.options.baseUrl), {
                    method: request.method,
                    headers: {
                        accept: "application/json",
                        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
                        ...(this.options.bearerToken === undefined ? {} : { authorization: `Bearer ${this.options.bearerToken}` }),
                        ...request.headers,
                    },
                    body: request.body === undefined ? undefined : JSON.stringify(request.body),
                    signal: request.signal,
                });
                const bytes = await readBoundedBody(response, request.maxResponseBytes);
                const text = new TextDecoder().decode(bytes);
                const contentType = response.headers.get("content-type") ?? "";
                const body = text.length === 0 ? undefined : contentType.includes("json") ? JSON.parse(text) : text;
                return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
            }
            catch (error) {
                if (request.signal?.aborted || error instanceof ResponseLimitError)
                    throw error;
                lastError = error;
                if (attempt === this.#retryCount)
                    break;
            }
        }
        throw lastError;
    }
}
async function readBoundedBody(response, limit) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit)
        throw new ResponseLimitError(limit);
    if (response.body === null)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done)
                break;
            size += result.value.byteLength;
            if (size > limit)
                throw new ResponseLimitError(limit);
            chunks.push(result.value);
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
export class UnixSocketTransport {
    socketPath;
    connect;
    actor;
    #binding;
    constructor(socketPath, connect, actor) {
        this.socketPath = socketPath;
        this.connect = connect;
        this.actor = actor;
    }
    async bind(ownerId, signal) {
        if (this.#binding !== undefined)
            return;
        const connection = await this.connect(this.socketPath);
        try {
            const line = await connection.send(JSON.stringify({ bind: { ownerId } }), signal);
            const response = JSON.parse(line);
            if (typeof response.bindingId !== "string" || typeof response.bindingSecret !== "string")
                throw new TypeError("invalid Unix actor binding response");
            this.#binding = { bindingId: response.bindingId, bindingSecret: response.bindingSecret };
        }
        finally {
            await connection.close();
        }
    }
    async request(request) {
        const connection = await this.connect(this.socketPath);
        try {
            const serializable = { ...request, signal: undefined };
            const wire = this.#binding === undefined ? this.actor === undefined ? serializable : { actor: this.actor, request: serializable } : { binding: this.#binding, request: serializable };
            const line = await connection.send(JSON.stringify(wire), request.signal);
            if (new TextEncoder().encode(line).byteLength > request.maxResponseBytes) {
                throw new ResponseLimitError(request.maxResponseBytes);
            }
            const response = JSON.parse(line);
            if (!Number.isInteger(response.status))
                throw new TypeError("invalid Unix transport response status");
            return response;
        }
        finally {
            await connection.close();
        }
    }
}
export class InProcessTransport {
    handler;
    constructor(handler) {
        this.handler = handler;
    }
    request(request) {
        return this.handler(request);
    }
}
