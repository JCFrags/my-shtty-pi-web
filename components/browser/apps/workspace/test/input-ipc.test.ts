import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { HumanInputEvent, InputAck } from "../src/bridge";
import { shouldReleasePointerCapture } from "../src/humanInput";
import { BoundedInputBatcher, FreshFrameInputPump } from "../src/inputBatcher";

describe("bounded typed frontend-to-Rust input batching spike", () => {
  it("coalesces 10,000 pointer samples and preserves 2,000 transitions plus Unicode text within fixed queues", () => {
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const batcher = new BoundedInputBatcher(64, 32);
    const emittedKinds: string[] = [];
    let emittedEvents = 0;
    const drain = () => {
      for (const event of batcher.drain()) { emittedKinds.push(event.kind); emittedEvents++; }
    };

    for (let index = 0; index < 10_000; index++) batcher.push({ kind: "pointerMove", point: { imageX: index % 800, imageY: index % 600 } });
    expect(batcher.pendingEvents).toBe(1);
    drain();

    for (let index = 0; index < 1_000; index++) {
      batcher.push({ kind: "wheel", point: { imageX: 400, imageY: 300 }, deltaX: index % 2, deltaY: 1 });
      if (batcher.pendingEvents === 32) drain();
    }
    drain();

    for (let index = 0; index < 1_000; index++) {
      const event: HumanInputEvent = index % 2 === 0
        ? { kind: "keyDown", key: "KeyA", code: "KeyA", repeat: false }
        : { kind: "keyUp", key: "KeyA", code: "KeyA" };
      batcher.push(event);
      if (batcher.pendingEvents === 32) drain();
    }
    drain();

    for (const text of ["héllo", "世界", "🙂", "e\u0301"]) batcher.push({ kind: "text", text });
    drain();

    const elapsedMs = performance.now() - started;
    const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
    const metrics = batcher.metrics();
    expect(metrics).toMatchObject({ acceptedEvents: 12_004, coalescedPointerMoves: 9_999 });
    expect(metrics.maximumPendingEvents).toBeLessThanOrEqual(32);
    expect(batcher.pendingEvents).toBe(0);
    expect(emittedEvents).toBe(2_005);
    expect(emittedKinds.slice(1, 1_001)).toEqual(Array.from({ length: 1_000 }, () => "wheel"));
    expect(emittedKinds.slice(1_001, 2_001)).toEqual(Array.from({ length: 1_000 }, (_, index) => index % 2 === 0 ? "keyDown" : "keyUp"));
    expect(elapsedMs).toBeLessThan(5_000);
    expect(heapGrowthBytes).toBeLessThan(32 * 1024 * 1024);
  });

  it("can discard stale pending input before authoritative cleanup releases", () => {
    const batcher = new BoundedInputBatcher(32, 32);
    batcher.push({ kind: "pointerMove", point: { imageX: 1, imageY: 2 } });
    batcher.push({ kind: "keyDown", key: "Shift", code: "ShiftLeft" });
    expect(batcher.discardPending()).toBe(2);
    expect(batcher.pendingEvents).toBe(0);
    batcher.push({ kind: "keyUp", key: "Shift", code: "ShiftLeft" });
    expect(batcher.drain()).toEqual([{ kind: "keyUp", key: "Shift", code: "ShiftLeft" }]);
  });

  it("fails closed instead of growing beyond its pending-event bound", () => {
    const batcher = new BoundedInputBatcher(32, 32);
    for (let index = 0; index < 32; index++) batcher.push({ kind: "keyDown", key: "KeyA", code: "KeyA" });
    expect(() => batcher.push({ kind: "keyUp", key: "KeyA", code: "KeyA" })).toThrow("capacity");
    expect(batcher.pendingEvents).toBe(32);
  });

  it("holds queued typing behind an awaiting-new-frame acknowledgement until a different painted frame is acknowledged", async () => {
    const batches: HumanInputEvent[][] = [];
    let settleFirst: ((ack: InputAck) => void) | undefined;
    const first = new Promise<InputAck>((resolve) => { settleFirst = resolve; });
    const pump = new FreshFrameInputPump(async (events) => {
      batches.push(events);
      if (batches.length === 1) return await first;
      return { acceptedEventCount: events.length, coalescedPointerMoveCount: 0, awaitingNewFrame: false };
    }, () => { throw new Error("input pump failed"); });
    pump.painted(10);
    pump.push({ kind: "text", text: "first" });
    pump.push({ kind: "text", text: "second" });
    expect(batches).toEqual([[{ kind: "text", text: "first" }]]);
    settleFirst?.({ acceptedEventCount: 1, coalescedPointerMoveCount: 0, awaitingNewFrame: true, resumeAfterDeliveryId: 10 });
    await pump.settle();
    expect(pump.awaitingFrame).toBe(true);
    expect(pump.pendingEvents).toBe(1);
    pump.painted(10);
    await pump.settle();
    expect(batches).toHaveLength(1);
    pump.painted(11);
    await pump.settle();
    expect(batches).toEqual([[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]]);
  });

  it("dispatches release transitions while ordinary input waits for a newer painted frame", async () => {
    const batches: HumanInputEvent[][] = [];
    const pump = new FreshFrameInputPump(async (events) => {
      batches.push(events);
      return { acceptedEventCount: events.length, coalescedPointerMoveCount: 0, awaitingNewFrame: events.some((event) => event.kind !== "keyUp" && event.kind !== "pointerUp"), resumeAfterDeliveryId: 10 };
    }, () => { throw new Error("input pump failed"); });
    pump.painted(10);
    pump.requireFreshFrame(10);
    pump.push({ kind: "text", text: "wait" });
    await pump.dispatchReleases([{ kind: "keyUp", key: "Shift", code: "ShiftLeft" }]);
    expect(batches).toEqual([[{ kind: "keyUp", key: "Shift", code: "ShiftLeft" }]]);
    expect(pump.pendingEvents).toBe(1);
    expect(pump.awaitingFrame).toBe(true);
    pump.painted(11);
    await pump.settle();
    expect(batches).toEqual([
      [{ kind: "keyUp", key: "Shift", code: "ShiftLeft" }],
      [{ kind: "text", text: "wait" }],
    ]);
  });

  it("rejects non-release events on the fresh-frame bypass", async () => {
    const pump = new FreshFrameInputPump(async (events) => ({ acceptedEventCount: events.length, coalescedPointerMoveCount: 0, awaitingNewFrame: false }), () => undefined);
    await expect(pump.dispatchReleases([{ kind: "text", text: "forbidden" }])).rejects.toThrow("Only release transitions");
  });

  it("retains pointer capture until every held mouse button is released", () => {
    expect(shouldReleasePointerCapture(2)).toBe(false);
    expect(shouldReleasePointerCapture(1)).toBe(false);
    expect(shouldReleasePointerCapture(0)).toBe(true);
  });
});
