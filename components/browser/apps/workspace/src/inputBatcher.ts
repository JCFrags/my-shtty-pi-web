import type { HumanInputEvent, InputAck } from "./bridge";

export interface InputBatcherMetrics {
  acceptedEvents: number;
  coalescedPointerMoves: number;
  maximumPendingEvents: number;
  emittedBatches: number;
}

export class BoundedInputBatcher {
  readonly #pending: HumanInputEvent[] = [];
  readonly #maximumPending: number;
  readonly #maximumBatch: number;
  readonly #metrics: InputBatcherMetrics = { acceptedEvents: 0, coalescedPointerMoves: 0, maximumPendingEvents: 0, emittedBatches: 0 };

  constructor(maximumPending = 64, maximumBatch = 32) {
    if (!Number.isSafeInteger(maximumPending) || !Number.isSafeInteger(maximumBatch) || maximumBatch < 1 || maximumBatch > 32 || maximumPending < maximumBatch || maximumPending > 128) throw new TypeError("Input queue bounds are invalid");
    this.#maximumPending = maximumPending;
    this.#maximumBatch = maximumBatch;
  }

  push(event: HumanInputEvent): void {
    const last = this.#pending.at(-1);
    if (event.kind === "pointerMove" && last?.kind === "pointerMove") {
      this.#pending[this.#pending.length - 1] = event;
      this.#metrics.acceptedEvents++;
      this.#metrics.coalescedPointerMoves++;
      return;
    }
    if (this.#pending.length >= this.#maximumPending) throw new RangeError("Input queue capacity was reached");
    this.#pending.push(event);
    this.#metrics.acceptedEvents++;
    this.#metrics.maximumPendingEvents = Math.max(this.#metrics.maximumPendingEvents, this.#pending.length);
  }

  drain(): HumanInputEvent[] {
    if (this.#pending.length === 0) return [];
    this.#metrics.emittedBatches++;
    return this.#pending.splice(0, this.#maximumBatch);
  }

  discardPending(): number { return this.#pending.splice(0).length; }

  get pendingEvents(): number { return this.#pending.length; }
  metrics(): InputBatcherMetrics { return { ...this.#metrics }; }
}

export class FreshFrameInputPump {
  readonly #batcher: BoundedInputBatcher;
  readonly #dispatch: (events: HumanInputEvent[]) => Promise<InputAck>;
  readonly #failed: () => void;
  readonly #barrierChanged: (awaitingFreshFrame: boolean) => void;
  readonly #frameWaiters = new Set<(ready: boolean) => void>();
  #inflight?: Promise<void>;
  #paintToken?: number;
  #barrierToken?: number;
  #awaitingFreshFrame = false;

  constructor(dispatch: (events: HumanInputEvent[]) => Promise<InputAck>, failed: () => void, barrierChanged: (awaitingFreshFrame: boolean) => void = () => undefined, maximumPending = 64, maximumBatch = 32) {
    this.#dispatch = dispatch;
    this.#failed = failed;
    this.#barrierChanged = barrierChanged;
    this.#batcher = new BoundedInputBatcher(maximumPending, maximumBatch);
  }

  push(event: HumanInputEvent): void { this.#batcher.push(event); void this.pump(); }

  async dispatchReleases(events: HumanInputEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (events.some((event) => event.kind !== "pointerUp" && event.kind !== "keyUp")) throw new TypeError("Only release transitions may bypass the fresh-frame barrier");
    while (this.#inflight !== undefined) await this.#inflight;
    const run = (async () => {
      for (let offset = 0; offset < events.length; offset += 32) {
        const acknowledgement = await this.#dispatch(events.slice(offset, offset + 32));
        if (acknowledgement.awaitingNewFrame) this.requireFreshFrame(acknowledgement.resumeAfterDeliveryId);
      }
    })().finally(() => { this.#inflight = undefined; });
    this.#inflight = run;
    await run;
  }

  discardPending(): number { return this.#batcher.discardPending(); }
  get pendingEvents(): number { return this.#batcher.pendingEvents; }
  get awaitingFrame(): boolean { return this.#awaitingFreshFrame; }

  requireFreshFrame(afterDeliveryId = this.#paintToken): void {
    const barrier = this.#barrierToken === undefined
      ? afterDeliveryId
      : afterDeliveryId === undefined
        ? this.#barrierToken
        : Math.max(this.#barrierToken, afterDeliveryId);
    this.#barrierToken = barrier;
    // A qualifying delivery can finish painting while the input IPC response is
    // still in flight. Do not close admission after that newer paint has already
    // satisfied the exact delivery fence returned by Rust.
    if (barrier !== undefined && this.#paintToken !== undefined && this.#paintToken > barrier) {
      if (this.#awaitingFreshFrame) {
        this.#awaitingFreshFrame = false;
        this.#barrierToken = undefined;
        this.#barrierChanged(false);
        for (const settle of this.#frameWaiters) settle(true);
        this.#frameWaiters.clear();
        void this.pump();
      } else {
        this.#barrierToken = undefined;
      }
      return;
    }
    if (!this.#awaitingFreshFrame) { this.#awaitingFreshFrame = true; this.#barrierChanged(true); }
  }

  painted(token: number | undefined): void {
    this.#paintToken = token;
    if (!this.#awaitingFreshFrame || token === undefined || (this.#barrierToken !== undefined && token <= this.#barrierToken)) return;
    this.#awaitingFreshFrame = false;
    this.#barrierToken = undefined;
    this.#barrierChanged(false);
    for (const settle of this.#frameWaiters) settle(true);
    this.#frameWaiters.clear();
    void this.pump();
  }

  async waitForFreshFrame(timeoutMs = 2_000): Promise<boolean> {
    if (!this.#awaitingFreshFrame) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#frameWaiters.delete(done);
        resolve(ready);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.#frameWaiters.add(done);
    });
  }

  async settle(): Promise<void> {
    const current = this.#inflight;
    if (current !== undefined) await current;
    if (!this.#awaitingFreshFrame && this.#batcher.pendingEvents > 0) await this.pump();
  }

  async pump(): Promise<void> {
    const current = this.#inflight;
    if (current !== undefined) return await current;
    if (this.#awaitingFreshFrame) return;
    const run = (async () => {
      while (!this.#awaitingFreshFrame) {
        const events = this.#batcher.drain();
        if (events.length === 0) break;
        const acknowledgement = await this.#dispatch(events);
        if (acknowledgement.awaitingNewFrame) { this.requireFreshFrame(acknowledgement.resumeAfterDeliveryId); break; }
      }
    })().catch(() => {
      this.#batcher.discardPending();
      this.#failed();
    }).finally(() => { this.#inflight = undefined; });
    this.#inflight = run;
    await run;
  }
}
