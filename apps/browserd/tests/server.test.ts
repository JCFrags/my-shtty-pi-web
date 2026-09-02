import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, describe, it } from "vitest";
import { PROTOCOL_VERSION, type ActorIdentity, type BrowserRequest } from "@webx/browser-protocol";
import { BrowserRuntime } from "@webx/browser-runtime";
import { BrowserdServer } from "../src/server.js";
import { readDescriptor } from "../src/descriptor.js";
import { NdjsonReader } from "../src/transport.js";

const servers: BrowserdServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(async (server) => server.stop()));
  await Promise.allSettled(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

class Client {
  private readonly lines: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];
  private buffer = "";
  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        const value: unknown = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(value); else this.lines.push(value);
      }
    });
  }
  static async open(path: string): Promise<Client> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return new Client(socket);
  }
  send(value: unknown): void { this.socket.write(`${JSON.stringify(value)}\n`); }
  async next(): Promise<unknown> {
    const queued = this.lines.shift();
    if (queued !== undefined) return queued;
    return await Promise.race([
      new Promise<unknown>((resolve) => this.waiters.push(resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("response timeout")), 2_000)),
    ]);
  }
  close(): void { this.socket.destroy(); }
}

async function started(): Promise<{ server: BrowserdServer; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "browserd-test-"));
  directories.push(directory);
  const server = new BrowserdServer({ runtimeDirectory: directory });
  servers.push(server);
  await server.start();
  return { server, directory };
}

function bind(secret: string, principalId = "owner:test", agentSessionId = "agent:test") {
  return { protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId: "request:bind", bindingSecret: secret, actor: { principalId, agentSessionId } };
}
function request(kind: "capabilities.get" | "qualification.diagnostics" | "session.list", id: string) {
  return { protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${id}`, operationId: `operation:${id}`, deadline: new Date(Date.now() + 60_000).toISOString() };
}
function workspaceBind(secret: string) { return { protocolVersion: PROTOCOL_VERSION, kind: "workspace.bind", requestId: "request:workspace-bind", workspaceBrokerSecret: secret }; }
function workspaceRequest(kind: "workspace.snapshot.get" | "workspace.ping", id: string) { return { protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${id}`, operationId: `operation:${id}`, deadline: new Date(Date.now() + 60_000).toISOString() }; }

describe("browserd actor-bound Unix service", () => {
  it("creates private runtime, descriptor, and socket permissions and cleans them", async () => {
    const { server, directory } = await started();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "browserd.json"))).mode & 0o777, 0o600);
    const socketPath = server.descriptor.socketPath;
    assert.match(socketPath, /browserd-[A-Za-z0-9_-]+\.sock$/);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readDescriptor(join(directory, "browserd.json")), server.descriptor);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await assert.rejects(() => stat(join(directory, "browserd.json")));
    await assert.rejects(() => stat(socketPath));
  });

  it("binds one actor once and serves strict requests on the same process", async () => {
    const { server } = await started();
    const client = await Client.open(server.descriptor.socketPath);
    client.send(bind(server.descriptor.bindingSecret));
    const bound = await client.next() as { kind: string; actor: unknown };
    assert.equal(bound.kind, "bound");
    assert.deepEqual(bound.actor, { principalId: "owner:test", agentSessionId: "agent:test" });
    client.send(request("capabilities.get", "capabilities"));
    const response = await client.next() as { kind: string; result: { screenshotFirst: boolean } };
    assert.equal(response.kind, "response");
    assert.equal(response.result.screenshotFirst, true);
    client.send(bind(server.descriptor.bindingSecret, "owner:other", "agent:other"));
    const rejected = await client.next() as { kind: string; error: { code: string } };
    assert.equal(rejected.kind, "response");
    assert.equal(rejected.error.code, "ALREADY_BOUND");
    client.close();
  });

  it("exposes bounded count-only diagnostics only for an explicit qualification runtime", async () => {
    const ordinary = await started();
    const ordinaryClient = await Client.open(ordinary.server.descriptor.socketPath);
    ordinaryClient.send(bind(ordinary.server.descriptor.bindingSecret)); await ordinaryClient.next();
    ordinaryClient.send(request("qualification.diagnostics", "ordinary-diagnostics"));
    assert.equal(((await ordinaryClient.next()) as { error: { code: string } }).error.code, "CAPABILITY_UNAVAILABLE");
    ordinaryClient.close();

    const directory = await mkdtemp(join(tmpdir(), "browserd-qualification-diagnostics-test-"));
    directories.push(directory);
    const server = new BrowserdServer({ runtimeDirectory: directory, qualificationDiagnostics: true });
    servers.push(server); await server.start();
    const client = await Client.open(server.descriptor.socketPath);
    client.send(bind(server.descriptor.bindingSecret)); await client.next();
    client.send(request("qualification.diagnostics", "qualification-diagnostics"));
    const response = await client.next() as { ok: boolean; result: Record<string, unknown> };
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      kind: "qualificationDiagnostics", sessions: 0, tabs: 0, operations: 0, activeOperations: 0,
      artifacts: 0, artifactBytes: 0, actorSubscriptions: 0, workspaceSubscriptions: 0,
      workspaceFrameLedgers: 0, frameRingEntries: 0, framePins: 0, humanLeases: 0,
      heldKeys: 0, heldButtons: 0,
      capture: {
        agentRequests: 0, frameRequests: 0, agentScreenshotAttempts: 0, frameScreenshotAttempts: 0,
        agentScreenshotRetries: 0, agentScreenshotTimeouts: 0, recoveredAgentScreenshotTimeouts: 0,
        unrecoveredAgentScreenshotTimeouts: 0, frameScreenshotTimeouts: 0, failedAgent: 0,
        droppedFrame: 0, coalescedFrame: 0,
      },
    });
    assert.equal(JSON.stringify(response).includes(server.descriptor.bindingSecret), false);
    client.close();
  });

  it("strictly separates actor and workspace-broker roles", async () => {
    const { server } = await started();
    assert.notEqual(server.descriptor.workspaceBrokerSecret, server.descriptor.bindingSecret);
    assert.notEqual(server.descriptor.workspaceBrokerSecret, server.descriptor.brokerSigningSecret);

    const workspace = await Client.open(server.descriptor.socketPath);
    workspace.send(workspaceBind(server.descriptor.workspaceBrokerSecret));
    const workspaceBound = await workspace.next() as { kind: string; runtimeInstanceId: string };
    assert.equal(workspaceBound.kind, "workspace.bound");
    assert.equal(workspaceBound.runtimeInstanceId, server.descriptor.runtimeInstanceId);
    workspace.send(workspaceRequest("workspace.snapshot.get", "snapshot"));
    const snapshot = await workspace.next() as { ok: boolean; result: { kind: string; sessions: unknown[] } };
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.kind, "workspaceSnapshot");
    assert.deepEqual(snapshot.result.sessions, []);
    workspace.send(request("session.list", "workspace-actor-command"));
    assert.equal(((await workspace.next()) as { error: { code: string } }).error.code, "INVALID_REQUEST");

    const actor = await Client.open(server.descriptor.socketPath);
    actor.send(bind(server.descriptor.bindingSecret)); await actor.next();
    actor.send(workspaceRequest("workspace.snapshot.get", "actor-workspace-command"));
    assert.equal(((await actor.next()) as { error: { code: string } }).error.code, "INVALID_REQUEST");
    actor.send(workspaceBind(server.descriptor.workspaceBrokerSecret));
    assert.equal(((await actor.next()) as { error: { code: string } }).error.code, "ALREADY_BOUND");
    workspace.close(); actor.close();
  });

  it("runs independent requests concurrently on one bound connection", async () => {
    let active = 0;
    let peak = 0;
    class ConcurrentRuntime extends BrowserRuntime {
      override async dispatch(actor: ActorIdentity, requestValue: BrowserRequest): Promise<unknown> {
        void actor; void requestValue;
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { kind: "capabilities", headed: true, screenshotFirst: true, domFallback: true, virtualMouse: true, osMouse: false };
        } finally { active--; }
      }
      override async close(): Promise<void> { /* This fixture owns no browser resources. */ }
    }
    const directory = await mkdtemp(join(tmpdir(), "browserd-concurrency-test-"));
    directories.push(directory);
    const server = new BrowserdServer({ runtimeDirectory: directory, runtime: new ConcurrentRuntime() });
    servers.push(server);
    await server.start();
    const client = await Client.open(server.descriptor.socketPath);
    client.send(bind(server.descriptor.bindingSecret));
    await client.next();
    client.send(request("capabilities.get", "parallel-a"));
    client.send(request("capabilities.get", "parallel-b"));
    await Promise.all([client.next(), client.next()]);
    assert.equal(peak, 2);
    client.close();
  });

  it("rejects a wrong secret and normal requests before binding", async () => {
    const { server } = await started();
    const wrong = await Client.open(server.descriptor.socketPath);
    wrong.send(bind("a".repeat(43)));
    assert.equal(((await wrong.next()) as { error: { code: string } }).error.code, "AUTH_FAILED");
    wrong.close();
    const unbound = await Client.open(server.descriptor.socketPath);
    unbound.send(request("session.list", "unbound"));
    assert.equal(((await unbound.next()) as { error: { code: string } }).error.code, "INVALID_REQUEST");
    unbound.close();
  });

  it("aborts a pending request as soon as its connection closes", async () => {
    let notifyStarted!: () => void;
    const startedDispatch = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let aborted = false;
    class BlockingRuntime extends BrowserRuntime {
      override async dispatch(actor: ActorIdentity, requestValue: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
        void actor; void requestValue;
        notifyStarted();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        throw new Error("connection closed");
      }
      override async close(): Promise<void> { /* This fixture owns no browser resources. */ }
    }
    const directory = await mkdtemp(join(tmpdir(), "browserd-disconnect-test-"));
    directories.push(directory);
    const server = new BrowserdServer({ runtimeDirectory: directory, runtime: new BlockingRuntime() });
    servers.push(server);
    await server.start();
    const client = await Client.open(server.descriptor.socketPath);
    client.send(bind(server.descriptor.bindingSecret));
    await client.next();
    client.send(request("capabilities.get", "pending"));
    await startedDispatch;
    client.close();
    for (let attempt = 0; attempt < 50 && !aborted; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(aborted, true);
  });

  it("clears artifacts and operations during service shutdown", async () => {
    const runtime = new BrowserRuntime();
    const actor = { principalId: "owner:cleanup", agentSessionId: "agent:cleanup" };
    await runtime.artifacts.put(actor, Uint8Array.of(1, 2, 3), { browserSessionId: "session:cleanup", purpose: "agent-observation", mediaType: "image/png" });
    runtime.operations.submit(actor, { operationId: "operation:cleanup", laneKey: "cleanup", deadline: new Date(Date.now() + 10_000).toISOString() }, async () => "done");
    await runtime.operations.wait(actor, "operation:cleanup");
    const directory = await mkdtemp(join(tmpdir(), "browserd-cleanup-test-"));
    directories.push(directory);
    const server = new BrowserdServer({ runtimeDirectory: directory, runtime });
    servers.push(server);
    await server.start();
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    assert.equal(runtime.artifacts.entryCount, 0);
    assert.equal(runtime.operations.size, 0);
  });

  it("enforces bounded NDJSON frames", () => {
    const reader = new NdjsonReader(16);
    assert.deepEqual(reader.push(Buffer.from("{\"a\":1}\n")), ["{\"a\":1}"]);
    assert.throws(() => reader.push(Buffer.alloc(17, 0x61)), /byte limit/i);
  });
});
