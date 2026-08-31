import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type FrameEvent, type TabAddress } from "../../../packages/browser-protocol/src/index.js";
import { BrowserdClientPool, readSecureDescriptor, type BrowserdDescriptor } from "../src/browserd-client.js";
import { BrowserdWorkspaceBrokerClient } from "../src/workspace/browserd-broker-client.js";
import type { AuthorityActor } from "../src/ports.js";

const actorA: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set(["browser.read", "browser.write"]) };
const actorB: AuthorityActor = { principalId: "principal-b", agentId: "agent-b", scopes: new Set(["browser.read", "browser.write"]) };
const address: TabAddress = { browserSessionId: "session-a", tabId: "tab-a", targetId: "target_identifier_a", controlEpoch: 1 };
const digest = "a".repeat(64);
const personaId = "persona_identifier_a";
const artifactId = "artifact_identifier_a";

interface WireMessage { readonly kind: string; readonly requestId: string; readonly operationId?: string; readonly actor?: { readonly principalId: string; readonly agentSessionId: string }; readonly targetOperationId?: string }
type RequestHandler = (message: WireMessage, socket: Socket, fixture: FakeBrowserd) => void;

const fixtures: FakeBrowserd[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.close()));
});

class FakeBrowserd {
  readonly messages: WireMessage[] = [];
  readonly sockets = new Set<Socket>();
  readonly bindActors: Array<{ readonly principalId: string; readonly agentSessionId: string }> = [];
  readonly #waiters = new Set<() => void>();
  #server?: Server;
  #handler: RequestHandler = (message, socket) => this.respondAck(socket, message);
  #bindActorOverride?: { readonly principalId: string; readonly agentSessionId: string };
  #workspaceRuntimeOverride?: string;

  private constructor(
    readonly directory: string,
    readonly socketPath: string,
    readonly descriptorPath: string,
    public descriptor: BrowserdDescriptor,
  ) {}

  static async start(): Promise<FakeBrowserd> {
    const directory = await mkdtemp(join(tmpdir(), "webxd-browserd-client-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "browserd-runtime_fixture_a.sock");
    const descriptorPath = join(directory, "browserd.json");
    const descriptor: BrowserdDescriptor = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeInstanceId: "runtime_fixture_a",
      pid: process.pid,
      processStartTicks: await processStartTicks(),
      socketPath,
      bindingSecret: "b".repeat(43),
      brokerSigningSecret: "s".repeat(43),
      workspaceBrokerSecret: "w".repeat(43),
      startedAt: "2026-08-29T00:00:00.000Z",
    };
    const fixture = new FakeBrowserd(directory, socketPath, descriptorPath, descriptor);
    fixtures.push(fixture);
    await fixture.listen();
    await fixture.writeDescriptor();
    return fixture;
  }

  set handler(value: RequestHandler) { this.#handler = value; }
  set bindActorOverride(value: { readonly principalId: string; readonly agentSessionId: string } | undefined) { this.#bindActorOverride = value; }
  set workspaceRuntimeOverride(value: string | undefined) { this.#workspaceRuntimeOverride = value; }

  async replaceRuntime(runtimeInstanceId: string): Promise<void> {
    this.descriptor = { ...this.descriptor, runtimeInstanceId };
    await this.writeDescriptor();
  }

  async writeDescriptor(): Promise<void> {
    await writeFile(this.descriptorPath, `${JSON.stringify(this.descriptor)}\n`, { mode: 0o600 });
    await chmod(this.descriptorPath, 0o600);
  }

  async waitFor(predicate: (message: WireMessage) => boolean, timeoutMs = 2_000): Promise<WireMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return existing;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.#waiters.delete(wake); reject(new Error("timed out waiting for browserd fixture message")); }, Math.max(1, deadline - Date.now()));
        const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
        this.#waiters.add(wake);
      });
      const found = this.messages.find(predicate);
      if (found !== undefined) return found;
    }
  }

  respondAck(socket: Socket, request: WireMessage, operationId = request.operationId): void {
    if (operationId === undefined) throw new Error("fixture request has no operation ID");
    this.send(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: request.requestId,
      operationId,
      ok: true,
      result: { kind: "ack", operationId },
    });
  }

  respondCapabilities(socket: Socket, request: WireMessage): void {
    if (request.operationId === undefined) throw new Error("fixture request has no operation ID");
    this.send(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: request.requestId,
      operationId: request.operationId,
      ok: true,
      result: {
        kind: "capabilities",
        available: true,
        headed: true,
        screenshotFirst: true,
        domFallback: true,
        virtualMouse: true,
        osMouse: false,
        executableAvailable: true,
        displayAvailable: true,
        profileRootUsable: true,
        egressConfigured: true,
        runtimeState: "open",
        sessionCapacity: { current: 0, limit: 8, available: 8 },
      },
    });
  }

  send(socket: Socket, value: unknown): void { socket.write(`${JSON.stringify(value)}\n`); }
  sendSplit(socket: Socket, value: unknown, marker: string, markerByteBoundary: number): void {
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const markerOffset = encoded.indexOf(Buffer.from(marker, "utf8"));
    if (markerOffset < 0) throw new Error("split marker is absent");
    const split = markerOffset + markerByteBoundary;
    socket.write(encoded.subarray(0, split));
    setImmediate(() => socket.write(encoded.subarray(split)));
  }
  disconnectAll(): void { for (const socket of this.sockets) socket.destroy(); }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.#server !== undefined) await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }

  private async listen(): Promise<void> {
    this.#server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const message = JSON.parse(line) as WireMessage;
          this.messages.push(message);
          for (const wake of [...this.#waiters]) wake();
          if (message.kind === "bind") {
            if (message.actor === undefined) throw new Error("bind actor is missing");
            this.bindActors.push(message.actor);
            this.send(socket, { protocolVersion: PROTOCOL_VERSION, kind: "bound", requestId: message.requestId, actor: this.#bindActorOverride ?? message.actor });
          } else if (message.kind === "workspace.bind") {
            this.send(socket, { protocolVersion: PROTOCOL_VERSION, kind: "workspace.bound", requestId: message.requestId, runtimeInstanceId: this.#workspaceRuntimeOverride ?? this.descriptor.runtimeInstanceId });
          } else this.#handler(message, socket, this);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.socketPath, () => { this.#server?.off("error", reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
  }
}

function pool(fixture: FakeBrowserd, options: Partial<ConstructorParameters<typeof BrowserdClientPool>[0]> = {}): BrowserdClientPool {
  return new BrowserdClientPool({ descriptorPath: fixture.descriptorPath, runtimeDirectory: fixture.directory, ...options });
}

function frame(sequence: number, frameAddress: TabAddress = address): FrameEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "frame.available",
    address: frameAddress,
    documentGeneration: 1,
    viewportGeneration: 1,
    frameSequence: sequence,
    capturedMonotonicMs: sequence,
    publishedMonotonicMs: sequence,
    mediaType: "image/png",
    byteLength: 3,
    artifactId,
    sha256: digest,
    imagePixelWidth: 1600,
    imagePixelHeight: 1200,
    viewport: { width: 800, height: 600, devicePixelRatio: 2 },
    url: "https://example.test/",
    title: "Fixture",
    cursor: { x: 1, y: 2, pathSequence: 1, sampleSequence: 1, personaId, visible: true },
  };
}

async function processStartTicks(): Promise<string> {
  const text = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const ticks = text.slice(end + 2).split(" ")[19];
  if (ticks === undefined) throw new Error("missing process start ticks");
  return ticks;
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("readSecureDescriptor", () => {
  it("accepts only a private descriptor, private socket, and live process identity", async () => {
    const fixture = await FakeBrowserd.start();
    await expect(readSecureDescriptor(fixture.descriptorPath, fixture.directory)).resolves.toEqual(fixture.descriptor);

    await chmod(fixture.descriptorPath, 0o644);
    await expect(readSecureDescriptor(fixture.descriptorPath, fixture.directory)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await chmod(fixture.descriptorPath, 0o600);

    await writeFile(fixture.descriptorPath, `${JSON.stringify({ ...fixture.descriptor, runtimeInstanceId: null })}\n`, { mode: 0o600 });
    await expect(readSecureDescriptor(fixture.descriptorPath, fixture.directory)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    fixture.descriptor = { ...fixture.descriptor, processStartTicks: "0" };
    await fixture.writeDescriptor();
    await expect(readSecureDescriptor(fixture.descriptorPath, fixture.directory)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", retryable: true });
  });

  it("rejects descriptor and socket locations outside the expected directory without exposing them", async () => {
    const fixture = await FakeBrowserd.start();
    const outside = join(tmpdir(), "outside-browserd.json");
    await expect(readSecureDescriptor(outside, fixture.directory)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: expect.not.stringContaining(outside) });
    fixture.descriptor = { ...fixture.descriptor, socketPath: join(tmpdir(), "outside-browserd.sock") };
    await fixture.writeDescriptor();
    await expect(readSecureDescriptor(fixture.descriptorPath, fixture.directory)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: expect.not.stringContaining(fixture.descriptor.bindingSecret) });
  });
});

describe("BrowserdWorkspaceBrokerClient replacement lifecycle", () => {
  it("publishes disconnect and clears the old connection before a replacement bind failure", async () => {
    const fixture = await FakeBrowserd.start();
    const connectionChanges: boolean[] = [];
    const client = new BrowserdWorkspaceBrokerClient({
      descriptorPath: fixture.descriptorPath,
      runtimeDirectory: fixture.directory,
      requestTimeoutMs: 500,
      onConnectionChanged: (connected) => connectionChanges.push(connected),
    });
    await client.refresh();
    expect(client.diagnostics.connected).toBe(true);
    expect(connectionChanges).toEqual([true]);

    await fixture.replaceRuntime("runtime_fixture_b");
    fixture.workspaceRuntimeOverride = "runtime_fixture_a";
    await expect(client.refresh()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(client.diagnostics.connected).toBe(false);
    expect(connectionChanges).toEqual([true, false]);
    await client.close();
  });
});

describe("BrowserdClientPool transport", () => {
  it("binds exactly once per actor and multiplexes out-of-order responses by request ID", async () => {
    const fixture = await FakeBrowserd.start();
    const pending: Array<{ message: WireMessage; socket: Socket }> = [];
    fixture.handler = (message, socket) => {
      pending.push({ message, socket });
      if (pending.length === 2) {
        const second = pending[1];
        const first = pending[0];
        if (first === undefined || second === undefined) throw new Error("fixture did not collect two requests");
        fixture.respondAck(second.socket, second.message);
        fixture.respondAck(first.socket, first.message);
      }
    };
    const client = pool(fixture);
    const first = client.request(actorA, "operation-a", { kind: "capabilities.get" });
    const second = client.request(actorA, "operation-b", { kind: "capabilities.get" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "ack", operationId: "operation-a" },
      { kind: "ack", operationId: "operation-b" },
    ]);
    expect(fixture.bindActors).toEqual([{ principalId: "principal-a", agentSessionId: "agent-a" }]);
    expect(client.connectionCount).toBe(1);
    await client.close();
  });

  it("keeps actor bindings on distinct persistent connections", async () => {
    const fixture = await FakeBrowserd.start();
    const client = pool(fixture);
    await client.request(actorA, "operation-a", { kind: "capabilities.get" });
    await client.request(actorB, "operation-b", { kind: "capabilities.get" });
    expect(fixture.bindActors).toEqual([
      { principalId: "principal-a", agentSessionId: "agent-a" },
      { principalId: "principal-b", agentSessionId: "agent-b" },
    ]);
    expect(client.connectionCount).toBe(2);
    await client.close();
  });

  it("rejects a bind response that changes the authenticated actor and closes the socket", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.bindActorOverride = { principalId: "principal-b", agentSessionId: "agent-b" };
    const client = pool(fixture);
    await expect(client.request(actorA, "operation-a", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await waitUntil(() => fixture.sockets.size === 0);
    expect(client.connectionCount).toBe(0);
    expect(fixture.sockets.size).toBe(0);
    await client.close();
  });

  it("cancels only the admitted caller operation and keeps the shared connection usable", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => {
      if (message.kind === "operation.cancel") fixture.respondAck(socket, message);
      else if (message.operationId === "operation-after") fixture.respondAck(socket, message);
    };
    const client = pool(fixture);
    const controller = new AbortController();
    const request = client.request(actorA, "operation-cancelled", { kind: "capabilities.get" }, controller.signal);
    await fixture.waitFor((message) => message.operationId === "operation-cancelled");
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await expect(fixture.waitFor((message) => message.kind === "operation.cancel")).resolves.toMatchObject({ targetOperationId: "operation-cancelled" });
    await expect(client.request(actorA, "operation-after", { kind: "capabilities.get" })).resolves.toEqual({ kind: "ack", operationId: "operation-after" });
    expect(fixture.bindActors).toHaveLength(1);
    await client.close();
  });

  it("enforces a local response deadline and cancels the admitted operation", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => { if (message.kind === "operation.cancel") fixture.respondAck(socket, message); };
    const client = pool(fixture, { requestTimeoutMs: 20 });
    await expect(client.request(actorA, "operation-timeout", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED", retryable: true });
    await expect(fixture.waitFor((message) => message.kind === "operation.cancel")).resolves.toMatchObject({ targetOperationId: "operation-timeout" });
    await client.close();
  });

  it("settles pending callers promptly when the shared connection is lost", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = () => undefined;
    const client = pool(fixture);
    const request = client.request(actorA, "operation-pending", { kind: "capabilities.get" });
    await fixture.waitFor((message) => message.operationId === "operation-pending");
    fixture.disconnectAll();
    await expect(request).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", retryable: true });
    await flush();
    expect(client.connectionCount).toBe(0);
    await client.close();
  });

  it("pins descriptor-dependent request construction and execution to the same runtime connection", async () => {
    const fixture = await FakeBrowserd.start();
    const client = pool(fixture);
    const pinned = await client.requestWithDescriptor(actorA, "operation-pinned", async (seenDescriptor) => {
      expect(seenDescriptor.runtimeInstanceId).toBe("runtime_fixture_a");
      await fixture.replaceRuntime("runtime_fixture_b");
      return { kind: "capabilities.get" };
    });
    expect(pinned).toEqual({ runtimeInstanceId: "runtime_fixture_a", result: { kind: "ack", operationId: "operation-pinned" } });
    await expect(client.request(actorB, "operation-after-replacement", { kind: "capabilities.get" })).resolves.toMatchObject({ operationId: "operation-after-replacement" });
    expect(client.runtimeInstanceId).toBe("runtime_fixture_b");
    await client.close();
  });

  it("fails old pending work on runtime replacement and reconnects new work", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => { if (message.operationId === "operation-new") fixture.respondAck(socket, message); };
    const client = pool(fixture);
    const old = client.request(actorA, "operation-old", { kind: "capabilities.get" }).catch((error: unknown) => error);
    await fixture.waitFor((message) => message.operationId === "operation-old");
    await fixture.replaceRuntime("runtime_fixture_b");
    await expect(client.request(actorB, "operation-new", { kind: "capabilities.get" })).resolves.toEqual({ kind: "ack", operationId: "operation-new" });
    await expect(old).resolves.toMatchObject({ code: "BROWSER_INSTANCE_REPLACED", runtimeInstanceId: "runtime_fixture_b" });
    expect(client.runtimeInstanceId).toBe("runtime_fixture_b");
    expect(fixture.bindActors).toHaveLength(2);
    await client.close();
  });

  it("enforces actor and pending request bounds", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = () => undefined;
    const client = pool(fixture, { maxActorConnections: 1, maxPendingPerConnection: 1 });
    const pending = client.request(actorA, "operation-first", { kind: "capabilities.get" });
    await fixture.waitFor((message) => message.operationId === "operation-first");
    await expect(client.request(actorA, "operation-second", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(client.request(actorB, "operation-other", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await client.close();
    await expect(pending).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("evicts an idle actor connection without affecting browser sessions", async () => {
    const fixture = await FakeBrowserd.start();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const client = pool(fixture, { maxActorConnections: 1, idleTimeoutMs: 100 });
    await client.request(actorA, "operation-a", { kind: "capabilities.get" });
    now.mockReturnValue(1_101);
    await client.request(actorB, "operation-b", { kind: "capabilities.get" });
    expect(fixture.bindActors).toHaveLength(2);
    expect(client.connectionCount).toBe(1);
    expect(fixture.messages.filter((message) => message.kind === "session.close")).toHaveLength(0);
    await client.close();
  });

  it("rejects success or error responses whose operation identity does not match the request", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => fixture.respondAck(socket, message, "operation-other");
    const client = pool(fixture);
    await expect(client.request(actorA, "operation-a", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await client.close();

    const missing = await FakeBrowserd.start();
    missing.handler = (message, socket) => missing.send(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: message.requestId,
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "failed without operation identity", retryable: false },
    });
    const missingClient = pool(missing);
    await expect(missingClient.request(actorA, "operation-b", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: "browser service response operation identity changed" });
    await waitUntil(() => missing.sockets.size === 0);
    await missingClient.close();
  });

  it("reconstructs exact multibyte response, error, frame title, and frame URL across every UTF-8 byte boundary", async () => {
    const fixture = await FakeBrowserd.start();
    const marker = "😀";
    let splitBoundary = 1;
    fixture.handler = (message, socket) => {
      if (message.operationId?.startsWith("response-split-") === true) {
        fixture.sendSplit(socket, {
          protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: message.requestId, operationId: message.operationId, ok: true,
          result: { kind: "sessions", sessions: [{ kind: "session", browserSessionId: "session-a", controlEpoch: 1, state: "ready", personaId, cursor: { x: 0, y: 0, pathSequence: 0, sampleSequence: 0, personaId, visible: true }, tabs: [{ kind: "tab", address, documentGeneration: 1, viewportGeneration: 1, state: "ready", url: `https://example.test/${marker}`, title: `雪${marker}`, frameSequence: 0 }] }] },
        }, marker, splitBoundary);
      } else if (message.operationId?.startsWith("error-split-") === true) {
        fixture.sendSplit(socket, { protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: message.requestId, operationId: message.operationId, ok: false, error: { code: "INTERNAL_ERROR", message: `typed-雪-${marker}`, retryable: false } }, marker, splitBoundary);
      } else if (message.kind === "frames.subscribe" || message.kind === "frames.unsubscribe") fixture.respondAck(socket, message);
      else fixture.respondAck(socket, message);
    };
    const client = pool(fixture);
    for (splitBoundary = 1; splitBoundary < Buffer.byteLength(marker); splitBoundary += 1) {
      const response = await client.request(actorA, `response-split-${splitBoundary}`, { kind: "session.list" }) as { sessions: Array<{ tabs: Array<{ title: string; url: string }> }> };
      expect(response.sessions[0]?.tabs[0]).toMatchObject({ title: `雪${marker}`, url: `https://example.test/${marker}` });
      await expect(client.request(actorA, `error-split-${splitBoundary}`, { kind: "session.list" })).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: `typed-雪-${marker}` });
    }
    const seen: FrameEvent[] = [];
    const subscription = await client.subscribeFrames(actorA, "subscribe-unicode", address, (event) => seen.push(event));
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    for (splitBoundary = 1; splitBoundary < Buffer.byteLength(marker); splitBoundary += 1) {
      fixture.sendSplit(socket, { ...frame(splitBoundary), title: `frame-雪-${marker}`, url: `https://example.test/路径/${marker}` }, marker, splitBoundary);
      await waitUntil(() => seen.length === splitBoundary);
    }
    expect(seen.every((event) => event.title === `frame-雪-${marker}` && event.url === `https://example.test/路径/${marker}`)).toBe(true);
    await subscription.close();
    await client.close();
  });

  it("keeps active subscriptions through idle pruning and prunes them after confirmed close", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => fixture.respondAck(socket, message);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const client = pool(fixture, { maxActorConnections: 1, idleTimeoutMs: 100 });
    const subscription = await client.subscribeFrames(actorA, "subscribe-idle", address, () => undefined);
    now.mockReturnValue(2_000);
    await expect(client.request(actorB, "other-while-subscribed", { kind: "capabilities.get" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    fixture.send(socket, frame(1));
    await flush();
    now.mockReturnValue(2_050);
    await subscription.close();
    now.mockReturnValue(2_151);
    await expect(client.request(actorB, "other-after-close", { kind: "capabilities.get" })).resolves.toMatchObject({ operationId: "other-after-close" });
    expect(client.connectionCount).toBe(1);
    await client.close();
  });

  it("closes the actor connection when subscription admission cannot be confirmed", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => { if (message.kind !== "frames.subscribe" && message.kind !== "operation.cancel") fixture.respondAck(socket, message); };
    const client = pool(fixture, { requestTimeoutMs: 20 });
    await expect(client.subscribeFrames(actorA, "subscribe-admission-loss", address, () => undefined)).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fixture.messages.filter((message) => message.kind === "frames.subscribe")).toHaveLength(1);
    await waitUntil(() => fixture.sockets.size === 0);
    expect(client.connectionCount).toBe(0);
    await client.close();
  });

  it("shares unsubscribe teardown and closes the actor connection when confirmation is lost", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => { if (message.kind !== "frames.unsubscribe" && message.kind !== "operation.cancel") fixture.respondAck(socket, message); };
    const client = pool(fixture, { requestTimeoutMs: 20 });
    const subscription = await client.subscribeFrames(actorA, "subscribe-loss", address, () => undefined);
    const first = subscription.close();
    const second = subscription.close();
    await expect(first).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await expect(second).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fixture.messages.filter((message) => message.kind === "frames.unsubscribe")).toHaveLength(1);
    await waitUntil(() => fixture.sockets.size === 0);
    expect(client.connectionCount).toBe(0);
    await client.close();
  });

  it("dispatches only matching frames and keeps only the newest queued frame", async () => {
    const fixture = await FakeBrowserd.start();
    fixture.handler = (message, socket) => {
      if (message.kind === "frames.subscribe" || message.kind === "frames.unsubscribe") {
        if (message.operationId === undefined) throw new Error("missing operation ID");
        fixture.send(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: "response",
          requestId: message.requestId,
          operationId: message.operationId,
          ok: true,
          result: { kind: "subscription", operationId: message.operationId, subscriptionId: "subscription_identifier_a", subscribed: message.kind === "frames.subscribe" },
        });
      }
    };
    const client = pool(fixture);
    const seen: number[] = [];
    const subscription = await client.subscribeFrames(actorA, "subscribe-operation", address, (event) => seen.push(event.frameSequence));
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    fixture.send(socket, frame(1));
    fixture.send(socket, frame(2));
    fixture.send(socket, frame(3, { ...address, tabId: "tab-other" }));
    await waitUntil(() => seen.length > 0);
    expect(seen).toEqual([2]);
    await subscription.close();
    expect(fixture.messages.some((message) => message.kind === "frames.unsubscribe")).toBe(true);
    await client.close();
  });
});
