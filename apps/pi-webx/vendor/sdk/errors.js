export class WebxError extends Error {
    status;
    problem;
    constructor(status, problem) {
        super(problem.message);
        this.status = status;
        this.problem = problem;
        this.name = "WebxError";
    }
}
export class ApiVersionError extends Error {
    expectedMajor;
    actualVersion;
    constructor(expectedMajor, actualVersion) {
        super(`WebX API major mismatch: expected ${expectedMajor}, received ${actualVersion}`);
        this.expectedMajor = expectedMajor;
        this.actualVersion = actualVersion;
        this.name = "ApiVersionError";
    }
}
export class ResponseLimitError extends Error {
    limit;
    constructor(limit) {
        super(`WebX response exceeded ${limit} bytes`);
        this.limit = limit;
        this.name = "ResponseLimitError";
    }
}
export function asWebxError(status, body) {
    if (isProblem(body))
        return new WebxError(status, body);
    return new WebxError(status, {
        code: "transport-error",
        message: `WebX request failed with status ${status}`,
        retryable: status >= 500,
    });
}
function isProblem(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    return typeof record.code === "string" && typeof record.message === "string" && typeof record.retryable === "boolean";
}
