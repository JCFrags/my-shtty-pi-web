import { Check, Parse } from "typebox/value";
import { BrowserProtocolError } from "./errors.js";
import { BindRequestSchema, BrowserRequestSchema, MAX_DEADLINE_FUTURE_MS, ServerMessageSchema, WorkspaceBrokerBindRequestSchema, WorkspaceBrokerRequestSchema } from "./schema.js";
import type { BindRequest, BrowserRequest, ServerMessage, WorkspaceBrokerBindRequest, WorkspaceBrokerRequest } from "./types.js";

export function parseBindRequest(input: unknown): BindRequest {
  if (!Check(BindRequestSchema, input)) {
    throw new BrowserProtocolError("INVALID_REQUEST", "The binding message does not match the browser protocol.");
  }
  return Parse(BindRequestSchema, input);
}

export function parseWorkspaceBrokerBindRequest(input: unknown): WorkspaceBrokerBindRequest {
  if (!Check(WorkspaceBrokerBindRequestSchema, input)) throw new BrowserProtocolError("INVALID_REQUEST", "The workspace binding message does not match the browser protocol.");
  return Parse(WorkspaceBrokerBindRequestSchema, input);
}

export function parseWorkspaceBrokerRequest(input: unknown, nowMs = Date.now()): WorkspaceBrokerRequest {
  if (!Check(WorkspaceBrokerRequestSchema, input)) throw new BrowserProtocolError("INVALID_REQUEST", "The workspace request does not match the browser protocol.");
  const request = Parse(WorkspaceBrokerRequestSchema, input);
  assertDeadline(request.deadline, nowMs);
  return request;
}

export function parseBrowserRequest(input: unknown, nowMs = Date.now()): BrowserRequest {
  if (!Check(BrowserRequestSchema, input)) {
    throw new BrowserProtocolError("INVALID_REQUEST", "The request does not match the browser protocol.");
  }
  const request = Parse(BrowserRequestSchema, input);
  assertDeadline(request.deadline, nowMs);
  return request;
}

export function parseServerMessage(input: unknown): ServerMessage {
  if (!Check(ServerMessageSchema, input)) throw new BrowserProtocolError("INVALID_REQUEST", "The server message does not match the browser protocol.");
  return Parse(ServerMessageSchema, input);
}

export function assertDeadline(deadline: string, nowMs: number): void {
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    throw new BrowserProtocolError("DEADLINE_EXCEEDED", "The request deadline has expired.");
  }
  if (deadlineMs - nowMs > MAX_DEADLINE_FUTURE_MS) {
    throw new BrowserProtocolError("INVALID_REQUEST", "The request deadline is too far in the future.");
  }
}
