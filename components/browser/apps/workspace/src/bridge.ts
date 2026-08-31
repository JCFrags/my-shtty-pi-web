import { Channel, invoke } from "@tauri-apps/api/core";

export interface CursorState { x: number; y: number; visible: boolean }
export interface OperationState { kind: string; state: "queued" | "running" | "cancelling" | "terminal"; dispatchState: "not-dispatched" | "partially-dispatched" | "dispatched"; startedAt?: string; cancellable: boolean }
export type CaptureReadiness = "starting" | "warming" | "ready" | "degraded" | "unavailable";
export interface WorkspaceTab { tabId: string; url: string; title: string; state: "attaching" | "ready" | "crashed" | "closed"; captureReadiness: CaptureReadiness }
export type ControlState = "agent" | "takeover-pending" | "human" | "human-disconnected" | "return-pending";
export interface WorkspaceSession { browserSessionId: string; agentLabel: string; actorDisplayId: string; pathId: "agentcursor/chrome"; state: "starting" | "ready" | "degraded" | "closed"; controlState: ControlState; captureReadiness: CaptureReadiness; personaDisplayId: string; cursor: CursorState; tabs: WorkspaceTab[]; activeOperation?: OperationState; lastActivityAt?: string }
export interface WorkspaceSnapshot { generatedAt: string; browserdState: "ready" | "unavailable" | "replaced"; sessions: WorkspaceSession[] }
export interface WorkspaceStatus { connection: "connecting" | "ready" | "reconnecting" | "unavailable" | "closed"; browserd: "ready" | "unavailable" | "replaced"; message?: string }
export interface SelectedTab { browserSessionId: string; tabId: string }
export interface PublicWorkspaceState { connection: string; snapshot?: WorkspaceSnapshot; selected?: SelectedTab; droppedBeforeFrontend: number; inflightFrame: boolean }
export type FrontendStateRecord =
  | { kind: "current"; state: PublicWorkspaceState }
  | { kind: "snapshot"; snapshot: WorkspaceSnapshot }
  | { kind: "status"; status: WorkspaceStatus }
  | { kind: "selection"; selected: SelectedTab }
  | { kind: "selectionCleared" }
  | { kind: "error"; error: { code: string; message: string; retryable: boolean } };

export interface FrameMetadata {
  deliveryId: number; capturedAt: string; publishedAt: string; receivedAt: string;
  mediaType: "image/png" | "image/jpeg"; byteLength: number; sha256: string; imagePixelWidth: number; imagePixelHeight: number;
}
export interface FrameEnvelope { metadata: FrameMetadata; bytes: Uint8Array }
export type FrameDropReason = "malformed" | "selection" | "selection-changed" | "digest" | "decode" | "decoded-dimensions" | "missing-canvas";
export type FrontendBinaryType = "ArrayBuffer" | "Uint8Array";
export interface FrameRetention {
  frontendRetainedFrames: 0 | 1;
  frontendImageBitmaps: 0;
  maximumFrontendImageBitmaps: 0 | 1;
}
export type FrameDispositionCore =
  | { outcome: "painted"; frontendType: FrontendBinaryType; decodeMs: number; paintMs: number; totalMs: number; decodedAt: string; paintedAt: string; decodedWidth: number; decodedHeight: number }
  | { outcome: "dropped"; frontendType: FrontendBinaryType; reason: FrameDropReason };
export type FrameDisposition = FrameDispositionCore & FrameRetention;

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const frontendBinaryTypes = new WeakMap<ArrayBuffer, FrontendBinaryType>();
export function frontendBinaryType(value: ArrayBuffer): FrontendBinaryType { return frontendBinaryTypes.get(value) ?? "ArrayBuffer"; }
export type HumanInputEvent =
  | { kind: "pointerMove"; point: { imageX: number; imageY: number } }
  | { kind: "pointerDown" | "pointerUp"; point: { imageX: number; imageY: number }; button: "left" | "middle" | "right"; clickCount?: 1 | 2 }
  | { kind: "wheel"; point: { imageX: number; imageY: number }; deltaX: number; deltaY: number }
  | { kind: "keyDown"; key: string; code?: string; repeat?: boolean }
  | { kind: "keyUp"; key: string; code?: string }
  | { kind: "text"; text: string };
export interface InputAck { acceptedEventCount: number; coalescedPointerMoveCount: number; awaitingNewFrame: boolean; resumeAfterDeliveryId?: number }

export interface WorkspaceApi {
  open(onState: (record: FrontendStateRecord) => void, onFrame: (frame: ArrayBuffer) => void): Promise<void>;
  select(browserSessionId: string, tabId?: string): Promise<SelectedTab>;
  clearSelection(): Promise<void>;
  currentState(): Promise<PublicWorkspaceState>;
  acknowledgeFrame(deliveryId: number, disposition: FrameDisposition): Promise<void>;
  takeControl(): Promise<{ controlState: string }>;
  returnControl(): Promise<{ controlState: string }>;
  input(events: HumanInputEvent[]): Promise<InputAck>;
  windowAction(action: "raise" | "hide"): Promise<void>;
  acceptanceEnabled?(): Promise<boolean>;
}

export class WorkspaceBridge implements WorkspaceApi {
  #stateChannel?: Channel<FrontendStateRecord>;
  #frameChannel?: Channel<ArrayBuffer | Uint8Array>;

  async open(onState: (record: FrontendStateRecord) => void, onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    const stateChannel = new Channel<FrontendStateRecord>();
    const frameChannel = new Channel<ArrayBuffer | Uint8Array>();
    stateChannel.onmessage = (record) => onState(record);
    frameChannel.onmessage = (value) => {
      if (value instanceof ArrayBuffer) { frontendBinaryTypes.set(value, "ArrayBuffer"); onFrame(value); return; }
      if (value instanceof Uint8Array) {
        const exact = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
          ? value.buffer
          : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        if (!(exact instanceof ArrayBuffer)) throw new TypeError("Tauri frame channel delivered an unsupported shared buffer");
        frontendBinaryTypes.set(exact, "Uint8Array");
        onFrame(exact);
        return;
      }
      throw new TypeError("Tauri frame channel did not deliver a binary buffer");
    };
    this.#stateChannel = stateChannel; this.#frameChannel = frameChannel;
    await invoke("workspace_open", { stateChannel, frameChannel });
  }

  select(browserSessionId: string, tabId?: string): Promise<SelectedTab> { return invoke("workspace_select", { browserSessionId, tabId }); }
  clearSelection(): Promise<void> { return invoke("workspace_clear_selection"); }
  currentState(): Promise<PublicWorkspaceState> { return invoke("workspace_current_state"); }
  acknowledgeFrame(deliveryId: number, disposition: FrameDisposition): Promise<void> { return invoke<undefined>("workspace_frame_ack", { deliveryId, disposition }); }
  takeControl(): Promise<{ controlState: string }> { return invoke("workspace_take_control"); }
  returnControl(): Promise<{ controlState: string }> { return invoke("workspace_return_control"); }
  input(events: HumanInputEvent[]): Promise<InputAck> { return invoke("workspace_input_batch", { batch: { events } }); }
  windowAction(action: "raise" | "hide"): Promise<void> { return invoke("workspace_window_action", { action }); }
  acceptanceEnabled(): Promise<boolean> { return invoke("workspace_acceptance_enabled"); }
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
  const keys = ["deliveryId", "capturedAt", "publishedAt", "receivedAt", "mediaType", "byteLength", "sha256", "imagePixelWidth", "imagePixelHeight"];
  if (Object.keys(item).length !== keys.length || !keys.every((key) => key in item)) return false;
  return Number.isSafeInteger(item.deliveryId) && (item.deliveryId as number) >= 1
    && typeof item.capturedAt === "string" && typeof item.publishedAt === "string" && typeof item.receivedAt === "string"
    && (item.mediaType === "image/png" || item.mediaType === "image/jpeg") && Number.isSafeInteger(item.byteLength) && (item.byteLength as number) > 0
    && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
    && Number.isSafeInteger(item.imagePixelWidth) && (item.imagePixelWidth as number) > 0
    && Number.isSafeInteger(item.imagePixelHeight) && (item.imagePixelHeight as number) > 0;
}
