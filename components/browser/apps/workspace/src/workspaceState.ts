import type {
  FrameMetadata,
  FrontendStateRecord,
  PublicWorkspaceState,
  SelectedTab,
  WorkspaceSession,
  WorkspaceStatus,
  WorkspaceTab,
} from "./bridge";

export interface WorkspaceViewState {
  publicState: PublicWorkspaceState;
  status: WorkspaceStatus;
  error?: string;
}

export const initialWorkspaceViewState: WorkspaceViewState = {
  publicState: { connection: "connecting", droppedBeforeFrontend: 0, inflightFrame: false },
  status: { connection: "connecting", browserd: "unavailable" },
};

export function reduceWorkspaceRecord(state: WorkspaceViewState, record: FrontendStateRecord): WorkspaceViewState {
  switch (record.kind) {
    case "current": {
      const connection = connectionState(record.state.connection);
      return {
        ...state,
        publicState: record.state,
        status: connection ? { ...state.status, connection } : state.status,
        error: undefined,
      };
    }
    case "snapshot":
      return { ...state, publicState: { ...state.publicState, snapshot: record.snapshot }, error: undefined };
    case "status":
      return { ...state, status: record.status, error: record.status.message };
    case "selection":
      return { ...state, publicState: { ...state.publicState, selected: record.selected }, error: undefined };
    case "selectionCleared":
      return { ...state, publicState: { ...state.publicState, selected: undefined } };
    case "error":
      return {
        ...state,
        status: { connection: "reconnecting", browserd: "unavailable", message: record.error.message },
        error: record.error.message,
      };
  }
}

function connectionState(value: string): WorkspaceStatus["connection"] | undefined {
  return value === "connecting" || value === "ready" || value === "reconnecting" || value === "unavailable" || value === "closed" ? value : undefined;
}

export function findSelected(
  sessions: readonly WorkspaceSession[] | undefined,
  selected: SelectedTab | undefined,
): { session: WorkspaceSession; tab: WorkspaceTab } | undefined {
  if (!sessions || !selected) return undefined;
  const session = sessions.find((candidate) => candidate.browserSessionId === selected.browserSessionId);
  const tab = session?.tabs.find((candidate) => candidate.tabId === selected.tabId);
  return session && tab ? { session, tab } : undefined;
}

export const MAX_FRAME_PIXELS = 33_554_432;

export class FrameSequenceWatermark {
  #value = 0;
  current(): number { return this.#value; }
  reset(): void { this.#value = 0; }
  canAccept(sequence: number): boolean { return Number.isSafeInteger(sequence) && sequence > this.#value; }
  commit(sequence: number): boolean {
    if (!this.canAccept(sequence)) return false;
    this.#value = sequence;
    return true;
  }
}

export type FrameRejection =
  | "selection"
  | "runtime"
  | "document-generation"
  | "viewport-generation"
  | "sequence"
  | "media-type"
  | "dimensions"
  | "length";

export function frameRejectionReason(
  metadata: FrameMetadata,
  publicState: PublicWorkspaceState,
  lastSequence: number,
): FrameRejection | undefined {
  const selected = publicState.selected;
  const snapshot = publicState.snapshot;
  const target = findSelected(snapshot?.sessions, selected);
  if (!selected || !target || metadata.selectionId !== selected.selectionId
    || metadata.browserSessionId !== selected.browserSessionId || metadata.tabId !== selected.tabId) return "selection";
  if (!snapshot?.browserdRuntimeInstanceId || metadata.browserdRuntimeInstanceId !== snapshot.browserdRuntimeInstanceId) return "runtime";
  if (metadata.documentGeneration !== target.tab.documentGeneration) return "document-generation";
  if (metadata.viewportGeneration !== target.tab.viewportGeneration) return "viewport-generation";
  if (metadata.frameSequence <= lastSequence) return "sequence";
  if (metadata.mediaType !== "image/png" && metadata.mediaType !== "image/jpeg") return "media-type";
  if (metadata.width < 1 || metadata.height < 1 || metadata.width > 32_768 || metadata.height > 32_768
    || metadata.width * metadata.height > MAX_FRAME_PIXELS) return "dimensions";
  if (metadata.byteLength < 1 || metadata.byteLength > 4 * 1024 * 1024) return "length";
  return undefined;
}

export function displayText(value: string, fallback = "Untitled"): string {
  const visible = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�").trim();
  return visible || fallback;
}

export function safeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "Invalid address";
  }
}

export function shortId(value: string, maximum = 18): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(4, maximum - 5))}…${value.slice(-4)}`;
}

export function formatAge(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) return "—";
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return "—";
  const age = Math.max(0, now - value);
  if (age < 1_000) return "now";
  if (age < 60_000) return `${Math.floor(age / 1_000)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  return `${Math.floor(age / 3_600_000)}h ago`;
}
