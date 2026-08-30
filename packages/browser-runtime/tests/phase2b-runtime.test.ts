import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";
import { BrowserProtocolError, type TabAddress } from "@webx/browser-protocol";
import { BrowserArtifactStore } from "../src/artifacts/store.js";
import type { CdpConnection } from "../src/cdp/connection.js";
import { installDownloadDenial, type DownloadDenialEvent } from "../src/chrome/host.js";
import { bindMotorTab, SessionMotor } from "../src/motor/session-motor.js";
import { bindDomTab, DomObservationStore } from "../src/observations/dom-store.js";
import { bindObservationTab, ObservationStore, type Layout } from "../src/observations/store.js";
import { OperationRegistry } from "../src/operations/registry.js";
import { BrowserRuntime } from "../src/registry/runtime.js";
import type { TabRecord, TargetRegistry } from "../src/targets/registry.js";

const actor = { principalId: "owner:phase2b", agentSessionId: "agent:phase2b" } as const;
const layout: Layout = { url: "https://fixture.invalid/", title: "fixture", width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0 };

function tab(id = "lease"): TabRecord {
  return { browserSessionId: "session:phase2b", tabId: `tab:${id}`, targetId: `target:${id}`, cdpSessionId: `cdp:${id}`, documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: layout.url, title: layout.title };
}
function address(value: TabRecord, epoch = 1): TabAddress { return { browserSessionId: value.browserSessionId, tabId: value.tabId, targetId: value.targetId, controlEpoch: epoch }; }
function registryFor(value: TabRecord): TargetRegistry {
  return {
    resolve(input: TabAddress) { if (input.tabId !== value.tabId || input.targetId !== value.targetId) throw new BrowserProtocolError("TAB_NOT_FOUND", "Tab not found."); return value; },
    incrementFrame(target: TabRecord) { return ++target.latestFrameSequence; },
  } as unknown as TargetRegistry;
}
function fakePng(): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20);
  return bytes.toString("base64");
}
class FakeMotor extends EventEmitter { readonly state = { x: 80, y: 80, pathSequence: 0, sampleSequence: 0, personaId: "persona", visible: true }; async ensureOverlay(): Promise<void> {} }

describe("Phase 2B download denial", () => {
  it("installs browser-wide deny without a path and cancels typed bounded download events", async () => {
    class FakeCdp extends EventEmitter {
      readonly commands: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
      failCancel = false;
      async send(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> { this.commands.push({ method, params }); if (method === "Browser.cancelDownload" && this.failCancel) throw new Error("cancel failed"); return {}; }
    }
    const fake = new FakeCdp();
    const denied: DownloadDenialEvent[] = [];
    let failedClosed = false;
    const remove = await installDownloadDenial(fake as unknown as CdpConnection, (event) => denied.push(event), () => { failedClosed = true; });
    assert.deepEqual(fake.commands[0], { method: "Browser.setDownloadBehavior", params: { behavior: "deny", eventsEnabled: true } });
    assert.equal("downloadPath" in fake.commands[0]!.params, false);
    fake.emit("event", { method: "Browser.downloadWillBegin", params: { guid: "download-guid-a", url: "https://secret.invalid/file" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(denied, [{ code: "DOWNLOAD_DENIED", guid: "download-guid-a", state: "cancel-requested" }]);
    assert.deepEqual(fake.commands[1], { method: "Browser.cancelDownload", params: { guid: "download-guid-a" } });
    fake.failCancel = true;
    fake.emit("event", { method: "Browser.downloadWillBegin", params: { guid: "download-guid-b" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(failedClosed, true);
    assert.deepEqual(denied.at(-1), { code: "DOWNLOAD_DENIED", guid: "download-guid-b", state: "cancel-failed" });
    remove();
    fake.emit("event", { method: "Browser.downloadWillBegin", params: { guid: "download-guid-c" } });
    assert.equal(denied.some((event) => event.guid === "download-guid-c"), false);
  });
});

describe("Phase 2B production observation leases", () => {
  it("uses a 60 second monotonic screenshot lease by default and fails after expiry", async () => {
    let monotonicMs = 1_000;
    let wallMs = Date.parse("2026-08-29T12:00:00.000Z");
    const target = tab();
    bindObservationTab(target, { async send<T>(method: string): Promise<T> { return (method === "Page.captureScreenshot" ? { data: fakePng() } : { result: { value: layout } }) as T; } });
    const store = new ObservationStore(actor, registryFor(target), new BrowserArtifactStore(), new FakeMotor() as never, { monotonicNow: () => monotonicMs, wallNow: () => wallMs });
    const observation = await store.capture(address(target), "inline");
    assert.equal(Date.parse(observation.validUntil) - Date.parse(observation.capturedAt), 60_000);
    monotonicMs += 30_000; wallMs += 30_000;
    await store.guard(address(target), observation.observationId, { x: 10, y: 10 });
    monotonicMs += 30_001;
    await assert.rejects(() => store.guard(address(target), observation.observationId, { x: 10, y: 10 }), (error) => error instanceof BrowserProtocolError && error.code === "OBSERVATION_STALE");
  });

  it("keeps DOM lifetime separate, monotonic, bounded, and explicit", async () => {
    let monotonicMs = 500;
    let wallMs = Date.parse("2026-08-29T12:00:00.000Z");
    const target = tab("dom");
    bindDomTab(target, { async send<T>(method: string): Promise<T> {
      if (method === "Accessibility.getFullAXTree") return { nodes: [] } as T;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } } as T;
      return {} as T;
    } });
    const store = new DomObservationStore(registryFor(target), { monotonicNow: () => monotonicMs, wallNow: () => wallMs, retentionMs: 45_000 });
    const observation = await store.observe(address(target), 20);
    assert.equal(Date.parse(observation.validUntil) - Date.parse(observation.observedAt), 45_000);
    monotonicMs += 45_001; wallMs += 45_001;
    assert.equal(store.hasUsable(observation.observationId), false);
  });

  it("validates production runtime TTL bounds instead of exposing only test overrides", () => {
    assert.throws(() => new BrowserRuntime({ screenshotObservationTtlMs: 9_999 }), /screenshot observation TTL/i);
    assert.throws(() => new BrowserRuntime({ screenshotObservationTtlMs: 120_001 }), /screenshot observation TTL/i);
    assert.throws(() => new BrowserRuntime({ domObservationTtlMs: 9_999 }), /DOM observation TTL/i);
    const runtime = new BrowserRuntime({ screenshotObservationTtlMs: 60_000, domObservationTtlMs: 45_000 });
    return runtime.close();
  });
});

describe("Phase 2B human motor timing", () => {
  it("reports separate nominal, replay, CDP, overlay, guard, and sample metrics", async () => {
    const target = tab("motor");
    bindMotorTab(target, { connected: true, async send<T>(method: string): Promise<T> { if (method === "Runtime.evaluate") return { result: { value: true } } as T; return {} as T; } });
    const motor = new SessionMotor(target.browserSessionId, 424_242);
    const operations = new OperationRegistry();
    let timings: Record<string, unknown> | undefined;
    motor.once("actionEnd", (event: { timings?: Record<string, unknown> }) => { timings = event.timings; });
    operations.submit(actor, { operationId: "operation:motor-metrics", laneKey: "motor", deadline: new Date(Date.now() + 5_000).toISOString() }, async (context) => await motor.coordinate(target, { kind: "move", to: { x: 760, y: 540 } }, context, async () => undefined));
    assert.equal((await operations.wait(actor, "operation:motor-metrics")).state, "committed");
    assert.ok(timings !== undefined);
    for (const key of ["generatedNominalPathDurationMs", "sampleReplayWallMs", "cdpInputLatencyMs", "overlayUpdateLatencyMs", "postPathGuardMs", "sampleCount"]) assert.equal(typeof timings[key], "number", key);
    assert.ok((timings.sampleCount as number) >= 6);
    assert.ok((timings.generatedNominalPathDurationMs as number) >= 400 && (timings.generatedNominalPathDurationMs as number) <= 2_500);
  });
});
