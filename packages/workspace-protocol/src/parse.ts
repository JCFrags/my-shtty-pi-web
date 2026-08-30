import { Check, Parse } from "typebox/value";
import { WorkspaceProtocolError } from "./errors.js";
import { WorkspaceBindSchema, WorkspaceClientCommandSchema, WorkspaceServerHeaderSchema } from "./schema.js";
import type { WorkspaceBind, WorkspaceClientCommand, WorkspaceServerHeader } from "./types.js";

export function parseWorkspaceBind(value: unknown): WorkspaceBind {
  if (!Check(WorkspaceBindSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace bind record is invalid.");
  return Parse(WorkspaceBindSchema, value);
}
export function parseWorkspaceClientCommand(value: unknown): WorkspaceClientCommand {
  if (!Check(WorkspaceClientCommandSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace command is invalid.");
  return Parse(WorkspaceClientCommandSchema, value);
}
export function parseWorkspaceServerHeader(value: unknown): WorkspaceServerHeader {
  if (!Check(WorkspaceServerHeaderSchema, value)) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace server header is invalid.");
  return Parse(WorkspaceServerHeaderSchema, value);
}
