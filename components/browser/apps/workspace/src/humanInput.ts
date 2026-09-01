import { useCallback, useEffect, useRef, useState, type FocusEventHandler, type FormEventHandler, type KeyboardEventHandler, type PointerEventHandler, type RefObject, type WheelEventHandler } from "react";
import type { HumanInputEvent, WorkspaceApi } from "./bridge";
import { FreshFrameInputPump } from "./inputBatcher";

export interface HumanCanvasInput {
  error?: string;
  inputReady: boolean;
  handlers: {
    tabIndex: number;
    contentEditable: boolean;
    suppressContentEditableWarning: true;
    onPointerMove: PointerEventHandler<HTMLCanvasElement>;
    onPointerDown: PointerEventHandler<HTMLCanvasElement>;
    onPointerUp: PointerEventHandler<HTMLCanvasElement>;
    onPointerCancel: PointerEventHandler<HTMLCanvasElement>;
    onLostPointerCapture: PointerEventHandler<HTMLCanvasElement>;
    onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void;
    onWheel: WheelEventHandler<HTMLCanvasElement>;
    onKeyDown: KeyboardEventHandler<HTMLCanvasElement>;
    onKeyUp: KeyboardEventHandler<HTMLCanvasElement>;
    onBeforeInput: FormEventHandler<HTMLCanvasElement>;
    onBlur: FocusEventHandler<HTMLCanvasElement>;
  };
  releaseHeld: () => Promise<void>;
  quiesceAndReturn: () => Promise<void>;
  dispatchAcceptanceText: (text: string) => void;
}

type Button = "left" | "middle" | "right";
type HeldKey = { readonly key: string; readonly location: number; readonly modifiers: number };
type ReturnControl = (cleanup: () => Promise<void>) => Promise<void>;

export function useHumanCanvasInput(bridge: WorkspaceApi, canvasRef: RefObject<HTMLCanvasElement | null>, active: boolean, paintToken: number | undefined, returnControl: ReturnControl): HumanCanvasInput {
  const bridgeRef = useRef(bridge);
  const activeRef = useRef(false);
  const admissionOpen = useRef(false);
  const returning = useRef(false);
  const returnRef = useRef(returnControl);
  const quiesceRef = useRef<() => Promise<void>>(async () => undefined);
  const heldButtons = useRef(new Set<Button>());
  const heldKeys = useRef(new Map<string, HeldKey>());
  const capturedPointers = useRef(new Set<number>());
  const releaseTail = useRef(Promise.resolve());
  const lastPoint = useRef({ imageX: 0, imageY: 0 });
  const pendingMove = useRef<{ imageX: number; imageY: number } | undefined>(undefined);
  const moveFrame = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [inputReady, setInputReady] = useState(false);
  bridgeRef.current = bridge;
  returnRef.current = returnControl;
  if (!active) admissionOpen.current = false;

  const pumpRef = useRef<FreshFrameInputPump | undefined>(undefined);
  if (pumpRef.current === undefined) {
    pumpRef.current = new FreshFrameInputPump(
      async (events) => await bridgeRef.current.input(events),
      () => {
        setError("Browser input was rejected. Returning control safely.");
        void quiesceRef.current();
      },
      (awaiting) => {
        if (awaiting) { admissionOpen.current = false; setInputReady(false); }
        else if (activeRef.current && !returning.current) { admissionOpen.current = true; setInputReady(true); }
      },
    );
  }
  const pump = pumpRef.current;

  const cancelPendingMove = useCallback(() => {
    if (moveFrame.current !== undefined) { cancelAnimationFrame(moveFrame.current); moveFrame.current = undefined; }
    pendingMove.current = undefined;
  }, []);

  const releaseDomCapture = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      for (const pointerId of capturedPointers.current) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      }
    }
    capturedPointers.current.clear();
  }, [canvasRef]);

  const releaseHeldInternal = useCallback(async (sendReleases: boolean): Promise<void> => {
    cancelPendingMove();
    releaseDomCapture();
    pump.discardPending();
    await releaseTail.current;
    await pump.settle();
    pump.discardPending();
    const releases: HumanInputEvent[] = [];
    for (const button of heldButtons.current) releases.push({ kind: "pointerUp", point: lastPoint.current, button });
    for (const [code, held] of heldKeys.current) releases.push({ kind: "keyUp", key: held.key, code, location: held.location, modifiers: held.modifiers });
    if (!sendReleases) { heldButtons.current.clear(); heldKeys.current.clear(); return; }
    if (releases.length === 0) return;
    try {
      await pump.dispatchReleases(releases);
      heldButtons.current.clear();
      heldKeys.current.clear();
    } catch {
      pump.discardPending();
      throw new Error("held input release failed");
    }
  }, [cancelPendingMove, pump, releaseDomCapture]);

  const releaseHeld = useCallback(async (): Promise<void> => {
    admissionOpen.current = false;
    setInputReady(false);
    await releaseHeldInternal(activeRef.current);
    if (activeRef.current && !returning.current && !pump.awaitingFrame) { admissionOpen.current = true; setInputReady(true); }
  }, [pump, releaseHeldInternal]);

  const quiesceAndReturn = useCallback(async (): Promise<void> => {
    if (returning.current) return;
    returning.current = true;
    admissionOpen.current = false;
    setInputReady(false);
    try {
      await returnRef.current(async () => await releaseHeldInternal(activeRef.current));
    } catch {
      returning.current = false;
      if (activeRef.current && !pump.awaitingFrame) { admissionOpen.current = true; setInputReady(true); }
    }
  }, [pump, releaseHeldInternal]);
  quiesceRef.current = quiesceAndReturn;

  useEffect(() => {
    pump.painted(paintToken);
    if (active && !activeRef.current) {
      activeRef.current = true;
      returning.current = false;
      admissionOpen.current = false;
      setInputReady(false);
      pump.requireFreshFrame();
      return;
    }
    if (!active && activeRef.current) {
      activeRef.current = false;
      returning.current = false;
      admissionOpen.current = false;
      setInputReady(false);
      setError(undefined);
      void releaseHeldInternal(false);
    }
  }, [active, paintToken, pump, releaseHeldInternal]);

  useEffect(() => {
    if (!active) return;
    const hidden = () => { if (document.visibilityState !== "visible") void releaseHeld(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { document.removeEventListener("visibilitychange", hidden); admissionOpen.current = false; void releaseHeldInternal(false); };
  }, [active, releaseHeld, releaseHeldInternal]);

  const enqueue = useCallback((event: HumanInputEvent): void => {
    if (!admissionOpen.current) return;
    try { pump.push(event); }
    catch {
      admissionOpen.current = false;
      pump.discardPending();
      setError("Browser input queue is full. Returning control safely.");
      void quiesceRef.current();
    }
  }, [pump]);

  const enqueueRelease = useCallback((event: HumanInputEvent, restoreHeld: () => void): void => {
    const next = releaseTail.current.then(async () => await pump.dispatchReleases([event]));
    releaseTail.current = next.catch(() => {
      restoreHeld();
      setError("Browser input release failed. Returning control safely.");
      queueMicrotask(() => { void quiesceRef.current(); });
    });
  }, [pump]);

  const point = useCallback((event: { clientX: number; clientY: number }): { imageX: number; imageY: number } | undefined => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width < 1 || canvas.height < 1) return undefined;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return undefined;
    const value = { imageX: (event.clientX - bounds.left) * canvas.width / bounds.width, imageY: (event.clientY - bounds.top) * canvas.height / bounds.height };
    lastPoint.current = value;
    return value;
  }, [canvasRef]);

  const onPointerMove: PointerEventHandler<HTMLCanvasElement> = (event) => {
    if (!admissionOpen.current) return;
    const mapped = point(event); if (!mapped) return;
    pendingMove.current = mapped;
    if (moveFrame.current !== undefined) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = undefined;
      const latest = pendingMove.current; pendingMove.current = undefined;
      if (latest) enqueue({ kind: "pointerMove", point: latest });
    });
  };
  const onPointerDown: PointerEventHandler<HTMLCanvasElement> = (event) => {
    if (!admissionOpen.current) return;
    const mapped = point(event); const button = pointerButton(event.button); if (!mapped || !button) return;
    event.preventDefault(); event.currentTarget.focus();
    if (event.isTrusted) { event.currentTarget.setPointerCapture(event.pointerId); capturedPointers.current.add(event.pointerId); }
    heldButtons.current.add(button); enqueue({ kind: "pointerDown", point: mapped, button, clickCount: event.detail >= 2 ? 2 : 1 });
  };
  const onPointerUp: PointerEventHandler<HTMLCanvasElement> = (event) => {
    const mapped = point(event) ?? lastPoint.current; const button = pointerButton(event.button); if (!activeRef.current || !button || !heldButtons.current.delete(button)) return;
    event.preventDefault();
    enqueueRelease({ kind: "pointerUp", point: mapped, button, clickCount: event.detail >= 2 ? 2 : 1 }, () => heldButtons.current.add(button));
    if (shouldReleasePointerCapture(heldButtons.current.size) && event.currentTarget.hasPointerCapture(event.pointerId)) {
      capturedPointers.current.delete(event.pointerId);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onPointerCancel: PointerEventHandler<HTMLCanvasElement> = () => { if (heldButtons.current.size > 0 || heldKeys.current.size > 0) void releaseHeld(); };
  const onLostPointerCapture: PointerEventHandler<HTMLCanvasElement> = (event) => { capturedPointers.current.delete(event.pointerId); if (heldButtons.current.size > 0) void releaseHeld(); };
  const onWheel: WheelEventHandler<HTMLCanvasElement> = (event) => { if (admissionOpen.current) { const mapped = point(event); if (mapped) { event.preventDefault(); enqueue({ kind: "wheel", point: mapped, deltaX: event.deltaX, deltaY: event.deltaY }); } } };
  const onKeyDown: KeyboardEventHandler<HTMLCanvasElement> = (event) => {
    if (event.ctrlKey && event.shiftKey && event.key === "Escape") { event.preventDefault(); void quiesceAndReturn(); return; }
    if (!admissionOpen.current) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault(); const code = event.code || event.key;
    const held = { key: event.key, location: event.location, modifiers: keyboardModifiers(event) };
    heldKeys.current.set(code, held); enqueue({ kind: "keyDown", key: held.key, code, location: held.location, modifiers: held.modifiers, repeat: event.repeat });
  };
  const onKeyUp: KeyboardEventHandler<HTMLCanvasElement> = (event) => {
    const code = event.code || event.key; const held = heldKeys.current.get(code); if (!activeRef.current || held === undefined) return;
    event.preventDefault(); heldKeys.current.delete(code);
    const release = { key: held.key, location: held.location, modifiers: keyboardModifiers(event) };
    enqueueRelease({ kind: "keyUp", key: release.key, code, location: release.location, modifiers: release.modifiers }, () => heldKeys.current.set(code, held));
  };
  const dispatchAcceptanceText = useCallback((text: string): void => {
    if (!admissionOpen.current || text.length < 1 || text.length > 4_096) throw new Error("acceptance text input is not ready");
    enqueue({ kind: "text", text });
  }, [enqueue]);
  const onBeforeInput: FormEventHandler<HTMLCanvasElement> = (event) => {
    if (!admissionOpen.current) return;
    const value = (event.nativeEvent as InputEvent).data;
    if (value) { event.preventDefault(); enqueue({ kind: "text", text: value }); }
  };

  return { error, inputReady, releaseHeld, quiesceAndReturn, dispatchAcceptanceText, handlers: { tabIndex: active ? 0 : -1, contentEditable: active && inputReady, suppressContentEditableWarning: true, onPointerMove, onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onContextMenu: (event) => { if (active) event.preventDefault(); }, onWheel, onKeyDown, onKeyUp, onBeforeInput, onBlur: () => { if (heldButtons.current.size > 0 || heldKeys.current.size > 0) void releaseHeld(); } } };
}

export function shouldReleasePointerCapture(heldButtonCount: number): boolean { return heldButtonCount === 0; }
function pointerButton(value: number): Button | undefined { return value === 0 ? "left" : value === 1 ? "middle" : value === 2 ? "right" : undefined; }
function keyboardModifiers(event: { readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): number {
  return Number(event.altKey) | (Number(event.ctrlKey) << 1) | (Number(event.metaKey) << 2) | (Number(event.shiftKey) << 3);
}
