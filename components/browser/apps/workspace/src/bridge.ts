import { Channel, invoke } from "@tauri-apps/api/core";

export interface CursorState { x: number; y: number; visible: boolean; pathSequence: number; sampleSequence: number }
export interface OperationState { operationId: string; kind: string; state: "queued" | "running" | "cancelling" | "terminal"; dispatchState: "not-dispatched" | "partially-dispatched" | "dispatched"; startedAt?: string; cancellable: boolean }
export interface WorkspaceTab { tabId: string; url: string; title: string; state: "attaching" | "ready" | "crashed" | "closed"; documentGeneration: number; viewportGeneration: number; frameSequence: number }
export interface WorkspaceSession { browserSessionId: string; agentLabel: string; actorDisplayId: string; pathId: "agentcursor/chrome"; state: "starting" | "ready" | "degraded" | "closed"; controlState: "agent"; personaDisplayId: string; cursor: CursorState; tabs: WorkspaceTab[]; activeOperation?: OperationState; lastActivityAt?: string }
export interface WorkspaceSnapshot { workspaceRevision: number; browserdRuntimeInstanceId?: string; generatedAt: string; browserdState: "ready" | "unavailable" | "replaced"; sessions: WorkspaceSession[] }
export interface WorkspaceStatus { connection: "connecting" | "ready" | "reconnecting" | "unavailable" | "closed"; browserd: "ready" | "unavailable" | "replaced"; message?: string }
export interface SelectedTab { selectionId: string; browserSessionId: string; tabId: string }
export interface PublicWorkspaceState { connection: string; webxdRuntimeInstanceId?: string; snapshot?: WorkspaceSnapshot; selected?: SelectedTab; droppedBeforeFrontend: number; inflightFrame: boolean }
export type FrontendStateRecord =
  | { kind: "current"; state: PublicWorkspaceState }
  | { kind: "snapshot"; snapshot: WorkspaceSnapshot }
  | { kind: "status"; status: WorkspaceStatus }
  | { kind: "selection"; selected: SelectedTab }
  | { kind: "selectionCleared" }
  | { kind: "error"; error: { code: string; message: string; retryable: boolean } };

export interface FrameMetadata {
  deliveryId: number; selectionId: string; subscriptionId: string; browserdRuntimeInstanceId: string;
  browserSessionId: string; tabId: string; frameSequence: number; documentGeneration: number;
  viewportGeneration: number; capturedAt: string; publishedAt: string; receivedAt: string;
  mediaType: "image/png" | "image/jpeg"; byteLength: number; sha256: string; width: number; height: number;
}
export interface FrameEnvelope { metadata: FrameMetadata; bytes: Uint8Array }

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/;

export class WorkspaceBridge {
  #stateChannel?: Channel<FrontendStateRecord>;
  #frameChannel?: Channel<ArrayBuffer>;

  async open(onState: (record: FrontendStateRecord) => void, onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    const stateChannel = new Channel<FrontendStateRecord>();
    const frameChannel = new Channel<ArrayBuffer>();
    stateChannel.onmessage = (record) => onState(record);
    frameChannel.onmessage = (value) => {
      if (!(value instanceof ArrayBuffer)) throw new TypeError("Tauri frame channel did not deliver an ArrayBuffer");
      onFrame(value);
    };
    this.#stateChannel = stateChannel; this.#frameChannel = frameChannel;
    await invoke("workspace_open", { stateChannel, frameChannel });
  }

  select(browserSessionId: string, tabId?: string): Promise<SelectedTab> { return invoke("workspace_select", { browserSessionId, tabId }); }
  clearSelection(): Promise<void> { return invoke("workspace_clear_selection"); }
  currentState(): Promise<PublicWorkspaceState> { return invoke("workspace_current_state"); }
  acknowledgeFrame(deliveryId: number): Promise<void> { return invoke("workspace_frame_ack", { deliveryId }); }
  windowAction(action: "raise" | "hide"): Promise<void> { return invoke("workspace_window_action", { action }); }
}

export function decodeFrameEnvelope(value: ArrayBuffer): FrameEnvelope {
  if (!(value instanceof ArrayBuffer) || value.byteLength < 6 || value.byteLength > 4 + 16 * 1024 + 4 * 1024 * 1024) throw new TypeError("Frame envelope length is invalid");
  const view = new DataView(value);
  const metadataLength = view.getUint32(0, false);
  if (metadataLength < 2 || metadataLength > 16 * 1024 || 4 + metadataLength >= value.byteLength) throw new TypeError("Frame metadata length is invalid");
  const metadata = JSON.parse(textDecoder.decode(new Uint8Array(value, 4, metadataLength))) as unknown;
  if (!isFrameMetadata(metadata)) throw new TypeError("Frame metadata is invalid");
  const bytes = new Uint8Array(value, 4 + metadataLength);
  if (bytes.byteLength !== metadata.byteLength) throw new TypeError("Frame payload length changed");
  return { metadata, bytes };
}

export async function verifyFrameDigest(frame: FrameEnvelope): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", frame.bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") === frame.metadata.sha256;
}

export interface BinaryProbeResult { total: number; frontendType: "ArrayBuffer"; payloadBytes: number; digests: string[]; elapsedMs: number; maximumInflight: 1 }
export async function runBinaryProbe(): Promise<BinaryProbeResult> {
  const channel = new Channel<ArrayBuffer>();
  const started = performance.now();
  const digests: string[] = [];
  return await new Promise<BinaryProbeResult>((resolve, reject) => {
    channel.onmessage = (record) => {
      void (async () => {
        if (!(record instanceof ArrayBuffer)) throw new TypeError("Binary probe did not receive an ArrayBuffer");
        const sequence = new DataView(record).getUint32(0, false);
        const payload = new Uint8Array(record, 4);
        const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
        const digest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        digests.push(digest);
        const status = await invoke<{ total: number; complete: boolean; payloadBytes: number }>("workspace_binary_probe_ack", { sequence, sha256: digest });
        if (status.complete) {
          if (new Set(digests).size !== status.total) throw new Error("Binary probe digests were not unique");
          resolve({ total: status.total, frontendType: "ArrayBuffer", payloadBytes: status.payloadBytes, digests, elapsedMs: performance.now() - started, maximumInflight: 1 });
        }
      })().catch(reject);
    };
    void invoke("workspace_binary_probe_open", { frameChannel: channel }).catch(reject);
  });
}

function isFrameMetadata(value: unknown): value is FrameMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["deliveryId", "selectionId", "subscriptionId", "browserdRuntimeInstanceId", "browserSessionId", "tabId", "frameSequence", "documentGeneration", "viewportGeneration", "capturedAt", "publishedAt", "receivedAt", "mediaType", "byteLength", "sha256", "width", "height"];
  if (Object.keys(item).length !== keys.length || !keys.every((key) => key in item)) return false;
  return Number.isSafeInteger(item.deliveryId) && typeof item.selectionId === "string" && OPAQUE_ID.test(item.selectionId)
    && typeof item.subscriptionId === "string" && OPAQUE_ID.test(item.subscriptionId)
    && typeof item.browserdRuntimeInstanceId === "string" && OPAQUE_ID.test(item.browserdRuntimeInstanceId)
    && typeof item.browserSessionId === "string" && ID.test(item.browserSessionId)
    && typeof item.tabId === "string" && ID.test(item.tabId)
    && Number.isSafeInteger(item.frameSequence) && Number.isSafeInteger(item.documentGeneration) && Number.isSafeInteger(item.viewportGeneration)
    && typeof item.capturedAt === "string" && typeof item.publishedAt === "string" && typeof item.receivedAt === "string"
    && (item.mediaType === "image/png" || item.mediaType === "image/jpeg") && Number.isSafeInteger(item.byteLength) && (item.byteLength as number) > 0
    && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
    && Number.isSafeInteger(item.width) && Number.isSafeInteger(item.height);
}
