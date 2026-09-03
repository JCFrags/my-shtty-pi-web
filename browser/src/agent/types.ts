import type { ActionService, PageSnapshot, Point, Rect } from "agentcursor" with {
  "resolution-mode": "import",
};
import type { ProgrammaticPointerEvent } from "../page/input";

export interface AgentBrowserTarget {
  runJs(source: string): Promise<unknown>;
  agentPointer(event: ProgrammaticPointerEvent): void;
  releaseAgentPointer(): void;
  viewportSize(): { width: number; height: number };
  currentUrl(): string;
}

export interface ObservedPage {
  documentId: string;
  snapshot: PageSnapshot;
}

export interface AgentPageObserver {
  observe(maxElements: number, includeText: boolean): Promise<ObservedPage>;
  currentDocumentId(): Promise<string>;
  ensureVisible(ref: string): Promise<Rect | null>;
}

export interface AgentObservation {
  observationId: string;
  documentId: string;
  controlEpoch: number;
  snapshot: PageSnapshot;
}

export interface AgentActivity {
  cursor: Point | null;
  target: Point | null;
  pulse: boolean;
}

export interface AgentClickRequest {
  ref: string;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentClickResult {
  ref: string;
  point: Point;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export type AgentActionService = Pick<ActionService, "click">;
