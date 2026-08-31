import type { WorkspaceErrorCode } from "./types.js";

export class WorkspaceProtocolError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly retryable = false,
  ) { super(message); this.name = "WorkspaceProtocolError"; }
}
