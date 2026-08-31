import type { Static } from "typebox";
import type {
  WorkspaceBindSchema, WorkspaceClientCommandSchema, WorkspaceFrameHeaderSchema,
  WorkspaceHumanInputEventSchema, WorkspacePaintedFrameBindingSchema,
  WorkspaceControlStatusResultSchema, WorkspaceControlAcquiredResultSchema,
  WorkspaceControlHeartbeatResultSchema, WorkspaceControlReleasedResultSchema,
  WorkspaceInputAckSchema, WorkspaceErrorCodeSchema,
  WorkspaceServerHeaderSchema, WorkspaceSessionSchema, WorkspaceSnapshotSchema,
  WorkspaceStatusSchema, WorkspaceTabSchema,
} from "./schema.js";

export type WorkspaceBind = Static<typeof WorkspaceBindSchema>;
export type WorkspaceClientCommand = Static<typeof WorkspaceClientCommandSchema>;
export type WorkspaceServerHeader = Static<typeof WorkspaceServerHeaderSchema>;
export type WorkspaceSnapshot = Static<typeof WorkspaceSnapshotSchema>;
export type WorkspaceSession = Static<typeof WorkspaceSessionSchema>;
export type WorkspaceTab = Static<typeof WorkspaceTabSchema>;
export type WorkspaceFrameHeader = Static<typeof WorkspaceFrameHeaderSchema>;
export type WorkspaceHumanInputEvent = Static<typeof WorkspaceHumanInputEventSchema>;
export type WorkspacePaintedFrameBinding = Static<typeof WorkspacePaintedFrameBindingSchema>;
export type WorkspaceControlStatusResult = Static<typeof WorkspaceControlStatusResultSchema>;
export type WorkspaceControlAcquiredResult = Static<typeof WorkspaceControlAcquiredResultSchema>;
export type WorkspaceControlHeartbeatResult = Static<typeof WorkspaceControlHeartbeatResultSchema>;
export type WorkspaceControlReleasedResult = Static<typeof WorkspaceControlReleasedResultSchema>;
export type WorkspaceInputAck = Static<typeof WorkspaceInputAckSchema>;
export type WorkspaceErrorCode = Static<typeof WorkspaceErrorCodeSchema>;
export type WorkspaceStatus = Static<typeof WorkspaceStatusSchema>;
export interface WorkspaceWireRecord<H = WorkspaceServerHeader> { readonly header: H; readonly payload: Uint8Array }
