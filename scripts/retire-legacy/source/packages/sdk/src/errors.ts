import type { WebxProblem } from "./types.js";

export class WebxError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: WebxProblem,
  ) {
    super(problem.message);
    this.name = "WebxError";
  }
}

export class ApiVersionError extends Error {
  constructor(public readonly expectedMajor: number, public readonly actualVersion: string) {
    super(`WebX API major mismatch: expected ${expectedMajor}, received ${actualVersion}`);
    this.name = "ApiVersionError";
  }
}

export class ResponseLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`WebX response exceeded ${limit} bytes`);
    this.name = "ResponseLimitError";
  }
}

export function asWebxError(status: number, body: unknown): WebxError {
  if (isProblem(body)) return new WebxError(status, body);
  return new WebxError(status, {
    code: "transport-error",
    message: `WebX request failed with status ${status}`,
    retryable: status >= 500,
  });
}

function isProblem(value: unknown): value is WebxProblem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string" && typeof record.retryable === "boolean";
}
