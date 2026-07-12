import { describe, it, expect, afterEach } from "vitest";
import { setup, setupMultiClient, getConnectedState } from "./helpers";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function getCollectionId(ctx: { replica?: any; client?: any }) {
  const client = ctx.client;
  const root = client.readRoot() as any;
  return root.messages.collectionId as string;
}

describe("collection subscribe (simple mode)", () => {
  it("subscribe returns all items with totalCount", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const collectionId = getCollectionId(ctx);

    const items = Array.from({ length: 50 }, (_, i) => ({
      text: `msg-${i}`,
      author: "bot",
    }));
    await ctx.client.messages.concat(items);

    await ctx.replica.postMessage({ kind: "subscribe-collection", collectionId });

    const state = getConnectedState(ctx.replica);
    const col = state.collections.find((c) => c.id === collectionId);
    expect(col).toBeDefined();
    expect(col!.totalCount).toBe(50);
    expect(col!.items.length).toBe(50);
    expect((col!.items[0] as any).text).toBe("msg-0");
    expect((col!.items[49] as any).text).toBe("msg-49");
  });

  it("concat after subscribe appends items", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const collectionId = getCollectionId(ctx);
    await ctx.replica.postMessage({ kind: "subscribe-collection", collectionId });

    await ctx.client.messages.concat([
      { text: "a", author: "alice" },
      { text: "b", author: "bob" },
    ]);

    const state = getConnectedState(ctx.replica);
    const col = state.collections.find((c) => c.id === collectionId);
    expect(col!.totalCount).toBe(2);
    expect(col!.items.length).toBe(2);
  });
});

describe("fetch-range", () => {
  it("returns items without affecting subscription state", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const collectionId = getCollectionId(ctx);
    const items = Array.from({ length: 30 }, (_, i) => ({
      text: `msg-${i}`,
      author: "bot",
    }));
    await ctx.client.messages.concat(items);

    await ctx.replica.postMessage({ kind: "subscribe-collection", collectionId });

    let state = getConnectedState(ctx.replica);
    let col = state.collections.find((c) => c.id === collectionId);
    expect(col!.items.length).toBe(30);

    await ctx.replica.postMessage({
      kind: "read",
      op: {
        type: "collection.fetch-range",
        collectionId,
        range: { start: 0, end: 5 },
      },
    });

    state = getConnectedState(ctx.replica);
    col = state.collections.find((c) => c.id === collectionId);
    expect(col!.items.length).toBe(30);
  });
});

describe("multi-replica concat", () => {
  it("concurrent concats converge on correct totalCount", async () => {
    const ctx = await setupMultiClient(2);
    cleanup = ctx.cleanup;

    const root = ctx.clients[0].readRoot() as any;
    const collectionId = root.messages.collectionId;

    await ctx.replicas[0].postMessage({ kind: "subscribe-collection", collectionId });
    await ctx.replicas[1].postMessage({ kind: "subscribe-collection", collectionId });

    await Promise.all([
      ctx.clients[0].messages.concat([{ text: "a1", author: "alice" }]),
      ctx.clients[1].messages.concat([{ text: "b1", author: "bob" }]),
    ]);

    const stateA = getConnectedState(ctx.replicas[0]);
    const colA = stateA.collections.find((c) => c.id === collectionId);
    const stateB = getConnectedState(ctx.replicas[1]);
    const colB = stateB.collections.find((c) => c.id === collectionId);

    expect(colA!.totalCount).toBe(2);
    expect(colB!.totalCount).toBe(2);
  });
});
