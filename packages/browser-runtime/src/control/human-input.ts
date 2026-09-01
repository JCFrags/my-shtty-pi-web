import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BrowserProtocolError, type WorkspaceBrokerRequest } from "@webx/browser-protocol";
import type { DirectHumanInputEvent, DirectHumanInputResult, SessionMotor } from "../motor/session-motor.js";
import type { TabRecord } from "../targets/registry.js";

export interface HumanInputAcknowledgement {
  readonly kind: "workspaceInputAck";
  readonly inputBatchSequence: number;
  readonly acceptedEventCount: number;
  readonly coalescedPointerMoveCount: number;
  readonly awaitingNewFrame: boolean;
}

type WorkspaceInputBatchRequest = Extract<WorkspaceBrokerRequest, { readonly kind: "workspace.input.batch" }>;

interface RetainedAcknowledgement {
  readonly operationId: string;
  readonly semanticDigest: string;
  readonly acknowledgement: HumanInputAcknowledgement;
}

interface ActiveTarget {
  readonly tabId: string;
  readonly controlEpoch: number;
}

const RATE_WINDOW_MS = 1_000;
const MAX_POINTER_ADMISSION_PER_SECOND = 120;
const MAX_POINTER_DISPATCH_PER_SECOND = 60;
const MAX_WHEEL_DISPATCH_PER_SECOND = 30;
const MAX_KEY_TRANSITIONS_PER_SECOND = 256;
const MAX_TEXT_BYTES_PER_SECOND = 16 * 1024;
const MAX_RETAINED_ACKNOWLEDGEMENTS = 32;

/** A bounded human-only admission lane over the SessionMotor's shared CDP and held-input state. */
export class HumanInputController {
  private target: ActiveTarget | undefined;
  private active: Promise<DirectHumanInputResult> | undefined;
  private activeAbort: AbortController | undefined;
  private readonly acknowledgements = new Map<number, RetainedAcknowledgement>();
  #inputFingerprintKey: Buffer | undefined;
  private pointerAdmission: number[] = [];
  private pointerDispatch: number[] = [];
  private wheelDispatch: number[] = [];
  private keyTransitions: number[] = [];
  private textBytes: Array<{ readonly at: number; readonly value: number }> = [];
  private mutationFrameSequence: number | undefined;

  constructor(private readonly motor: SessionMotor, private readonly now: () => number = () => performance.now()) {}

  start(tabId: string, controlEpoch: number): void {
    if (this.active !== undefined) throw new BrowserProtocolError("CONTROL_TRANSFER_PENDING", "Human input has not settled.", true);
    this.destroyFingerprintKey();
    this.#inputFingerprintKey = randomBytes(32);
    this.target = { tabId, controlEpoch };
    this.acknowledgements.clear();
    this.mutationFrameSequence = undefined;
    this.clearRates();
  }

  stop(): void {
    this.target = undefined;
    this.destroyFingerprintKey();
    this.activeAbort?.abort(new BrowserProtocolError("CONTROL_TRANSFER_PENDING", "Human input was stopped.", true));
  }

  assertTarget(tabId: string, controlEpoch: number): void {
    if (this.target?.tabId !== tabId || this.target.controlEpoch !== controlEpoch) {
      throw new BrowserProtocolError("CONTROL_TRANSFER_PENDING", "Human input target is not active.", true);
    }
  }

  semanticFingerprint(request: WorkspaceInputBatchRequest): string {
    const key = this.#inputFingerprintKey;
    if (key === undefined) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser input fingerprint scope is unavailable.", false);
    try {
      return createHmac("sha256", key).update(canonicalInputBatch(request)).digest("base64url");
    } catch {
      throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser input fingerprint could not be computed.", false);
    }
  }

  retainedAcknowledgement(inputBatchSequence: number, operationId: string, semanticDigest: string): HumanInputAcknowledgement | undefined {
    const retained = this.acknowledgements.get(inputBatchSequence);
    if (retained !== undefined) {
      if (retained.operationId !== operationId || !sameDigest(retained.semanticDigest, semanticDigest)) throw inputRetryConflict();
      return retained.acknowledgement;
    }
    for (const prior of this.acknowledgements.values()) if (prior.operationId === operationId) throw inputRetryConflict();
    return undefined;
  }

  retainAcknowledgement(operationId: string, semanticDigest: string, acknowledgement: HumanInputAcknowledgement): void {
    this.acknowledgements.set(acknowledgement.inputBatchSequence, { operationId, semanticDigest, acknowledgement });
    while (this.acknowledgements.size > MAX_RETAINED_ACKNOWLEDGEMENTS) {
      const first = this.acknowledgements.keys().next().value as number | undefined;
      if (first === undefined) break;
      this.acknowledgements.delete(first);
    }
  }

  assertFrameGuard(frameSequence: number, events: readonly DirectHumanInputEvent[]): void {
    if (this.mutationFrameSequence !== undefined && frameSequence > this.mutationFrameSequence) this.mutationFrameSequence = undefined;
    if (!containsStateChangingInput(events)) return;
    if (this.mutationFrameSequence !== undefined) {
      throw new BrowserProtocolError("INPUT_FRAME_STALE", "Browser input is awaiting a newer painted frame.", true);
    }
  }

  noteFrameGuard(frameSequence: number, events: readonly DirectHumanInputEvent[]): boolean {
    if (!containsStateChangingInput(events)) return this.mutationFrameSequence !== undefined;
    this.mutationFrameSequence = frameSequence;
    return true;
  }

  async dispatch(tab: TabRecord, controlEpoch: number, events: readonly DirectHumanInputEvent[], beforeDispatch: () => void, signal?: AbortSignal): Promise<{ readonly result: DirectHumanInputResult; readonly coalescedPointerMoveCount: number }> {
    this.assertTarget(tab.tabId, controlEpoch);
    if (this.active !== undefined) throw new BrowserProtocolError("INPUT_RATE_LIMITED", "A browser input batch is already in flight.", true);
    const coalesced = coalescePointerMoves(events);
    this.motor.assertHumanInputTransitions(coalesced.events);
    this.admit(events, coalesced.events);
    beforeDispatch();
    const controller = new AbortController();
    this.activeAbort = controller;
    const detach = linkAbort(signal, controller);
    const active = this.motor.dispatchHumanInput(tab, coalesced.events, controller.signal);
    this.active = active;
    try {
      const result = await active;
      return { result, coalescedPointerMoveCount: coalesced.removed };
    } finally {
      detach();
      if (this.active === active) this.active = undefined;
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  async awaitSettlement(signal: AbortSignal): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { cleanup(); reject(signal.reason ?? new BrowserProtocolError("CONTROL_TRANSFER_PENDING", "Human input settlement was cancelled.", true)); };
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      active.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private admit(original: readonly DirectHumanInputEvent[], dispatched: readonly DirectHumanInputEvent[]): void {
    const now = this.now();
    this.pruneRates(now);
    const pointerAdmission = original.filter((event) => event.kind === "pointerMove").length;
    const pointerDispatch = dispatched.filter((event) => event.kind === "pointerMove").length;
    const wheels = dispatched.filter((event) => event.kind === "wheel").length;
    const keys = dispatched.filter((event) => event.kind === "keyDown" || event.kind === "keyUp").length;
    const textBytes = dispatched.reduce((sum, event) => sum + (event.kind === "text" ? new TextEncoder().encode(event.text).byteLength : 0), 0);
    if (this.pointerAdmission.length + pointerAdmission > MAX_POINTER_ADMISSION_PER_SECOND
      || this.pointerDispatch.length + pointerDispatch > MAX_POINTER_DISPATCH_PER_SECOND
      || this.wheelDispatch.length + wheels > MAX_WHEEL_DISPATCH_PER_SECOND
      || this.keyTransitions.length + keys > MAX_KEY_TRANSITIONS_PER_SECOND
      || this.textBytes.reduce((sum, item) => sum + item.value, 0) + textBytes > MAX_TEXT_BYTES_PER_SECOND) {
      throw new BrowserProtocolError("INPUT_RATE_LIMITED", "Browser input rate is limited.", true);
    }
    appendTimes(this.pointerAdmission, pointerAdmission, now);
    appendTimes(this.pointerDispatch, pointerDispatch, now);
    appendTimes(this.wheelDispatch, wheels, now);
    appendTimes(this.keyTransitions, keys, now);
    if (textBytes > 0) this.textBytes.push({ at: now, value: textBytes });
  }

  private pruneRates(now: number): void {
    const keepAfter = now - RATE_WINDOW_MS;
    this.pointerAdmission = this.pointerAdmission.filter((at) => at > keepAfter);
    this.pointerDispatch = this.pointerDispatch.filter((at) => at > keepAfter);
    this.wheelDispatch = this.wheelDispatch.filter((at) => at > keepAfter);
    this.keyTransitions = this.keyTransitions.filter((at) => at > keepAfter);
    this.textBytes = this.textBytes.filter((item) => item.at > keepAfter);
  }

  private clearRates(): void {
    this.pointerAdmission = [];
    this.pointerDispatch = [];
    this.wheelDispatch = [];
    this.keyTransitions = [];
    this.textBytes = [];
  }

  private destroyFingerprintKey(): void {
    this.#inputFingerprintKey?.fill(0);
    this.#inputFingerprintKey = undefined;
  }
}

function coalescePointerMoves(events: readonly DirectHumanInputEvent[]): { readonly events: DirectHumanInputEvent[]; readonly removed: number } {
  const result: DirectHumanInputEvent[] = [];
  let pending: Extract<DirectHumanInputEvent, { readonly kind: "pointerMove" }> | undefined;
  let removed = 0;
  const flush = (): void => { if (pending !== undefined) { result.push(pending); pending = undefined; } };
  for (const event of events) {
    if (event.kind === "pointerMove") {
      if (pending !== undefined) removed++;
      pending = event;
    } else {
      flush();
      result.push(event);
    }
  }
  flush();
  return { events: result, removed };
}

function containsStateChangingInput(events: readonly DirectHumanInputEvent[]): boolean {
  return events.some((event) => event.kind === "pointerUp" || event.kind === "wheel" || event.kind === "text" || event.kind === "keyDown");
}

function appendTimes(values: number[], count: number, at: number): void {
  for (let index = 0; index < count; index++) values.push(at);
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}

function canonicalInputBatch(request: WorkspaceInputBatchRequest): string {
  return JSON.stringify({
    version: 1,
    browserSessionId: request.browserSessionId,
    tabId: request.tabId,
    controlEpoch: request.controlEpoch,
    inputTargetGeneration: request.inputTargetGeneration,
    frame: {
      runtimeInstanceId: request.frame.runtimeInstanceId,
      subscriptionId: request.frame.subscriptionId,
      controlEpoch: request.frame.controlEpoch,
      frameSequence: request.frame.frameSequence,
      documentGeneration: request.frame.documentGeneration,
      viewportGeneration: request.frame.viewportGeneration,
      imagePixelWidth: request.frame.imagePixelWidth,
      imagePixelHeight: request.frame.imagePixelHeight,
    },
    inputBatchSequence: request.inputBatchSequence,
    events: request.events.map(canonicalInputEvent),
  });
}

function canonicalInputEvent(event: WorkspaceInputBatchRequest["events"][number]): Record<string, unknown> {
  if (event.kind === "pointerMove") return { kind: event.kind, imageX: event.point.imageX, imageY: event.point.imageY };
  if (event.kind === "pointerDown" || event.kind === "pointerUp") return { kind: event.kind, imageX: event.point.imageX, imageY: event.point.imageY, button: event.button, clickCount: event.clickCount ?? 1 };
  if (event.kind === "wheel") return { kind: event.kind, imageX: event.point.imageX, imageY: event.point.imageY, deltaX: event.deltaX, deltaY: event.deltaY };
  if (event.kind === "keyDown") return { kind: event.kind, key: event.key, code: event.code ?? null, location: event.location ?? 0, modifiers: event.modifiers ?? 0, repeat: event.repeat ?? false };
  if (event.kind === "keyUp") return { kind: event.kind, key: event.key, code: event.code ?? null, location: event.location ?? 0, modifiers: event.modifiers ?? 0 };
  return { kind: "text", text: event.text };
}

function inputRetryConflict(): BrowserProtocolError {
  return new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "Browser input retry conflicts with an earlier batch.", false);
}
function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
