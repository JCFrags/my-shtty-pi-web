import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type FrameEvent, type TabAddress } from "@webx/browser-protocol";
import { BrowserArtifactStore } from "../src/artifacts/store.js";
import { bindFrameTab, FrameScheduler } from "../src/frames/scheduler.js";
import { bindObservationTab, ObservationStore, type Layout } from "../src/observations/store.js";
import { BrowserRuntime } from "../src/registry/runtime.js";
import type { TabRecord, TargetRegistry } from "../src/targets/registry.js";

const actor = { principalId: "owner:frame", agentSessionId: "agent:frame" } as const;
const other = { principalId: "owner:other", agentSessionId: "agent:other" } as const;
const address = (tab: TabRecord, controlEpoch = 1): TabAddress => ({ browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 500; index++) { if (predicate()) return; await sleep(2); } throw new Error("fixture timeout"); }
function tab(id = "a"): TabRecord { return { browserSessionId: "session:frame", tabId: `tab:${id}`, targetId: `target:${id}`, cdpSessionId: `cdp:${id}`, documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: "https://fixture.invalid/", title: "Fixture" }; }
function layout(overrides: Partial<Layout> = {}): Layout { return { url: "https://fixture.invalid/", title: "Fixture", width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0, ...overrides }; }
function registryFor(tabs: TabRecord[]): TargetRegistry {
  return {
    resolve(value: TabAddress) { const found = tabs.find((item) => item.tabId === value.tabId && item.targetId === value.targetId); if (found === undefined) throw new BrowserProtocolError("TAB_NOT_FOUND", "Tab not found."); return found; },
    getById(tabId: string) { return tabs.find((item) => item.tabId === tabId); },
    incrementFrame(value: TabRecord) { return ++value.latestFrameSequence; },
  } as unknown as TargetRegistry;
}
class FakeMotor extends EventEmitter {
  readonly state = { x: 10, y: 20, pathSequence: 1, sampleSequence: 2, personaId: "persona_test", visible: true };
  async ensureOverlay(): Promise<void> {}
}

describe("connection-scoped frame schedules", () => {
  it("keeps subscription keys unique, idempotent, epoch-scoped, and timer-bounded", async () => {
    const first = tab("a");
    const second = tab("b");
    const artifacts = new BrowserArtifactStore({ frameRingSize: 2 });
    const motor = new FakeMotor();
    const scheduler = new FrameScheduler(actor, registryFor([first, second]), artifacts, motor as never, () => 1, { selectedIntervalMs: 10_000 });
    const events: FrameEvent[] = [];
    scheduler.on("frame", (frame) => events.push(frame));
    const stable = layout();
    bindFrameTab(first, { async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: stable } } as T; return { data: Buffer.from("png-a").toString("base64") } as T; } });
    bindFrameTab(second, { async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: stable } } as T; return { data: Buffer.from("png-b").toString("base64") } as T; } });
    scheduler.subscribe("connection-a\0subscription-a", address(first));
    scheduler.subscribe("connection-a\0subscription-a", address(first));
    assert.equal(scheduler.subscriptionCount, 1);
    assert.throws(() => scheduler.subscribe("connection-a\0subscription-a", address(second)), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0]?.address, address(first));
    assert.equal((await artifacts.read(actor, events[0]?.artifactId ?? "missing")).descriptor.purpose, "workspace-frame");
    scheduler.invalidateEpoch(2);
    assert.equal(scheduler.subscriptionCount, 0);
    assert.equal(scheduler.timerCount, 0);
    scheduler.close();
  });

  it("routes a frame only to the matching connection, actor, address, and epoch", async () => {
    const runtime = new BrowserRuntime();
    const frameAddress = { browserSessionId: "session:routing", tabId: "tab:routing", targetId: "target:routing", controlEpoch: 7 };
    const subscription = { actor: "owner:frame\u0000agent:frame", connectionId: "connection:subscribed", subscriptionId: "subscription:routing", address: frameAddress, interest: "selected", consumerKey: "connection:subscribed\0subscription:routing" };
    const internal = runtime as unknown as { subscriptions: Map<string, Map<string, typeof subscription>> };
    internal.subscriptions.set("connection:subscribed", new Map([[subscription.subscriptionId, subscription]]));
    const frame = { protocolVersion: PROTOCOL_VERSION, kind: "frame.available", address: frameAddress } as FrameEvent;
    assert.equal(runtime.shouldDeliverFrame("connection:subscribed", actor, frame), true);
    assert.equal(runtime.shouldDeliverFrame("connection:unsubscribed", actor, frame), false);
    assert.equal(runtime.shouldDeliverFrame("connection:subscribed", other, frame), false);
    assert.equal(runtime.shouldDeliverFrame("connection:subscribed", actor, { ...frame, address: { ...frameAddress, controlEpoch: 8 } }), false);
    runtime.releaseConnection("connection:subscribed");
    assert.equal(runtime.subscriptionCount, 0);
    assert.equal(runtime.shouldDeliverFrame("connection:subscribed", actor, frame), false);
    await runtime.close();
  });
});

describe("artifact provenance, fairness, and lifetime", () => {
  const observation = { browserSessionId: "session:a", tabId: "tab:a", purpose: "agent-observation", mediaType: "image/png" } as const;
  it("returns truthful media/provenance and clears exact tab and session scopes", async () => {
    const store = new BrowserArtifactStore();
    const a = await store.put(actor, Uint8Array.of(1, 2, 3), observation);
    const b = await store.put(actor, Uint8Array.of(4), { ...observation, tabId: "tab:b" });
    const read = await store.read(actor, a.artifactId);
    assert.equal(read.descriptor.mediaType, "image/png");
    assert.equal(read.descriptor.browserSessionId, "session:a");
    assert.equal(read.descriptor.tabId, "tab:a");
    assert.equal(read.descriptor.purpose, "agent-observation");
    store.clearTab(actor, "session:a", "tab:a");
    await assert.rejects(() => store.read(actor, a.artifactId), (error) => error instanceof BrowserProtocolError && error.code === "ARTIFACT_NOT_FOUND");
    assert.equal((await store.read(actor, b.artifactId)).bytes.byteLength, 1);
    store.clearSession(actor, "session:a");
    assert.equal(store.entryCount, 0);
  });

  it("does not evict another owner under ordinary global pressure", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 2, maxTotalBytes: 4, maxEntriesPerOwner: 2, maxBytesPerOwner: 4, maxEntriesPerSession: 2, maxBytesPerSession: 4 });
    const foreign = await store.put(other, Uint8Array.of(8, 8), observation);
    await store.put(actor, Uint8Array.of(1, 1), observation);
    await store.put(actor, Uint8Array.of(2), observation);
    assert.equal((await store.read(other, foreign.artifactId)).bytes.byteLength, 2);
    await assert.rejects(() => store.read(actor, foreign.artifactId), (error) => error instanceof BrowserProtocolError && error.code === "ARTIFACT_NOT_FOUND");
  });

  it("keeps the bounded latest-frame ring readable and releases old pins for replacement", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 2, maxTotalBytes: 20, maxEntriesPerOwner: 2, maxEntriesPerSession: 2, frameRingSize: 2 });
    const options = { browserSessionId: "session:frame", tabId: "tab:frame", purpose: "workspace-frame", mediaType: "image/png", latestFrameKey: "session:frame\0tab:frame" } as const;
    const first = await store.put(actor, Uint8Array.of(1), options);
    const second = await store.put(actor, Uint8Array.of(2), options);
    assert.equal((await store.read(actor, second.artifactId)).bytes[0], 2);
    const third = await store.put(actor, Uint8Array.of(3), options);
    await assert.rejects(() => store.read(actor, first.artifactId));
    assert.equal((await store.read(actor, second.artifactId)).bytes[0], 2);
    assert.equal((await store.read(actor, third.artifactId)).bytes[0], 3);
  });

  it("expires unpinned artifacts and detects digest corruption", async () => {
    let now = 100;
    const store = new BrowserArtifactStore({ retentionMs: 10, now: () => now });
    const expired = await store.put(actor, Uint8Array.of(1), observation);
    now = 111;
    await assert.rejects(() => store.read(actor, expired.artifactId), (error) => error instanceof BrowserProtocolError && error.code === "ARTIFACT_NOT_FOUND");
    const corrupt = await store.put(actor, Uint8Array.of(2, 3), observation);
    const internal = store as unknown as { records: Map<string, { bytes: Uint8Array }> };
    const record = internal.records.get(corrupt.artifactId);
    if (record === undefined) throw new Error("missing record");
    record.bytes[0] = 9;
    await assert.rejects(() => store.read(actor, corrupt.artifactId), (error) => error instanceof BrowserProtocolError && error.code === "INTERNAL_ERROR");
  });
});

describe("screenshot consistency transaction", () => {
  it("retries one inconsistent capture and records metadata from completed stable capture", async () => {
    const target = tab("observation");
    const registry = registryFor([target]);
    const artifacts = new BrowserArtifactStore();
    const motor = new FakeMotor();
    let screenshotCount = 0;
    let layoutCount = 0;
    bindObservationTab(target, { async send<T>(method: string): Promise<T> {
      if (method === "Page.captureScreenshot") { screenshotCount++; return { data: Buffer.from(`png-${screenshotCount}`).toString("base64") } as T; }
      layoutCount++;
      const value = layoutCount === 2 ? layout({ scrollY: 10 }) : layout();
      return { result: { value } } as T;
    } });
    const store = new ObservationStore(actor, registry, artifacts, motor as never);
    const result = await store.capture(address(target), "artifact");
    assert.equal(screenshotCount, 2);
    assert.equal(result.scroll.y, 0);
    assert.equal(result.mediaType, "image/png");
    assert.equal(artifacts.entryCount, 1);
    assert.equal((await artifacts.read(actor, result.image.kind === "artifact" ? result.image.artifactId : "missing")).descriptor.purpose, "agent-observation");
  });

  it("rejects repeated inconsistency without retaining an artifact", async () => {
    const target = tab("unstable");
    const artifacts = new BrowserArtifactStore();
    let layoutCount = 0;
    bindObservationTab(target, { async send<T>(method: string): Promise<T> {
      if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") } as T;
      const value = layout({ scrollY: layoutCount++ * 10 });
      return { result: { value } } as T;
    } });
    const store = new ObservationStore(actor, registryFor([target]), artifacts, new FakeMotor() as never);
    await assert.rejects(() => store.capture(address(target), "artifact"), (error) => error instanceof BrowserProtocolError && error.code === "VIEWPORT_CHANGED");
    assert.equal(artifacts.entryCount, 0);
  });

  it("deletes an uncommitted artifact when cancellation arrives after storage", async () => {
    const target = tab("cancelled");
    const controller = new AbortController();
    class CancellingStore extends BrowserArtifactStore {
      override async put(...args: Parameters<BrowserArtifactStore["put"]>): ReturnType<BrowserArtifactStore["put"]> { const value = await super.put(...args); controller.abort(new Error("cancelled")); return value; }
    }
    const artifacts = new CancellingStore();
    bindObservationTab(target, { async send<T>(method: string): Promise<T> { if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") } as T; return { result: { value: layout() } } as T; } });
    const store = new ObservationStore(actor, registryFor([target]), artifacts, new FakeMotor() as never);
    await assert.rejects(() => store.capture(address(target), "artifact", controller.signal), /cancelled/);
    assert.equal(artifacts.entryCount, 0);
  });
});
