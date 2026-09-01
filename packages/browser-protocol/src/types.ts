import type { Static } from "typebox";
import type {
  ActorIdentitySchema, BindRequestSchema, BindResponseSchema, BrowserRequestSchema,
  WorkspaceBrokerBindRequestSchema, WorkspaceBrokerRequestSchema, WorkspaceFrameEventSchema,
  WorkspaceControlFrameBindingSchema, HumanInputEventSchema, WorkspaceControlStatusResultSchema,
  WorkspaceControlHeartbeatResultSchema, WorkspaceControlLeaseResultSchema, WorkspaceInputAckResultSchema,
  WorkspaceSessionSnapshotSchema, WorkspaceSnapshotSchema, WorkspaceStateEventSchema, BrowserResourceStatusSchema,
  DispatchStateSchema, DomObservationSchema, ErrorCodeSchema, ErrorResponseSchema,
  FrameEventSchema, OperationStateSchema, OperationStatusSchema, ProtocolErrorSchema,
  ScreenshotObservationSchema, ServerMessageSchema, SessionDescriptorSchema,
  SuccessResponseSchema, TabAddressSchema, TabDescriptorSchema,
} from "./schema.js";

export type ActorIdentity = Static<typeof ActorIdentitySchema>;
export type BindRequest = Static<typeof BindRequestSchema>;
export type BrowserRequest = Static<typeof BrowserRequestSchema>;
export type WorkspaceBrokerBindRequest = Static<typeof WorkspaceBrokerBindRequestSchema>;
export type WorkspaceBrokerRequest = Static<typeof WorkspaceBrokerRequestSchema>;
export type WorkspaceSnapshot = Static<typeof WorkspaceSnapshotSchema>;
export type WorkspaceSessionSnapshot = Static<typeof WorkspaceSessionSnapshotSchema>;
export type BrowserResourceStatus = Static<typeof BrowserResourceStatusSchema>;
export type WorkspaceStateEvent = Static<typeof WorkspaceStateEventSchema>;
export type WorkspaceFrameEvent = Static<typeof WorkspaceFrameEventSchema>;
export type WorkspaceControlFrameBinding = Static<typeof WorkspaceControlFrameBindingSchema>;
export type HumanInputEvent = Static<typeof HumanInputEventSchema>;
export type WorkspaceControlStatusResult = Static<typeof WorkspaceControlStatusResultSchema>;
export type WorkspaceControlHeartbeatResult = Static<typeof WorkspaceControlHeartbeatResultSchema>;
export type WorkspaceControlLeaseResult = Static<typeof WorkspaceControlLeaseResultSchema>;
export type WorkspaceInputAckResult = Static<typeof WorkspaceInputAckResultSchema>;
export type BindResponse = Static<typeof BindResponseSchema>;
export type SuccessResponse = Static<typeof SuccessResponseSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type TabAddress = Static<typeof TabAddressSchema>;
export type TabDescriptor = Static<typeof TabDescriptorSchema>;
export type SessionDescriptor = Static<typeof SessionDescriptorSchema>;
export type ScreenshotObservation = Static<typeof ScreenshotObservationSchema>;
export type DomObservation = Static<typeof DomObservationSchema>;
export type FrameEvent = Static<typeof FrameEventSchema>;
export type OperationState = Static<typeof OperationStateSchema>;
export type DispatchState = Static<typeof DispatchStateSchema>;
export type OperationStatus = Static<typeof OperationStatusSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;
export type ErrorCode = Static<typeof ErrorCodeSchema>;
