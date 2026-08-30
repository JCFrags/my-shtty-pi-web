export class WorkspaceProtocolError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_FAILED" | "NOT_FOUND" | "CONFLICT" | "LIMIT_EXCEEDED" | "UNAVAILABLE" | "INTERNAL_ERROR",
    message: string,
    readonly retryable = false,
  ) { super(message); this.name = "WorkspaceProtocolError"; }
}
