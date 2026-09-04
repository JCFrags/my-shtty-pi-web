import type { ActionService, PageSnapshot, Point, Rect } from "agentcursor" with {
  "resolution-mode": "import",
};
import type { AgentKey } from "./key";
import type { ProgrammaticPointerEvent } from "../page/input";

export interface AgentBrowserTarget {
  runJs(source: string): Promise<unknown>;
  agentPointer(event: ProgrammaticPointerEvent): void;
  releaseAgentPointer(): void;
  releaseAgentInput(): void;
  agentKeyDown(key: AgentKey): Promise<void>;
  agentKeyChar(key: AgentKey): Promise<void>;
  agentKeyUp(key: AgentKey): void;
  agentSelectAll(): Promise<void>;
  agentInsertText(text: string): Promise<void>;
  agentWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  agentNavigate(url: string): Promise<string>;
  viewportSize(): { width: number; height: number };
  currentUrl(): string;
  capturePage(rect?: Rect): Promise<Buffer>;
}

export interface ObservedPage {
  documentId: string;
  snapshot: PageSnapshot;
}

export interface AgentPageProbe {
  exists: boolean;
  visible: boolean;
  refText: string;
  documentText: string;
}

export interface AgentPageObserver {
  observe(maxElements: number, includeText: boolean): Promise<ObservedPage>;
  currentDocumentId(): Promise<string>;
  ensureVisible(ref: string): Promise<Rect | null>;
  refState(ref: string): Promise<{ exists: boolean; connected: boolean; editable: boolean }>;
  probe(ref?: string, text?: string): Promise<AgentPageProbe>;
}

export type AgentObservationView = "semantic" | "visual" | "both";
export type AgentObservationScope = "viewport" | "element";

export interface AgentVisualObservation {
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: number;
  scope: AgentObservationScope;
  rect: Rect;
  data: Buffer;
}

export interface AgentObserveRequest {
  maxElements: number;
  includeText: boolean;
  view: AgentObservationView;
  scope: AgentObservationScope;
  ref?: string;
}

export interface AgentObservation {
  observationId: string;
  documentId: string;
  controlEpoch: number;
  snapshot: PageSnapshot;
  visual?: AgentVisualObservation;
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

export interface AgentTypeRequest {
  ref: string;
  text: string;
  replace: boolean;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentTypeResult {
  ref: string;
  characters: number;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export interface AgentPressKeyRequest {
  key: string;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentPressKeyResult {
  key: string;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export interface AgentScrollRequest {
  dx: number;
  dy: number;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentScrollResult {
  dx: number;
  dy: number;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export interface AgentNavigateRequest {
  url: string;
  expectedControlEpoch: number;
}

export interface AgentNavigateResult {
  requestedUrl: string;
  url: string;
  controlEpoch: number;
}

export interface AgentGetUrlRequest {
  expectedControlEpoch: number;
}

export interface AgentGetUrlResult {
  url: string;
  controlEpoch: number;
}

export interface AgentWaitForRequest {
  observationId: string;
  expectedControlEpoch: number;
  ref?: string;
  text?: string;
  condition?: "exists" | "visible" | "text";
  timeoutMs: number;
}

export interface AgentWaitForResult {
  matched: boolean;
  condition: "exists" | "visible" | "text";
  ref?: string;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export type AgentActionService = Pick<
  ActionService,
  "click" | "type" | "pressKey" | "scroll" | "navigate" | "getUrl" | "waitFor"
>;
