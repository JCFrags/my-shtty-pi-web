import type { TransportRequest, TransportResponse, WebxTransport } from "./types.js";
export interface HttpTransportOptions {
    readonly baseUrl: string;
    readonly bearerToken?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly retryCount?: number;
}
export declare class HttpTransport implements WebxTransport {
    #private;
    private readonly options;
    constructor(options: HttpTransportOptions);
    request(request: TransportRequest): Promise<TransportResponse>;
}
export interface NdjsonConnection {
    send(line: string, signal?: AbortSignal): Promise<string>;
    close(): Promise<void>;
}
export type NdjsonConnectionFactory = (socketPath: string) => Promise<NdjsonConnection>;
/**
 * Unix transport uses a supplied NDJSON socket connector. This keeps host-path
 * and socket access outside the SDK while retaining strict framing and bounds.
 */
export interface UnixActorIdentity {
    readonly principalId: string;
    readonly agentId: string;
}
export interface UnixActorBinding {
    readonly bindingId: string;
    readonly bindingSecret: string;
}
export declare class UnixSocketTransport implements WebxTransport {
    #private;
    private readonly socketPath;
    private readonly connect;
    private readonly actor?;
    constructor(socketPath: string, connect: NdjsonConnectionFactory, actor?: UnixActorIdentity | undefined);
    bind(ownerId: string, signal?: AbortSignal): Promise<void>;
    request(request: TransportRequest): Promise<TransportResponse>;
}
export declare class InProcessTransport implements WebxTransport {
    private readonly handler;
    constructor(handler: (request: TransportRequest) => Promise<TransportResponse>);
    request(request: TransportRequest): Promise<TransportResponse>;
}
