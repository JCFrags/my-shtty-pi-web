import type { WebxProblem } from "./types.js";
export declare class WebxError extends Error {
    readonly status: number;
    readonly problem: WebxProblem;
    constructor(status: number, problem: WebxProblem);
}
export declare class ApiVersionError extends Error {
    readonly expectedMajor: number;
    readonly actualVersion: string;
    constructor(expectedMajor: number, actualVersion: string);
}
export declare class ResponseLimitError extends Error {
    readonly limit: number;
    constructor(limit: number);
}
export declare function asWebxError(status: number, body: unknown): WebxError;
