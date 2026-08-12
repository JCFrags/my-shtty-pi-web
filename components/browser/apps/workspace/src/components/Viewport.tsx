import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  acceptFrame,
  mapViewportPoint,
  type SafeFailure,
  type ViewportGeometry,
  type ViewportLease,
  type ViewportState,
  type WorkspaceFrame,
} from "../model";

export interface ViewportHandle {
  releasePressedInput: () => Promise<void>;
}

interface Props {
  lease?: ViewportLease;
  controlEpoch?: number;
  fixtureFrameUrl?: string;
  fixtureState?: ViewportState;
  onTakeover: (expectedControlEpoch: number) => Promise<number>;
  onFrame: (lease: ViewportLease) => Promise<WorkspaceFrame>;
  onInput: (lease: ViewportLease, frame: WorkspaceFrame, controlEpoch: number, sequence: number, action: Record<string, unknown>) => Promise<void>;
  onState: (state: ViewportState, frameAgeMs?: number) => void;
  onFailure: (failure: SafeFailure) => void;
}

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(
  { lease, controlEpoch, fixtureFrameUrl, fixtureState, onTakeover, onFrame, onInput, onState, onFailure },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const epochRef = useRef(controlEpoch ?? 0);
  const inputSequence = useRef(0);
  const lastFrameSequence = useRef(0);
  const lastFrameAt = useRef<number | undefined>(undefined);
  const currentFrame = useRef<WorkspaceFrame | undefined>(undefined);
  const currentGeometry = useRef<ViewportGeometry | undefined>(undefined);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const pressedButtons = useRef<Set<string>>(new Set());
  const pressedKeys = useRef<Map<string, string>>(new Map());
  const pointerMoveFrame = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState<ViewportState>(lease ? "connecting" : "unselected");

  useEffect(() => { epochRef.current = controlEpoch ?? 0; }, [controlEpoch]);

  const setViewportState = (next: ViewportState, age?: number) => {
    setStatus(next);
    onState(next, age);
  };

  const send = async (action: Record<string, unknown>) => {
    if (!lease) throw new Error("viewport lease unavailable");
    const frame = currentFrame.current ?? await onFrame(lease);
    await onInput(lease, frame, epochRef.current, ++inputSequence.current, action);
    currentFrame.current = undefined;
  };

  const enqueueInput = (action: Record<string, unknown>) => {
    if (!lease?.inputSupported || status !== "live") return;
    inputQueue.current = inputQueue.current.then(async () => {
      if (epochRef.current === lease.identity.controlEpoch) epochRef.current = await onTakeover(epochRef.current);
      await send(action);
    }).catch(() => onFailure({ code: "control_conflict", message: "Control changed in another workspace.", recovery: "refresh" }));
  };

  useImperativeHandle(ref, () => ({
    releasePressedInput: async () => {
      await inputQueue.current;
      // Safety cleanup uses the latest screenshot for each dispatched release.
      for (const button of pressedButtons.current) {
        if (!currentFrame.current && lease) currentFrame.current = await onFrame(lease);
        await send({ type: "mouse_up", x: 0, y: 0, button });
      }
      pressedButtons.current.clear();
      for (const [code, key] of pressedKeys.current) {
        if (!currentFrame.current && lease) currentFrame.current = await onFrame(lease);
        await send({ type: "key_up", code, key, modifiers: 0 });
      }
      pressedKeys.current.clear();
    },
  }));

  useEffect(() => {
    if (fixtureFrameUrl) return;
    const canvas = canvasRef.current;
    lastFrameSequence.current = 0;
    lastFrameAt.current = undefined;
    currentFrame.current = undefined;
    currentGeometry.current = undefined;
    inputSequence.current = 0;
    pressedButtons.current.clear();
    pressedKeys.current.clear();
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (!lease || !canvas) { setViewportState("unselected"); return; }
    if (lease.transport === "unsupported") { setViewportState("unsupported"); return; }

    let disposed = false;
    let polling = false;
    setViewportState("connecting");
    const poll = async () => {
      if (disposed || polling || currentFrame.current) return;
      polling = true;
      try {
        const frame = await onFrame(lease);
        if (disposed) return;
        const result = acceptFrame(frame, lease, lastFrameSequence.current);
        if (result === "stale") return;
        if (result === "invalid") throw new Error("invalid frame binding");
        lastFrameSequence.current = frame.sequence;
        lastFrameAt.current = Date.parse(frame.capturedAt);
        currentFrame.current = frame;
        currentGeometry.current = frame.geometry;
        epochRef.current = frame.controlEpoch;
        const image = new Image();
        image.onload = () => {
          if (disposed) return;
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas.getContext("2d")?.drawImage(image, 0, 0, frame.width, frame.height);
          setViewportState("live", Math.max(0, Date.now() - (lastFrameAt.current ?? Date.now())));
        };
        image.src = `data:${frame.mediaType};base64,${frame.payload}`;
      } catch {
        if (!disposed) setViewportState(lastFrameAt.current ? "stale" : "reconnecting");
      } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > 5_000) setViewportState("stale", Date.now() - lastFrameAt.current);
      void poll();
    }, 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (pointerMoveFrame.current !== undefined) cancelAnimationFrame(pointerMoveFrame.current);
      inputQueue.current = Promise.resolve();
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [fixtureFrameUrl, lease?.leaseId, lease?.identity.viewportGeneration, onFrame]);

  const point = (event: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const geometry = currentGeometry.current;
    if (!lease || !geometry || !canvasRef.current) return undefined;
    return mapViewportPoint(event.clientX, event.clientY, canvasRef.current.getBoundingClientRect(), geometry);
  };

  if (fixtureFrameUrl) {
    const shownState = fixtureState ?? status;
    return <div className="viewport-shell fixture-viewport"><img src={fixtureFrameUrl} alt="Deterministic public fixture page" /><div className={`viewport-status ${shownState}`}>{shownState}</div></div>;
  }

  return (
    <div className="viewport-shell">
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        tabIndex={lease?.inputSupported ? 0 : -1}
        aria-label="Selected owned browser viewport"
        aria-disabled={!lease?.inputSupported}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") return;
          const coordinates = point(event); if (!coordinates) return;
          event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          const button = pointerButton(event.button); pressedButtons.current.add(button);
          enqueueInput({ type: "mouse_down", ...coordinates, button });
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") return;
          const coordinates = point(event); if (!coordinates) return;
          const button = pointerButton(event.button); pressedButtons.current.delete(button);
          enqueueInput({ type: "mouse_up", ...coordinates, button });
        }}
        onDoubleClick={(event) => { const coordinates = point(event); if (coordinates) enqueueInput({ type: "double_click", ...coordinates, button: "left" }); }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const coordinates = point(event); if (!coordinates) return;
          if (pointerMoveFrame.current !== undefined) cancelAnimationFrame(pointerMoveFrame.current);
          pointerMoveFrame.current = requestAnimationFrame(() => enqueueInput({ type: "mouse_move", ...coordinates }));
        }}
        onWheel={(event) => { event.preventDefault(); enqueueInput({ type: "wheel", delta_x: event.deltaX, delta_y: event.deltaY }); }}
        onKeyDown={(event) => {
          event.preventDefault(); pressedKeys.current.set(event.code, event.key);
          enqueueInput({ type: "key_down", key: event.key, code: event.code, modifiers: modifiers(event) });
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) enqueueInput({ type: "text", text: event.key });
        }}
        onKeyUp={(event) => { event.preventDefault(); pressedKeys.current.delete(event.code); enqueueInput({ type: "key_up", key: event.key, code: event.code, modifiers: modifiers(event) }); }}
      />
      <div className={`viewport-status ${status}`}>{status}</div>
    </div>
  );
});

function pointerButton(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
