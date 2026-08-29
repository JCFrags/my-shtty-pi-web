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
  readonly failOnMethods = new Set<string>();
  controller?: AbortController;
  createdTargets = 0;

  async send<T>(method: string, params: Readonly<Record<string, unknown>> = {}, _sessionId?: string, options: { signal?: AbortSignal; timeoutMs?: number; onDispatch?: () => void } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    options.onDispatch?.();
    this.calls.push({ method, params });
    if (this.abortOnMethod === method) this.controller?.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
    if (this.failOnMethod === method || this.failOnMethods.has(method)) throw new BrowserProtocolError("CDP_ERROR", `${method} failed`);
    options.signal?.throwIfAborted();
    if (method === "Target.getTargets") return { targetInfos: [] } as T;
    if (method === "Target.createTarget") return { targetId: `target_lifecycle${String(++this.createdTargets).padStart(2, "0")}` } as T;
    if (method === "Target.attachToTarget") {
      if (this.blockAttach) return await new Promise<T>((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
      return { sessionId: `cdp_${String(params.targetId)}` } as T;
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

  it("publishes no tab or mapping when attachment fails", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    cdp.failOnMethod = "Target.attachToTarget";
    await assert.rejects(() => targets.createTab(), (error) => error instanceof BrowserProtocolError && error.code === "CDP_ERROR");
    assert.deepEqual(targets.list(1), []);
    assert.ok(cdp.calls.some((call) => call.method === "Target.closeTarget"));
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

  it("keeps failed popup initialization private and rolls it back", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const opener = await targets.createTab();
    cdp.failOnMethod = "Page.enable";
    cdp.emit("event", { method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "target_popup01", openerId: opener.targetId, url: "https://fixture.invalid/popup" } } });
    for (let attempt = 0; attempt < 100 && !cdp.calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "target_popup01"); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(targets.list(1).length, 1);
    assert.ok(cdp.calls.some((call) => call.method === "Target.detachFromTarget"));
    assert.ok(cdp.calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "target_popup01"));
    await targets.close();
  });

  it("keeps rollback authoritative even when target close fails", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    cdp.failOnMethods.add("Page.enable");
    cdp.failOnMethods.add("Target.closeTarget");
    await assert.rejects(() => targets.createTab(), (error) => error instanceof BrowserProtocolError && error.code === "CDP_ERROR");
    assert.deepEqual(targets.list(1), []);
    assert.ok(cdp.calls.some((call) => call.method === "Target.detachFromTarget"));
    await targets.close();
  });

  it("enforces the tab limit before creating another target", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    await Promise.all(Array.from({ length: 8 }, async () => await targets.createTab()));
    await assert.rejects(() => targets.createTab(), (error) => error instanceof BrowserProtocolError && error.code === "LIMIT_EXCEEDED");
    assert.equal(cdp.calls.filter((call) => call.method === "Target.createTarget").length, 8);
    assert.equal(targets.list(1).length, 8);
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

  it("does not retain terminal targets across thousands of close, crash, and popup cycles", async () => {
    const cdp = new FakeCdp();
    const targets = await registry(cdp);
    const terminal: Array<{ tabId: string; targetId: string; cdpSessionId: string; tab: { state: string } }> = [];
    targets.on("tabTerminal", (event) => terminal.push(event));
    for (let index = 0; index < 1_000; index++) {
      const tab = await targets.createTab();
      const tabAddress = { browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch: 1 };
      await targets.closeTab(tabAddress);
      assert.throws(() => targets.resolve(tabAddress), (error) => error instanceof BrowserProtocolError && error.code === "TAB_NOT_FOUND");
    }
    for (let index = 0; index < 1_000; index++) {
      const tab = await targets.createTab();
      cdp.emit("event", { method: "Target.targetCrashed", params: { targetId: tab.targetId } });
      assert.throws(() => targets.resolve({ browserSessionId: tab.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch: 1 }), (error) => error instanceof BrowserProtocolError && error.code === "TAB_NOT_FOUND");
    }
    const opener = await targets.createTab();
    for (let index = 0; index < 200; index++) {
      const popupTarget = `target_popup_cycle_${index}`;
      cdp.emit("event", { method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: popupTarget, openerId: opener.targetId, url: "https://fixture.invalid/popup" } } });
      for (let attempt = 0; attempt < 100 && !targets.list(1).some((item) => item.address.targetId === popupTarget); attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(targets.list(1).some((item) => item.address.targetId === popupTarget), true);
      cdp.emit("event", { method: "Target.targetDestroyed", params: { targetId: popupTarget } });
    }
    const internal = targets as unknown as { tabs: Map<string, unknown>; targetToTab: Map<string, unknown>; autoSessions: Map<string, unknown> };
    assert.equal(internal.tabs.size, 1);
    assert.equal(internal.targetToTab.size, 1);
    assert.equal(internal.autoSessions.size, 1);
    assert.equal(targets.list(1).length, 1);
    assert.equal(terminal.length, 2_200);
    assert.ok(terminal.every((event) => event.tabId.length > 0 && event.targetId.length > 0 && event.cdpSessionId.length > 0 && event.tab.state !== "open"));
    await targets.close();
    assert.equal(internal.tabs.size, 0);
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
