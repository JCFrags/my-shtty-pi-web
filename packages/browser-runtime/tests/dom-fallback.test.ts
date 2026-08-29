import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserProtocolError, type TabAddress } from "@webx/browser-protocol";
import { bindMotorTab, SessionMotor } from "../src/motor/session-motor.js";
import { bindDomTab, DomObservationStore } from "../src/observations/dom-store.js";
import { OperationRegistry } from "../src/operations/registry.js";
import { assertDomHandleUnmoved } from "../src/registry/session.js";
import type { TabRecord, TargetRegistry } from "../src/targets/registry.js";

const actor = { principalId: "owner:dom", agentSessionId: "agent:dom" } as const;
const deadline = (): string => new Date(Date.now() + 5_000).toISOString();
function tab(): TabRecord { return { browserSessionId: "session:dom", tabId: "tab:dom", targetId: "target:dom", cdpSessionId: "cdp:dom", documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: "https://fixture.invalid/", title: "Fixture" }; }
function address(value: TabRecord): TabAddress { return { browserSessionId: value.browserSessionId, tabId: value.tabId, targetId: value.targetId, controlEpoch: 1 }; }
function registryFor(value: TabRecord): TargetRegistry { return { resolve(request: TabAddress) { if (request.tabId !== value.tabId || request.targetId !== value.targetId || value.state !== "open") throw new BrowserProtocolError("TAB_NOT_FOUND", "Tab not found."); return value; } } as TargetRegistry; }
function axNodes(count = 1): { nodes: Array<{ nodeId: string; backendDOMNodeId: number; role: { value: string }; name: { value: string } }> } { return { nodes: Array.from({ length: count }, (_, index) => ({ nodeId: String(index), backendDOMNodeId: index + 1, role: { value: "button" }, name: { value: `Button ${index}` } })) }; }
function box(x = 100, y = 200, width = 40, height = 30): { model: { border: number[] } } { return { model: { border: [x, y, x + width, y, x + width, y + height, x, y + height] } }; }

class FakeDomConnection {
  sent: Array<{ method: string; signal?: AbortSignal }> = [];
  detached = false;
  boxValue = box();
  blockMethod?: string;
  async send<T>(method: string, _params: Readonly<Record<string, unknown>>, _sessionId: string, options?: { signal?: AbortSignal }): Promise<T> {
    this.sent.push({ method, ...(options?.signal ? { signal: options.signal } : {}) });
    if (this.blockMethod === method) return await new Promise<T>((_resolve, reject) => {
      const abort = (): void => reject(options?.signal?.reason ?? new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
    });
    if (method === "Accessibility.getFullAXTree") return axNodes(2) as T;
    if (method === "DOM.getBoxModel") {
      if (this.detached) throw new BrowserProtocolError("CDP_ERROR", "No node with given id");
      return this.boxValue as T;
    }
    throw new Error(`Unexpected method ${method}`);
  }
}

async function observeOne(store: DomObservationStore, value: TabRecord) {
  const observation = await store.observe(address(value), 1);
  const node = observation.nodes[0];
  if (node === undefined) throw new Error("Fixture did not produce a DOM handle.");
  return { observation, node };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error("Timed out waiting for fixture state.");
}

describe("typed and bounded DOM fallback", () => {
  it("returns HANDLE_STALE for document changes, expiry, detached nodes, and moved targets", async () => {
    const value = tab();
    const connection = new FakeDomConnection();
    bindDomTab(value, connection);
    let now = 100;
    const store = new DomObservationStore(registryFor(value), { retentionMs: 10, now: () => now });
    const first = await observeOne(store, value);
    value.documentGeneration++;
    await assert.rejects(() => store.resolve(address(value), first.observation.observationId, first.node.handle), (error) => error instanceof BrowserProtocolError && error.code === "HANDLE_STALE");

    value.documentGeneration--;
    const second = await observeOne(store, value);
    connection.detached = true;
    await assert.rejects(() => store.resolve(address(value), second.observation.observationId, second.node.handle), (error) => error instanceof BrowserProtocolError && error.code === "HANDLE_STALE");
    connection.detached = false;

    const third = await observeOne(store, value);
    now = 111;
    await assert.rejects(() => store.resolve(address(value), third.observation.observationId, third.node.handle), (error) => error instanceof BrowserProtocolError && error.code === "HANDLE_STALE");
    assert.throws(() => assertDomHandleUnmoved({ x: 10, y: 10 }, { x: 13, y: 10 }), (error) => error instanceof BrowserProtocolError && error.code === "HANDLE_STALE");
  });

  it("prunes observations and all of their handles deterministically", async () => {
    const value = tab();
    const connection = new FakeDomConnection();
    bindDomTab(value, connection);
    const store = new DomObservationStore(registryFor(value), { maxObservations: 2, maxHandles: 4, maxHandlesPerObservation: 2 });
    for (let index = 0; index < 10; index++) await store.observe(address(value), 2);
    assert.equal(store.observationCount, 2);
    assert.equal(store.handleCount, 4);
  });

  it("propagates cancellation into AX-tree and box-model CDP work without retaining records", async () => {
    for (const method of ["Accessibility.getFullAXTree", "DOM.getBoxModel"] as const) {
      const value = tab();
      const connection = new FakeDomConnection();
      connection.blockMethod = method;
      bindDomTab(value, connection);
      const store = new DomObservationStore(registryFor(value));
      const controller = new AbortController();
      const pending = store.observe(address(value), 1, controller.signal);
      await waitFor(() => connection.sent.some((item) => item.method === method));
      controller.abort(new BrowserProtocolError("OPERATION_CANCELLED", "cancelled"));
      await assert.rejects(() => pending, (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CANCELLED");
      assert.equal(store.observationCount, 0);
      assert.equal(store.handleCount, 0);
      assert.ok(connection.sent.find((item) => item.method === method)?.signal);
    }
  });

  it("uses top-level viewport CSS coordinates for a scrolled page and iframe quad", async () => {
    const value = tab();
    const dom = new FakeDomConnection();
    // This quad already includes an iframe offset. It remains viewport-relative even when the document is scrolled.
    dom.boxValue = box(100, 200, 40, 30);
    bindDomTab(value, dom);
    const store = new DomObservationStore(registryFor(value));
    const { observation, node } = await observeOne(store, value);
    const resolved = await store.resolve(address(value), observation.observationId, node.handle);
    assert.deepEqual(resolved.center, { x: 120, y: 215 });

    const sent: Array<Readonly<Record<string, unknown>>> = [];
    bindMotorTab(value, { connected: true, async send<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> { sent.push(params); if (method === "Runtime.evaluate") return { result: { value: true } } as T; return {} as T; } });
    const motor = new SessionMotor(value.browserSessionId, 17);
    const operations = new OperationRegistry();
    operations.submit(actor, { operationId: "scrolled-click", laneKey: "dom", deadline: deadline() }, async (context) => { await motor.coordinate(value, { kind: "click", at: resolved.center, button: "left" }, context, async () => undefined); });
    assert.equal((await operations.wait(actor, "scrolled-click")).state, "committed");
    const press = sent.find((params) => params.type === "mousePressed");
    assert.equal(press?.x, 120);
    assert.equal(press?.y, 215);
  });
});
