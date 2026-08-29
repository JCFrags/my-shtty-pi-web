import type { ErrorCode, ProtocolError } from "./types.js";

export class BrowserProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "BrowserProtocolError";
  }

  sanitized(): ProtocolError {
    return {
      code: this.code,
      message: sanitizeMessage(this.message),
      retryable: this.retryable,
      ...(this.details ? { details: sanitizeDetails(this.details) } : {}),
    };
  }
}

export function sanitizeMessage(message: string): string {
  return message.replace(/(?:ws:\/\/|file:\/\/|\/home\/|\/tmp\/)[^\s]*/gi, "[redacted]").slice(0, 512) || "Browser operation failed.";
}

function sanitizeDetails(details: Readonly<Record<string, string | number | boolean>>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details).slice(0, 16)) {
    result[key] = typeof value === "string" ? sanitizeMessage(value).slice(0, 256) : value;
  }
  return result;
}
