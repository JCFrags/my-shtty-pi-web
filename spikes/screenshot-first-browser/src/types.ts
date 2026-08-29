import type { Point } from "./agentcursor/protocol.js";

export type AgentSessionId = "agent-a" | "agent-b" | (string & {});

export interface TargetIdentity {
  agentSessionId: AgentSessionId;
  browserHostId: string;
  targetId: string;
  cdpSessionId: string;
}

export interface Observation extends TargetIdentity {
  observationId: string;
  url: string;
  title: string;
  capturedAt: string;
  capturedAtMonotonicMs: number;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: Point;
  mediaType: "image/png";
  screenshot: Buffer;
  screenshotSha256: string;
  frameSequence: number;
  documentGeneration: number;
  viewportGeneration: number;
}

export interface CursorStatus extends Point {
  personaSeed: number;
  pathSequence: number;
}

export interface SessionStatus {
  agentSessionId: AgentSessionId;
  browserHostId: string;
  connected: boolean;
  processRunning: boolean;
  targetId: string;
  url: string;
  latestFrameSequence: number;
  lastFrameAt: string | null;
  cursor: CursorStatus;
}

export interface DomFallbackNode {
  handle: string;
  role: string;
  name: string;
  value?: string;
  state: Record<string, string | number | boolean>;
  bounds?: { x: number; y: number; width: number; height: number };
  locatorDescription: string;
}

export interface DomFallbackObservation extends TargetIdentity {
  observedAt: string;
  documentGeneration: number;
  nodes: DomFallbackNode[];
  truncated: boolean;
}

export interface ActionTimings {
  pathDurationMs: number;
  pathWallMs: number;
  completionAfterPathMs: number;
  totalMs: number;
}

export class OwnershipError extends Error {
  readonly code = "OWNERSHIP_MISMATCH";
}

export class StaleObservationError extends Error {
  readonly code = "STALE_OBSERVATION";
}
