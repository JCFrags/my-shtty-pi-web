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
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
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

  it("applies a noisy session quota before evicting another session owned by the same actor", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 3, maxEntriesPerOwner: 3, maxEntriesPerSession: 1, maxTotalBytes: 20, maxBytesPerOwner: 20, maxBytesPerSession: 10 });
    const firstA = await store.put(actor, Uint8Array.of(1), observation);
    const stableB = await store.put(actor, Uint8Array.of(2), { ...observation, browserSessionId: "session:b", tabId: "tab:b" });
    await store.put(actor, Uint8Array.of(3), observation);
    await assert.rejects(() => store.read(actor, firstA.artifactId));
    assert.equal((await store.read(actor, stableB.artifactId)).bytes[0], 2);
  });

  it("makes transaction rollback idempotent and releases frame-ring pins", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 2, maxEntriesPerOwner: 2, maxEntriesPerSession: 2, maxTotalBytes: 20, maxBytesPerOwner: 20, maxBytesPerSession: 20, frameRingSize: 2 });
    const frameOptions = { browserSessionId: "session:frame", tabId: "tab:frame", purpose: "workspace-frame", mediaType: "image/png", latestFrameKey: "session:frame\0tab:frame" } as const;
    const first = await store.put(actor, Uint8Array.of(1), frameOptions);
    await store.put(actor, Uint8Array.of(2), frameOptions);
    assert.equal(store.revokeIfOwned(actor, "missing"), false);
    store.releaseFrameRing("session:frame", "tab:frame");
    await store.put(actor, Uint8Array.of(3), { ...observation, browserSessionId: "session:frame", tabId: "tab:other" });
    await assert.rejects(() => store.read(actor, first.artifactId));
  });

  it("commits hundreds of concurrent puts without exceeding count or byte limits", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 2, maxTotalBytes: 2, maxItemBytes: 1, maxEntriesPerOwner: 2, maxBytesPerOwner: 2, maxEntriesPerSession: 2, maxBytesPerSession: 2 });
    const gate = deferred();
    let observedMaxCount = 0;
    let observedMaxBytes = 0;
    const puts = Array.from({ length: 200 }, (_, index) => store.put(actor, Uint8Array.of(index % 255), { ...observation, afterDigestForTest: async () => await gate.promise }).then((value) => {
      observedMaxCount = Math.max(observedMaxCount, store.entryCount);
      observedMaxBytes = Math.max(observedMaxBytes, store.totalBytes);
      return value;
    }));
    await sleep(10);
    assert.equal(store.entryCount, 0);
    gate.resolve();
    await Promise.all(puts);
    assert.ok(observedMaxCount <= 2);
    assert.ok(observedMaxBytes <= 2);
    assert.ok(store.entryCount <= 2);
    assert.ok(store.totalBytes <= 2);
  });

  it("does not admit a concurrent owner by evicting another owner", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 1, maxTotalBytes: 1, maxItemBytes: 1, maxEntriesPerOwner: 1, maxBytesPerOwner: 1, maxEntriesPerSession: 1, maxBytesPerSession: 1 });
    const gate = deferred();
    const results = await Promise.allSettled([
      store.put(actor, Uint8Array.of(1), { ...observation, afterDigestForTest: async () => await gate.promise }),
      store.put(other, Uint8Array.of(2), { ...observation, afterDigestForTest: async () => await gate.promise }),
      Promise.resolve().then(() => { gate.resolve(); }),
    ]);
    assert.equal(results.slice(0, 2).filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.slice(0, 2).filter((result) => result.status === "rejected").length, 1);
    assert.equal(store.entryCount, 1);
    assert.equal(store.totalBytes, 1);
  });

  it("does not commit an artifact cancelled around digest completion", async () => {
    const store = new BrowserArtifactStore({ maxEntries: 1, maxTotalBytes: 1 });
    const gate = deferred();
    const controller = new AbortController();
    const put = store.put(actor, Uint8Array.of(1), { ...observation, signal: controller.signal, afterDigestForTest: async () => await gate.promise });
    controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    gate.resolve();
    await assert.rejects(() => put, (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED");
    assert.equal(store.entryCount, 0);
    assert.equal(store.totalBytes, 0);
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
      if (method === "Page.captureScreenshot") { screenshotCount++; return { data: fakePngBase64(800, 600, screenshotCount) } as T; }
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
      if (method === "Page.captureScreenshot") return { data: fakePngBase64() } as T;
      const value = layout({ scrollY: layoutCount++ * 10 });
      return { result: { value } } as T;
    } });
    const store = new ObservationStore(actor, registryFor([target]), artifacts, new FakeMotor() as never);
    await assert.rejects(() => store.capture(address(target), "artifact"), (error) => error instanceof BrowserProtocolError && error.code === "VIEWPORT_CHANGED");
    assert.equal(artifacts.entryCount, 0);
  });

  it("rejects navigation during artifact commit and stores only captured immutable generations", async () => {
    const target = tab("commit-navigation");
    const tabs = [target];
    const artifacts = new BrowserArtifactStore();
    bindObservationTab(target, { async send<T>(method: string): Promise<T> { if (method === "Page.captureScreenshot") return { data: fakePngBase64() } as T; return { result: { value: layout() } } as T; } });
    const store = new ObservationStore(actor, registryFor(tabs), artifacts, new FakeMotor() as never, {
      currentEpoch: () => 1,
      commitBarrierForTest: async () => { target.documentGeneration++; },
    });
    await assert.rejects(() => store.capture(address(target), "artifact"), (error) => error instanceof BrowserProtocolError && error.code === "DOCUMENT_CHANGED");
    assert.equal(store.size, 0);
    assert.equal(artifacts.entryCount, 0);
    assert.equal(target.latestFrameSequence, 0);
  });

  it("rejects epoch change and tab cleanup during artifact commit without masking the capture error", async () => {
    const target = tab("commit-cleanup");
    const tabs = [target];
    let epoch = 1;
    const artifacts = new BrowserArtifactStore();
    bindObservationTab(target, { async send<T>(method: string): Promise<T> { if (method === "Page.captureScreenshot") return { data: fakePngBase64() } as T; return { result: { value: layout() } } as T; } });
    const store = new ObservationStore(actor, registryFor(tabs), artifacts, new FakeMotor() as never, {
      currentEpoch: () => epoch,
      commitBarrierForTest: async () => { artifacts.clearTab(actor, target.browserSessionId, target.tabId); tabs.length = 0; epoch = 2; },
    });
    await assert.rejects(() => store.capture(address(target), "artifact"), (error) => error instanceof BrowserProtocolError && error.code === "CONTROL_EPOCH_STALE");
    assert.equal(store.size, 0);
    assert.equal(artifacts.entryCount, 0);
  });

  it("rejects a workspace frame changed during artifact commit without event, sequence, or artifact", async () => {
    const target = tab("frame-commit");
    const artifacts = new BrowserArtifactStore();
    const motor = new FakeMotor();
    let barrierCalls = 0;
    bindFrameTab(target, { async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: layout() } } as T; return { data: Buffer.from("old-frame").toString("base64") } as T; } });
    const scheduler = new FrameScheduler(actor, registryFor([target]), artifacts, motor as never, () => 1, {
      selectedIntervalMs: 10_000,
      commitBarrierForTest: async () => { barrierCalls++; target.viewportGeneration++; },
    });
    const events: FrameEvent[] = [];
    scheduler.on("frame", (event) => events.push(event));
    scheduler.subscribe("connection\0commit", address(target));
    await waitFor(() => barrierCalls === 1 && artifacts.entryCount === 0);
    scheduler.close();
    assert.equal(events.length, 0);
    assert.equal(target.latestFrameSequence, 0);
    assert.equal(artifacts.entryCount, 0);
  });

  it("settles an in-flight frame capture before final unsubscribe returns", async () => {
    const target = tab("frame-unsubscribe");
    const artifacts = new BrowserArtifactStore();
    const barrier = deferred();
    let screenshotComplete = false;
    bindFrameTab(target, { async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: layout() } } as T; screenshotComplete = true; return { data: Buffer.from("late-frame").toString("base64") } as T; } });
    const scheduler = new FrameScheduler(actor, registryFor([target]), artifacts, new FakeMotor() as never, () => 1, { selectedIntervalMs: 10_000, afterScreenshotForTest: async () => await barrier.promise });
    const events: FrameEvent[] = [];
    scheduler.on("frame", (event) => events.push(event));
    const key = "connection\0unsubscribe";
    scheduler.subscribe(key, address(target));
    await waitFor(() => screenshotComplete);
    const stopping = scheduler.unsubscribe(key, address(target));
    await sleep(5);
    barrier.resolve();
    await stopping;
    assert.equal(events.length, 0);
    assert.equal(artifacts.entryCount, 0);
    assert.equal(target.latestFrameSequence, 0);
    assert.equal(scheduler.timerCount, 0);
  });

  it("settles a frame already stored before scheduler close returns", async () => {
    const target = tab("frame-close");
    const artifacts = new BrowserArtifactStore();
    const barrier = deferred();
    let atCommit = false;
    bindFrameTab(target, { async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: layout() } } as T; return { data: Buffer.from("late-frame").toString("base64") } as T; } });
    const scheduler = new FrameScheduler(actor, registryFor([target]), artifacts, new FakeMotor() as never, () => 1, { selectedIntervalMs: 10_000, commitBarrierForTest: async () => { atCommit = true; await barrier.promise; } });
    const events: FrameEvent[] = [];
    scheduler.on("frame", (event) => events.push(event));
    scheduler.subscribe("connection\0close", address(target));
    await waitFor(() => atCommit && artifacts.entryCount === 1);
    const closing = scheduler.close();
    barrier.resolve();
    await closing;
    assert.equal(events.length, 0);
    assert.equal(artifacts.entryCount, 0);
    assert.equal(target.latestFrameSequence, 0);
    assert.equal(scheduler.timerCount, 0);
  });

  it("deletes an uncommitted artifact when cancellation arrives after storage", async () => {
    const target = tab("cancelled");
    const controller = new AbortController();
    class CancellingStore extends BrowserArtifactStore {
      override async put(...args: Parameters<BrowserArtifactStore["put"]>): ReturnType<BrowserArtifactStore["put"]> { const value = await super.put(...args); controller.abort(new Error("cancelled")); return value; }
    }
    const artifacts = new CancellingStore();
    bindObservationTab(target, { async send<T>(method: string): Promise<T> { if (method === "Page.captureScreenshot") return { data: fakePngBase64() } as T; return { result: { value: layout() } } as T; } });
    const store = new ObservationStore(actor, registryFor([target]), artifacts, new FakeMotor() as never);
    await assert.rejects(() => store.capture(address(target), "artifact", controller.signal), /cancelled/);
    assert.equal(artifacts.entryCount, 0);
  });
});

describe("image-pixel observation grounding", () => {
  it("converts exact image dimensions to CSS coordinates at DPR 1, 1.25, 2, and fractional capture scale", async () => {
    const cases = [
      { id: "dpr-1", cssWidth: 800, cssHeight: 600, dpr: 1, imageWidth: 800, imageHeight: 600 },
      { id: "dpr-125", cssWidth: 800, cssHeight: 600, dpr: 1.25, imageWidth: 1000, imageHeight: 750 },
      { id: "dpr-2", cssWidth: 800, cssHeight: 600, dpr: 2, imageWidth: 1600, imageHeight: 1200 },
      { id: "fractional-scale", cssWidth: 801, cssHeight: 601, dpr: 1.25, imageWidth: 1001, imageHeight: 751 },
    ] as const;
    for (const item of cases) {
      const target = tab(item.id);
      const stable = layout({ width: item.cssWidth, height: item.cssHeight, dpr: item.dpr });
      bindObservationTab(target, { async send<T>(method: string): Promise<T> {
        if (method === "Page.captureScreenshot") return { data: fakePngBase64(item.imageWidth, item.imageHeight) } as T;
        return { result: { value: stable } } as T;
      } });
      const store = new ObservationStore(actor, registryFor([target]), new BrowserArtifactStore(), new FakeMotor() as never);
      const observation = await store.capture(address(target), "inline");
      assert.equal(observation.imagePixelWidth, item.imageWidth);
      assert.equal(observation.imagePixelHeight, item.imageHeight);
      assert.equal(observation.viewport.width, item.cssWidth);
      assert.equal(observation.viewport.height, item.cssHeight);
      assert.equal(observation.viewport.devicePixelRatio, item.dpr);
      const converted = store.convertPoint(address(target), observation.observationId, { x: item.imageWidth / 2, y: item.imageHeight / 2 }, "imagePixels");
      assert.ok(Math.abs(converted.x - item.cssWidth / 2) < 1e-9);
      assert.ok(Math.abs(converted.y - item.cssHeight / 2) < 1e-9);
      assert.deepEqual(store.convertPoint(address(target), observation.observationId, { x: 10.25, y: 20.5 }, "cssViewport"), { x: 10.25, y: 20.5 });
    }
  });

  it("converts both drag endpoints and rejects finite edge, non-finite, foreign, and stale coordinates", async () => {
    const target = tab("drag-edges");
    const stable = layout({ width: 800, height: 600, dpr: 2 });
    bindObservationTab(target, { async send<T>(method: string): Promise<T> {
      if (method === "Page.captureScreenshot") return { data: fakePngBase64(1600, 1200) } as T;
      return { result: { value: stable } } as T;
    } });
    const store = new ObservationStore(actor, registryFor([target]), new BrowserArtifactStore(), new FakeMotor() as never, { freshnessMs: 1 });
    const observation = await store.capture(address(target), "inline");
    const from = store.convertPoint(address(target), observation.observationId, { x: 200, y: 300 }, "imagePixels");
    const to = store.convertPoint(address(target), observation.observationId, { x: 1400, y: 900 }, "imagePixels");
    assert.deepEqual(from, { x: 100, y: 150 });
    assert.deepEqual(to, { x: 700, y: 450 });
    const lastPixel = store.convertPoint(address(target), observation.observationId, { x: 1599, y: 1199 }, "imagePixels");
    assert.ok(lastPixel.x < 800 && lastPixel.y < 600);
    for (const point of [{ x: 1600, y: 0 }, { x: 0, y: 1200 }, { x: -1, y: 0 }, { x: Number.NaN, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }]) {
      assert.throws(() => store.convertPoint(address(target), observation.observationId, point, "imagePixels"), (error) => error instanceof BrowserProtocolError && error.code === "COORDINATE_OUT_OF_BOUNDS");
    }
    assert.throws(() => store.convertPoint({ ...address(target), tabId: "tab:foreign" }, observation.observationId, { x: 1, y: 1 }, "imagePixels"), (error) => error instanceof BrowserProtocolError && error.code === "OBSERVATION_NOT_FOUND");
    await sleep(3);
    await assert.rejects(() => store.guard(address(target), observation.observationId, from), (error) => error instanceof BrowserProtocolError && error.code === "OBSERVATION_STALE");
  });

  it("recaptures an oversized PNG as bounded JPEG and verifies the JPEG dimensions", async () => {
    const target = tab("jpeg-fallback");
    const stable = layout({ width: 800, height: 600, dpr: 2 });
    const calls: Array<{ readonly method: string; readonly params: Readonly<Record<string, unknown>> }> = [];
    bindObservationTab(target, { async send<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        if (params.format === "png") return { data: oversizedPngBase64(1600, 1200) } as T;
        return { data: fakeJpegBase64(1600, 1200) } as T;
      }
      return { result: { value: stable } } as T;
    } });
    const artifacts = new BrowserArtifactStore();
    const store = new ObservationStore(actor, registryFor([target]), artifacts, new FakeMotor() as never);
    const observation = await store.capture(address(target), "artifact");
    assert.equal(observation.mediaType, "image/jpeg");
    assert.equal(observation.imagePixelWidth, 1600);
    assert.equal(observation.imagePixelHeight, 1200);
    assert.equal(observation.captureScale, 2);
    assert.deepEqual(calls.filter((call) => call.method === "Page.captureScreenshot").map((call) => call.params.format), ["png", "jpeg"]);
    assert.equal(calls.find((call) => call.params.format === "jpeg")?.params.quality, 82);
    if (observation.image.kind !== "artifact") throw new Error("expected artifact delivery");
    assert.equal((await artifacts.read(actor, observation.image.artifactId)).descriptor.mediaType, "image/jpeg");
  });
});

function fakePngBase64(width = 800, height = 600, marker = 0): string {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes.toString("base64");
}

function oversizedPngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function fakeJpegBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(11);
  bytes[0] = 0xff; bytes[1] = 0xd8;
  bytes[2] = 0xff; bytes[3] = 0xc0;
  bytes.writeUInt16BE(7, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes.toString("base64");
}
