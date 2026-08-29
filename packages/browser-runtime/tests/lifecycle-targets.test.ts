import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";
import { BrowserProtocolError, type TabAddress } from "@webx/browser-protocol";
import { TargetRegistry } from "../src/targets/registry.js";

class FakeCdp extends EventEmitter {
  readonly calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  connected = true;
  blockAttach = false;
  abortOnMethod?: string;
  failOnMethod?: string;
  controller?: AbortController;

  async send<T>(method: string, params: Readonly<Record<string, unknown>> = {}, _sessionId?: string, options: { signal?: AbortSignal; timeoutMs?: number; onDispatch?: () => void } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    options.onDispatch?.();
    this.calls.push({ method, params });
    if (this.abortOnMethod === method) this.controller?.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    if (this.failOnMethod === method) throw new BrowserProtocolError("CDP_ERROR", `${method} failed`);
    options.signal?.throwIfAborted();
    if (method === "Target.getTargets") return { targetInfos: [] } as T;
    if (method === "Target.createTarget") return { targetId: "target_lifecycle01" } as T;
    if (method === "Target.attachToTarget") {
      if (this.blockAttach) return await new Promise<T>((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
      return { sessionId: "cdp_lifecycle_01" } as T;
    }
    return {} as T;
  }
}

async function registry(cdp: FakeCdp): Promise<TargetRegistry> {
  const host = { connected: true, cdp };
  return await TargetRegistry.create("session:lifecycle", host as never);
}
function address(tabId: string): TabAddress { return { browserSessionId: "session:lifecycle", tabId, targetId: "target_lifecycle01", controlEpoch: 1 }; }

describe("lifecycle cancellation dispatch matrix", () => {
  it("does not dispatch an already-aborted tab.create", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const controller = new AbortController();
    controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    let dispatched = false;
    await assert.rejects(() => targets.createTab("about:blank", { signal: controller.signal, markDispatched: () => { dispatched = true; } }), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED");
    assert.equal(dispatched, false);
    assert.equal(cdp.calls.some((call) => call.method === "Target.createTarget"), false);
    await targets.close();
  });

  it("closes a created target when tab.create is cancelled before commit", async () => {
    const cdp = new FakeCdp();
    cdp.blockAttach = true;
    const targets = await registry(cdp);
    const controller = new AbortController();
    let dispatched = false;
    const creating = targets.createTab("about:blank", { signal: controller.signal, markDispatched: () => { dispatched = true; } });
    while (!cdp.calls.some((call) => call.method === "Target.attachToTarget")) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    await assert.rejects(() => creating);
    assert.equal(dispatched, true);
    assert.ok(cdp.calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "target_lifecycle01"));
    await targets.close();
  });

  it("publishes no tab or mapping when required domain enablement fails", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    cdp.failOnMethod = "Page.enable";
    await assert.rejects(() => targets.createTab(), (error) => error instanceof BrowserProtocolError && error.code === "CDP_ERROR");
    assert.deepEqual(targets.list(1), []);
    assert.ok(cdp.calls.some((call) => call.method === "Target.detachFromTarget"));
    assert.ok(cdp.calls.some((call) => call.method === "Target.closeTarget"));
    await targets.close();
  });

  it("marks focus dispatched only when Target.activateTarget reaches its dispatch boundary", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const tab = await targets.createTab();
    const controller = new AbortController();
    cdp.abortOnMethod = "Target.activateTarget";
    cdp.controller = controller;
    let dispatched = false;
    await assert.rejects(() => targets.focus(address(tab.tabId), controller.signal, () => { dispatched = true; }), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED");
    assert.equal(dispatched, true);
    assert.ok(cdp.calls.some((call) => call.method === "Target.activateTarget"));
    await targets.close();
  });

  it("keeps a tab open if close is cancelled before dispatch", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const tab = await targets.createTab();
    const controller = new AbortController();
    controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    let dispatched = false;
    await assert.rejects(() => targets.closeTab(address(tab.tabId), controller.signal, () => { dispatched = true; }));
    assert.equal(dispatched, false);
    assert.equal(tab.state, "open");
    await targets.close();
  });

  it("marks close dispatched and terminal after Target.closeTarget crosses dispatch", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const tab = await targets.createTab();
    const controller = new AbortController();
    cdp.abortOnMethod = "Target.closeTarget";
    cdp.controller = controller;
    let dispatched = false;
    await assert.rejects(() => targets.closeTab(address(tab.tabId), controller.signal, () => { dispatched = true; }));
    assert.equal(dispatched, true);
    assert.equal(tab.state, "closed");
    await targets.close();
  });
});
