import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  decodeFrameEnvelope,
  frontendBinaryType,
  verifyFrameDigest,
  type FrameDisposition,
  type FrameDispositionCore,
  type FrameMetadata,
  type PublicWorkspaceState,
  type WorkspaceApi,
} from "./bridge";
import { FrameSequenceWatermark, frameRejectionReason } from "./workspaceState";

export interface FrameMetrics {
  metadata?: FrameMetadata;
  decodedAt?: string;
  paintedAt?: string;
  socketToRustMs?: number;
  rustToFrontendMs?: number;
  decodeMs?: number;
  paintMs?: number;
  totalMs?: number;
  droppedBeforeDecode: number;
  droppedDuringDecode: number;
  malformedFrames: number;
  digestFailures: number;
  dimensionFailures: number;
  lastDropReason?: string;
}

const emptyMetrics: FrameMetrics = {
  droppedBeforeDecode: 0,
  droppedDuringDecode: 0,
  malformedFrames: 0,
  digestFailures: 0,
  dimensionFailures: 0,
};

export interface FrameRenderer {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  metrics: FrameMetrics;
  handleFrame: (record: ArrayBuffer) => Promise<void>;
  clear: () => void;
  resume: () => void;
}

export function useFrameRenderer(bridge: WorkspaceApi, publicState: PublicWorkspaceState): FrameRenderer {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const publicStateRef = useRef(publicState);
  const generationRef = useRef(0);
  const acceptingRef = useRef(Boolean(publicState.selected));
  const sequenceRef = useRef(new FrameSequenceWatermark());
  const [metrics, setMetrics] = useState<FrameMetrics>(emptyMetrics);
  publicStateRef.current = publicState;

  const clear = useCallback(() => {
    generationRef.current += 1;
    sequenceRef.current.reset();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) {
      canvas.removeAttribute("data-frame-sequence");
      canvas.style.width = "0px";
      canvas.style.height = "0px";
    }
    setMetrics((current) => ({ ...emptyMetrics, droppedBeforeDecode: current.droppedBeforeDecode, droppedDuringDecode: current.droppedDuringDecode }));
  }, []);

  const resume = useCallback(() => {
    generationRef.current += 1;
    sequenceRef.current.reset();
    acceptingRef.current = Boolean(publicStateRef.current.selected);
  }, []);

  const selectionKey = publicState.selected
    ? `${publicState.snapshot?.browserdRuntimeInstanceId ?? ""}:${publicState.selected.selectionId}:${publicState.selected.browserSessionId}:${publicState.selected.tabId}`
    : "none";
  useEffect(() => {
    clear();
    acceptingRef.current = Boolean(publicState.selected);
  }, [selectionKey, clear, publicState.selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitCanvas(canvas));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleFrame = useCallback(async (record: ArrayBuffer) => {
    const frontendReceived = performance.now();
    const receivedType = frontendBinaryType(record);
    let deliveryId: number | undefined;
    let disposition: FrameDispositionCore = { outcome: "dropped", frontendType: receivedType, reason: "malformed" };
    let maximumFrontendImageBitmaps: 0 | 1 = 0;
    let frame;
    try {
      frame = decodeFrameEnvelope(record);
      deliveryId = frame.metadata.deliveryId;
    } catch {
      setMetrics((current) => ({ ...current, malformedFrames: current.malformedFrames + 1, lastDropReason: "malformed" }));
      return;
    }

    try {
      const beforeReason = acceptingRef.current ? frameRejectionReason(frame.metadata, publicStateRef.current, sequenceRef.current.current()) : "selection";
      if (beforeReason) {
        disposition = { outcome: "dropped", frontendType: receivedType, reason: beforeReason === "selection" ? "selection" : "selection-changed" };
        setMetrics((current) => ({ ...current, droppedBeforeDecode: current.droppedBeforeDecode + 1, lastDropReason: beforeReason }));
        return;
      }
      const generation = generationRef.current;
      const decodeStarted = performance.now();
      if (!(await verifyFrameDigest(frame))) {
        disposition = { outcome: "dropped", frontendType: receivedType, reason: "digest" };
        setMetrics((current) => ({ ...current, digestFailures: current.digestFailures + 1, lastDropReason: "digest" }));
        return;
      }
      if (!acceptingRef.current || generation !== generationRef.current || frameRejectionReason(frame.metadata, publicStateRef.current, sequenceRef.current.current())) {
        disposition = { outcome: "dropped", frontendType: receivedType, reason: "selection-changed" };
        setMetrics((current) => ({ ...current, droppedDuringDecode: current.droppedDuringDecode + 1, lastDropReason: "selection-changed" }));
        return;
      }

      const blob = new Blob([frame.bytes.slice()], { type: frame.metadata.mediaType });
      const bitmap = await createImageBitmap(blob);
      maximumFrontendImageBitmaps = 1;
      try {
        if (bitmap.width !== frame.metadata.width || bitmap.height !== frame.metadata.height) {
          disposition = { outcome: "dropped", frontendType: receivedType, reason: "decoded-dimensions" };
          setMetrics((current) => ({ ...current, dimensionFailures: current.dimensionFailures + 1, lastDropReason: "decoded-dimensions" }));
          return;
        }
        if (!acceptingRef.current || generation !== generationRef.current || frameRejectionReason(frame.metadata, publicStateRef.current, sequenceRef.current.current())) {
          disposition = { outcome: "dropped", frontendType: receivedType, reason: "selection-changed" };
          setMetrics((current) => ({ ...current, droppedDuringDecode: current.droppedDuringDecode + 1, lastDropReason: "selection-changed" }));
          return;
        }

        const decodedAt = performance.now();
        await nextPaint();
        if (!acceptingRef.current || generation !== generationRef.current || frameRejectionReason(frame.metadata, publicStateRef.current, sequenceRef.current.current())) {
          disposition = { outcome: "dropped", frontendType: receivedType, reason: "selection-changed" };
          setMetrics((current) => ({ ...current, droppedDuringDecode: current.droppedDuringDecode + 1, lastDropReason: "selection-changed" }));
          return;
        }
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !context) { disposition = { outcome: "dropped", frontendType: receivedType, reason: "missing-canvas" }; return; }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        fitCanvas(canvas);
        const paintStarted = performance.now();
        context.drawImage(bitmap, 0, 0);
        sequenceRef.current.commit(frame.metadata.frameSequence);
        const paintedAt = performance.now();
        canvas.dataset.frameSequence = String(frame.metadata.frameSequence);
        const published = Date.parse(frame.metadata.publishedAt);
        const received = Date.parse(frame.metadata.receivedAt);
        disposition = {
          outcome: "painted",
          frontendType: receivedType,
          decodeMs: decodedAt - decodeStarted,
          paintMs: paintedAt - paintStarted,
          totalMs: boundedDifference(performance.timeOrigin + paintedAt, published) ?? 0,
          decodedAt: new Date(performance.timeOrigin + decodedAt).toISOString(),
          paintedAt: new Date(performance.timeOrigin + paintedAt).toISOString(),
        };
        setMetrics((current) => ({
          ...current,
          metadata: frame.metadata,
          decodedAt: new Date(performance.timeOrigin + decodedAt).toISOString(),
          paintedAt: new Date(performance.timeOrigin + paintedAt).toISOString(),
          socketToRustMs: boundedDifference(received, published),
          rustToFrontendMs: boundedDifference(performance.timeOrigin + frontendReceived, received),
          decodeMs: decodedAt - decodeStarted,
          paintMs: paintedAt - paintStarted,
          totalMs: boundedDifference(performance.timeOrigin + paintedAt, published),
          lastDropReason: undefined,
        }));
      } finally {
        bitmap.close();
      }
    } catch {
      disposition = { outcome: "dropped", frontendType: receivedType, reason: "decode" };
      setMetrics((current) => ({ ...current, malformedFrames: current.malformedFrames + 1, lastDropReason: "decode" }));
    } finally {
      if (deliveryId !== undefined) {
        const retention: FrameDisposition = {
          ...disposition,
          frontendRetainedFrames: sequenceRef.current.current() > 0 ? 1 : 0,
          frontendImageBitmaps: 0,
          maximumFrontendImageBitmaps,
        };
        await bridge.acknowledgeFrame(deliveryId, retention).catch(() => undefined);
      }
    }
  }, [bridge]);

  return { canvasRef, metrics, handleFrame, clear, resume };
}

export function FrameViewport({ canvasRef, state, frameAgeMs }: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  state: "idle" | "connecting" | "live" | "stale" | "unsupported" | "crashed";
  frameAgeMs?: number;
}) {
  const message = state === "idle" ? "Select a browser tab to begin viewing."
    : state === "connecting" ? "Connecting to the selected browser tab…"
      : state === "stale" ? "The latest browser frame is stale. Waiting for an update…"
        : state === "unsupported" ? "This browser frame format is not supported."
          : state === "crashed" ? "The selected browser tab has crashed or closed."
            : undefined;
  return (
    <section className="viewport" aria-label="Selected browser screenshot">
      <canvas ref={canvasRef} className="frame-canvas" aria-label="Live read-only browser screenshot" />
      {message && <div className="viewport-state" role="status"><span className="viewport-state-icon" aria-hidden="true" />{message}</div>}
      {state === "live" && frameAgeMs !== undefined && <span className="frame-age">{formatFrameAge(frameAgeMs)}</span>}
    </section>
  );
}

function fitCanvas(canvas: HTMLCanvasElement): void {
  const container = canvas.parentElement;
  if (!container || canvas.width < 1 || canvas.height < 1) return;
  const availableWidth = Math.max(1, container.clientWidth);
  const availableHeight = Math.max(1, container.clientHeight);
  const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
  canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
  canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 100);
    requestAnimationFrame(() => { if (!settled) { settled = true; window.clearTimeout(timer); resolve(); } });
  });
}

function boundedDifference(later: number, earlier: number): number | undefined {
  const value = later - earlier;
  return Number.isFinite(value) && Math.abs(value) < 86_400_000 ? Math.max(0, value) : undefined;
}

function formatFrameAge(age: number): string {
  if (age < 1_000) return "Live";
  return `${Math.floor(age / 1_000)}s old`;
}
