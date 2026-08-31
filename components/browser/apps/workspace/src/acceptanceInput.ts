// A fixed step includes bounded humanized replay plus capture, decode, paint,
// and acknowledgement. Six seconds stays below the production input deadline
// while avoiding a false failure near the prior four-second combined bound.
const STEP_TIMEOUT_MS = 6_000;

export interface AcceptanceInputResult { readonly eventCount: number; readonly full: boolean }

export async function runFixedAcceptanceHold(canvas: HTMLCanvasElement): Promise<AcceptanceInputResult> {
  if (!canvas.isContentEditable || canvas.width < 1 || canvas.height < 1) throw new Error("acceptance input is not ready");
  canvas.focus();
  const point = clientPoint(canvas, 500, 330);
  canvas.dispatchEvent(pointerEvent("pointerdown", point, 0, 1, 71));
  await waitForFreshAdmission(canvas);
  canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
  await waitForFreshAdmission(canvas);
  return { eventCount: 2, full: false };
}

export async function runFixedAcceptanceInput(canvas: HTMLCanvasElement, full: boolean, dispatchText: (text: string) => void): Promise<AcceptanceInputResult> {
  if (!canvas.isContentEditable || canvas.width < 1 || canvas.height < 1) throw new Error("acceptance input is not ready");
  canvas.focus();
  let eventCount = 0;

  eventCount += dispatchPointerPair(canvas, 190, 126, 0, 1);
  await waitForFreshAdmission(canvas);
  if (!full) return { eventCount, full };

  eventCount += dispatchPointerPair(canvas, 440, 126, 0, 1);
  await waitForFreshAdmission(canvas);
  eventCount += dispatchPointerPair(canvas, 440, 126, 0, 2);
  await waitForFreshAdmission(canvas);

  eventCount += dispatchPointerPair(canvas, 440, 190, 1, 1);
  await waitForFreshAdmission(canvas);
  eventCount += dispatchPointerPair(canvas, 440, 250, 2, 1);
  await waitForFreshAdmission(canvas);

  const start = clientPoint(canvas, 480, 330);
  const finish = clientPoint(canvas, 650, 430);
  canvas.dispatchEvent(pointerEvent("pointerdown", start, 0, 1, 41)); eventCount += 1;
  for (let step = 1; step <= 5; step++) {
    const point = { x: start.x + (finish.x - start.x) * step / 5, y: start.y + (finish.y - start.y) * step / 5 };
    canvas.dispatchEvent(pointerEvent("pointermove", point, 0, 1, 41)); eventCount += 1;
  }
  await nextAnimationFrame();
  canvas.dispatchEvent(pointerEvent("pointerup", finish, 0, 1, 41)); eventCount += 1;
  await waitForFreshAdmission(canvas);

  const wheel = clientPoint(canvas, 500, 480);
  canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: wheel.x, clientY: wheel.y, deltaY: 120 })); eventCount += 1;
  await waitForFreshAdmission(canvas);

  eventCount += dispatchPointerPair(canvas, 190, 206, 0, 1);
  await waitForFreshAdmission(canvas);

  dispatchText(`phase3b-private-input-${crypto.randomUUID()}-π雪`);
  eventCount += 1;
  await waitForFreshAdmission(canvas);

  canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" })); eventCount += 1;
  canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", repeat: true })); eventCount += 1;
  canvas.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" })); eventCount += 1;
  await waitForFreshAdmission(canvas);
  return { eventCount, full };
}

function dispatchPointerPair(canvas: HTMLCanvasElement, imageX: number, imageY: number, button: number, detail: number): number {
  const point = clientPoint(canvas, imageX, imageY);
  const pointerId = 10 + button;
  canvas.dispatchEvent(pointerEvent("pointerdown", point, button, detail, pointerId));
  canvas.dispatchEvent(pointerEvent("pointerup", point, button, detail, pointerId));
  return 2;
}

function pointerEvent(type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }, button: number, detail: number, pointerId: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button, buttons: type === "pointerup" ? 0 : 1 << button, detail, pointerId, pointerType: "mouse", isPrimary: true });
}

function clientPoint(canvas: HTMLCanvasElement, imageX: number, imageY: number): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) throw new Error("acceptance canvas has no bounds");
  return {
    x: bounds.left + Math.max(0, Math.min(canvas.width, imageX)) * bounds.width / canvas.width,
    y: bounds.top + Math.max(0, Math.min(canvas.height, imageY)) * bounds.height / canvas.height,
  };
}

async function waitForFreshAdmission(canvas: HTMLCanvasElement): Promise<void> {
  await sleep(300);
  const deadline = performance.now() + STEP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (canvas.isContentEditable) return;
    await sleep(20);
  }
  throw new Error("acceptance fresh-frame barrier timed out");
}

function nextAnimationFrame(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
