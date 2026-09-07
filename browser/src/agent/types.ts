import type { BrowserDialog } from "./dialogs";

export type AgentActionOutcome<T> = T | { contextId: number; completed: false; dialog?: BrowserDialog; openedContextId?: number };

import type { ActionService, LocatorSpec, MouseButton, PageSnapshot, Point, Rect } from "agentcursor" with {
  "resolution-mode": "import",
};
import type { AgentKey } from "./key";
import type { ProgrammaticPointerEvent } from "../page/input";

export interface AgentBrowserTarget {
  frames?: import("./frames").BrowserFrames;
  readonly downloadStartSequence?: number;
  waitForDownloadStart?(sequence: number, signal: AbortSignal): Promise<boolean>;
  uploads?: import("./uploads").BrowserUploads;
  runJs(source: string): Promise<unknown>;
  agentStartDrag?(): Promise<void>;
  agentFinishDrag?(cancelled: boolean): Promise<void>;
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

export interface AgentElementState {
  ref: string; rect: Rect; bounds: Rect; visible: boolean; enabled: boolean; editable: boolean;
  hit: boolean; focused: boolean; text: string; tag: string; name: string; role: string;
}

export interface AgentLocatorQuery {
  documentId: string; count: number; matches: AgentElementState[];
}

export interface AgentPageObserver {
  queryLocator(spec: LocatorSpec): Promise<AgentLocatorQuery>;
  elementState(ref: string, options?: { point?: Point; scroll?: boolean; documentId?: string }): Promise<{ documentId: string; state: AgentElementState | null }>;

  observe(maxElements: number, includeText: boolean, filter?: LocatorSpec): Promise<ObservedPage>;
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

export interface AgentObserveRequest extends AgentRequest {
  frame?: string;
  filter?: LocatorSpec;
  maxElements: number;
  includeText: boolean;
  view: AgentObservationView;
  scope: AgentObservationScope;
  ref?: string;
}

export interface AgentObservation {
  frame?: string;
  frames?: import("./frames").FrameSummary[];
  framesTruncated?: boolean;
  contextId?: number;
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

export interface AgentRequest { signal?: AbortSignal }

export interface AgentClickRequest extends AgentRequest {
  ref?: string;
  locator?: LocatorSpec;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentUploadRequest extends AgentClickRequest {
  files: string[];
}

export interface AgentClickResult {
  ref: string;
  point: Point;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export type AgentElementTarget = { ref: string } | { locator: LocatorSpec };
export type AgentActionTarget = AgentElementTarget | { x: number; y: number };

export interface AgentHoverRequest extends AgentRequest {
  target: AgentActionTarget;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentHoverResult {
  point: Point;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export interface AgentDragRequest extends AgentRequest {
  from: AgentActionTarget;
  to: AgentActionTarget;
  button: MouseButton;
  observationId: string;
  expectedControlEpoch: number;
}

export interface AgentDragResult {
  from: AgentActionTarget;
  to: AgentActionTarget;
  button: MouseButton;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export interface AgentTypeRequest extends AgentRequest {
  ref?: string;
  locator?: LocatorSpec;
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

export interface AgentPressKeyRequest extends AgentRequest {
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

export interface AgentScrollRequest extends AgentRequest {
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

export interface AgentNavigateRequest extends AgentRequest {
  url: string;
  expectedControlEpoch: number;
}

export interface AgentNavigateResult {
  requestedUrl: string;
  url: string;
  controlEpoch: number;
}

export interface AgentGetUrlRequest extends AgentRequest {
  expectedControlEpoch: number;
}

export interface AgentGetUrlResult {
  url: string;
  controlEpoch: number;
}

export interface AgentWaitForRequest extends AgentRequest {
  observationId: string;
  expectedControlEpoch: number;
  ref?: string;
  text?: string;
  locator?: LocatorSpec;
  condition?: "exists" | "visible" | "text" | "actionable";
  timeoutMs: number;
}

export interface AgentWaitForResult {
  matched: boolean;
  condition: "exists" | "visible" | "text" | "actionable";
  ref?: string;
  documentId: string;
  controlEpoch: number;
  url: string;
}

export type AgentActionService = Pick<
  ActionService,
  "click" | "type" | "pressKey" | "scroll" | "navigate" | "getUrl" | "waitFor" | "hover" | "drag"
>;
