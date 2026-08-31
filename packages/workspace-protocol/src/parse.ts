import { Check, Parse } from "typebox/value";
import { WorkspaceProtocolError } from "./errors.js";
import {
  MAX_WORKSPACE_INPUT_BATCH_BYTES, MAX_WORKSPACE_INPUT_TEXT_BYTES, WorkspaceBindSchema,
  WorkspaceClientCommandSchema, WorkspaceServerHeaderSchema,
} from "./schema.js";
import type { WorkspaceBind, WorkspaceClientCommand, WorkspaceServerHeader } from "./types.js";

export function parseWorkspaceBind(value: unknown): WorkspaceBind {
  if (!Check(WorkspaceBindSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace bind record is invalid.");
  return Parse(WorkspaceBindSchema, value);
}
export function parseWorkspaceClientCommand(value: unknown, encodedBytes?: number): WorkspaceClientCommand {
  if (!Check(WorkspaceClientCommandSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace command is invalid.");
  const command = Parse(WorkspaceClientCommandSchema, value);
  if (command.kind === "input.batch") assertInputBounds(command, encodedBytes);
  return command;
}
function assertInputBounds(command: WorkspaceClientCommand & { readonly kind: "input.batch" }, encodedBytes?: number): void {
  const encoder = new TextEncoder();
  if ((encodedBytes ?? encoder.encode(JSON.stringify(command)).byteLength) > MAX_WORKSPACE_INPUT_BATCH_BYTES) {
    throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace input batch exceeds its encoded byte limit.");
  }
  let textBytes = 0;
  for (const event of command.events) {
    if (event.kind === "text") textBytes += encoder.encode(event.text).byteLength;
  }
  if (textBytes > MAX_WORKSPACE_INPUT_TEXT_BYTES) {
    throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace input text exceeds its byte limit.");
  }
}
export function parseWorkspaceServerHeader(value: unknown): WorkspaceServerHeader {
  if (!Check(WorkspaceServerHeaderSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace server header is invalid.");
  return Parse(WorkspaceServerHeaderSchema, value);
}
