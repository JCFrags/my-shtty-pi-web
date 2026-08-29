import { describe, expect, it } from "vitest";
import { CdpConnection } from "../src/cdp/connection.js";

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCount = 0;
  sendHook?: () => void;

  open(): void { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  send(data: string): void { this.sendHook?.(); this.sent.push(data); }
  close(): void { this.closeCount++; this.readyState = WebSocket.CLOSED; this.dispatchEvent(new CloseEvent("close")); }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  fail(): void { this.dispatchEvent(new Event("error")); }
}

async function connected(): Promise<{ connection: CdpConnection; socket: FakeWebSocket }> {
  const socket = new FakeWebSocket();
  const promise = CdpConnection.connect("ws://test.invalid", { webSocketFactory: () => socket as unknown as WebSocket });
  socket.open();
  return { connection: await promise, socket };
}

function abortDuringListenerInstall(reason = new Error("cancelled")): AbortSignal {
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    reason,
    throwIfAborted() { if (aborted) throw reason; },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "abort") return;
      aborted = true;
      if (typeof listener === "function") listener(new Event("abort"));
      else listener.handleEvent(new Event("abort"));
    },
    removeEventListener() {},
  };
  return signal as unknown as AbortSignal;
}

describe("adversarial CDP cancellation", () => {
  it("does not allocate a WebSocket for an already-aborted connect", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let factories = 0;
    await expect(CdpConnection.connect("ws://test.invalid", { signal: controller.signal, webSocketFactory: () => { factories++; return new FakeWebSocket() as unknown as WebSocket; } })).rejects.toThrow("cancelled");
    expect(factories).toBe(0);
  });

  it("closes a connecting WebSocket when connect is cancelled", async () => {
    const socket = new FakeWebSocket();
    const controller = new AbortController();
    const promise = CdpConnection.connect("ws://test.invalid", { signal: controller.signal, webSocketFactory: () => socket as unknown as WebSocket });
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(socket.closeCount).toBe(1);
  });

  it("does not retain or dispatch already-aborted send and event waits", async () => {
    const { connection, socket } = await connected();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(connection.send("Page.test", {}, undefined, { signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(connection.waitForEvent("Page.test", () => true, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(socket.sent).toHaveLength(0);
    expect(connection.pendingCount).toBe(0);
    expect(connection.listenerCount("event")).toBe(0);
  });

  it("rechecks cancellation after listener installation and before send", async () => {
    const { connection, socket } = await connected();
    await expect(connection.send("Page.test", {}, undefined, { signal: abortDuringListenerInstall() })).rejects.toThrow("cancelled");
    expect(socket.sent).toHaveLength(0);
    expect(connection.pendingCount).toBe(0);
  });

  it("discards late responses after an in-flight command is cancelled", async () => {
    const { connection, socket } = await connected();
    const controller = new AbortController();
    const promise = connection.send("Page.test", {}, undefined, { signal: controller.signal });
    const id = (JSON.parse(socket.sent[0] ?? "{}") as { id: number }).id;
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(connection.pendingCount).toBe(0);
    socket.message({ id, result: { late: true } });
    expect(connection.pendingCount).toBe(0);
  });

  it("settles disconnect and cancellation races without pending commands", async () => {
    const { connection, socket } = await connected();
    const controller = new AbortController();
    const promise = connection.send("Page.test", {}, undefined, { signal: controller.signal });
    socket.close();
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow();
    expect(connection.pendingCount).toBe(0);
  });

  it("removes event listeners and timers after cancellation and late events", async () => {
    const { connection, socket } = await connected();
    const controller = new AbortController();
    const promise = connection.waitForEvent("Page.ready", () => true, { signal: controller.signal, timeoutMs: 10_000 });
    expect(connection.listenerCount("event")).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(connection.listenerCount("event")).toBe(0);
    socket.message({ method: "Page.ready", params: {} });
    expect(connection.listenerCount("event")).toBe(0);
  });
});
