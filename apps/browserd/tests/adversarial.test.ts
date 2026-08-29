import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, describe, it } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type BrowserRequest, type FrameEvent } from "@webx/browser-protocol";
import { BrowserRuntime } from "@webx/browser-runtime";
import { prepareDescriptor, readDescriptor } from "../src/descriptor.js";
import { BrowserdServer } from "../src/server.js";

const servers: BrowserdServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(async (server) => server.stop()));
  await Promise.allSettled(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "browserd-adversarial-")); directories.push(value); return value; }

class Client {
  private buffer = "";
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];
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
        if (waiter) waiter(value); else this.queued.push(value);
      }
    });
  }
  static async open(path: string): Promise<Client> { const socket = connect(path); await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }); return new Client(socket); }
  send(value: unknown): void { this.socket.write(`${JSON.stringify(value)}\n`); }
  async next(timeoutMs = 1_000): Promise<unknown> { const value = this.queued.shift(); if (value !== undefined) return value; return await Promise.race([new Promise<unknown>((resolve) => this.waiters.push(resolve)), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("response timeout")), timeoutMs))]); }
  close(): void { this.socket.destroy(); }
}
function bind(secret: string, actor: ActorIdentity = { principalId: "owner:test", agentSessionId: "agent:test" }) { return { protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId: `request:bind:${Math.random()}`, bindingSecret: secret, actor }; }
function deadline(): string { return new Date(Date.now() + 30_000).toISOString(); }

async function startWith(runtime: BrowserRuntime): Promise<BrowserdServer> {
  const server = new BrowserdServer({ runtimeDirectory: await directory(), runtime });
  servers.push(server);
  await server.start();
  return server;
}

describe("ready-state atomic descriptor ownership", () => {
  it("does not publish a descriptor until the socket is ready and publishes required process identity", async () => {
    const runtimeDirectory = await directory();
    const server = new BrowserdServer({ runtimeDirectory });
    servers.push(server);
    const starting = server.start();
    const early = await readFile(join(runtimeDirectory, "browserd.json"), "utf8").catch(() => undefined);
    if (early !== undefined) {
      const earlyDescriptor = JSON.parse(early) as { socketPath: string };
      const client = await Client.open(earlyDescriptor.socketPath);
      client.close();
    }
    const descriptor = await starting;
    assert.match(descriptor.runtimeInstanceId, /^runtime_/);
    assert.equal(descriptor.pid, process.pid);
    assert.match(descriptor.processStartTicks, /^\d+$/);
    assert.equal((await stat(descriptor.socketPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readDescriptor(join(runtimeDirectory, "browserd.json")), descriptor);
  });

  it("blocks a matching live owner but accepts a reused PID with mismatching start ticks", async () => {
    const runtimeDirectory = await directory();
    const prepared = await prepareDescriptor(runtimeDirectory);
    await writeFile(prepared.paths.descriptorPath, `${JSON.stringify(prepared.descriptor)}\n`, { mode: 0o600 });
    await assert.rejects(() => prepareDescriptor(runtimeDirectory), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    await writeFile(prepared.paths.descriptorPath, `${JSON.stringify({ ...prepared.descriptor, processStartTicks: "0" })}\n`, { mode: 0o600 });
    const replacement = await prepareDescriptor(runtimeDirectory);
    assert.notEqual(replacement.descriptor.runtimeInstanceId, prepared.descriptor.runtimeInstanceId);
  });

  it("removes descriptor and socket on repeated stop", async () => {
    const server = await startWith(new BrowserRuntime());
    const { socketPath } = server.descriptor;
    const descriptorPath = join(socketPath.slice(0, socketPath.lastIndexOf("/")), "browserd.json");
    await server.stop();
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await assert.rejects(() => stat(socketPath));
    await assert.rejects(() => stat(descriptorPath));
  });
});

describe("connection frame isolation and typed failures", () => {
  it("delivers frames only to the subscribed connection and cleans it on disconnect", async () => {
    class RoutingRuntime extends BrowserRuntime {
      readonly subscribed = new Set<string>();
      readonly released: string[] = [];
      override async dispatch(_actor: ActorIdentity, request: BrowserRequest, _signal?: AbortSignal, connectionId?: string): Promise<unknown> {
        if (request.kind === "frames.subscribe" && connectionId !== undefined) { this.subscribed.add(connectionId); return { kind: "subscription", operationId: request.operationId, subscriptionId: request.subscriptionId, subscribed: true }; }
        return { kind: "ack", operationId: request.operationId };
      }
      override shouldDeliverFrame(connectionId: string): boolean { return this.subscribed.has(connectionId); }
      override releaseConnection(connectionId: string): void { this.subscribed.delete(connectionId); this.released.push(connectionId); }
      override async close(): Promise<void> {}
    }
    const runtime = new RoutingRuntime();
    const server = await startWith(runtime);
    const subscribed = await Client.open(server.descriptor.socketPath);
    const silent = await Client.open(server.descriptor.socketPath);
    for (const client of [subscribed, silent]) { client.send(bind(server.descriptor.bindingSecret)); await client.next(); }
    const frameAddress = { browserSessionId: "session:routing", tabId: "tab:routing", targetId: "target_routing_01", controlEpoch: 1 };
    subscribed.send({ protocolVersion: PROTOCOL_VERSION, kind: "frames.subscribe", requestId: "request:subscribe", operationId: "operation:subscribe", deadline: deadline(), address: frameAddress, subscriptionId: "subscription_route1", interest: "selected" });
    assert.equal(((await subscribed.next()) as { result: { subscribed: boolean } }).result.subscribed, true);
    const frame: FrameEvent = {
      protocolVersion: PROTOCOL_VERSION, kind: "frame.available", address: frameAddress, documentGeneration: 1, viewportGeneration: 1, frameSequence: 1,
      capturedMonotonicMs: 10, publishedMonotonicMs: 11, mediaType: "image/png", byteLength: 3, artifactId: "artifact_routing", sha256: "a".repeat(64),
      viewport: { width: 800, height: 600, devicePixelRatio: 1 }, url: "https://fixture.invalid/", title: "Fixture",
      cursor: { x: 1, y: 2, pathSequence: 1, sampleSequence: 1, personaId: "persona_routing_01", visible: true },
    };
    runtime.emit("frame", frame);
    assert.equal(((await subscribed.next()) as { kind: string }).kind, "frame.available");
    await assert.rejects(() => silent.next(30), /timeout/);
    subscribed.close();
    for (let attempt = 0; attempt < 50 && runtime.released.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(runtime.subscribed.size, 0);
    silent.close();
  });

  it("preserves typed codes, sanitizes details, and maps unknown failures to INTERNAL_ERROR", async () => {
    class FailureRuntime extends BrowserRuntime {
      override async dispatch(_actor: ActorIdentity, request: BrowserRequest): Promise<unknown> {
        if (request.requestId.endsWith("typed")) throw new BrowserProtocolError("NAVIGATION_DENIED", "Denied at /home/user/profile ws://127.0.0.1:9222/devtools", false, { path: "/tmp/profile-secret", safeCount: 2 });
        throw new Error("cookie=secret /home/user/profile");
      }
      override async close(): Promise<void> {}
    }
    const server = await startWith(new FailureRuntime());
    const client = await Client.open(server.descriptor.socketPath);
    client.send(bind(server.descriptor.bindingSecret)); await client.next();
    const request = (id: string) => ({ protocolVersion: PROTOCOL_VERSION, kind: "capabilities.get", requestId: `request:${id}`, operationId: `operation:${id}`, deadline: deadline() });
    client.send(request("typed"));
    const typed = (await client.next()) as { error: { code: string; message: string; details: Record<string, unknown> } };
    assert.equal(typed.error.code, "NAVIGATION_DENIED");
    assert.doesNotMatch(typed.error.message, /home|127\.0\.0\.1|devtools/);
    assert.doesNotMatch(String(typed.error.details.path), /tmp|profile/);
    client.send(request("unknown"));
    const unknown = (await client.next()) as { error: { code: string; message: string } };
    assert.equal(unknown.error.code, "INTERNAL_ERROR");
    assert.equal(unknown.error.message, "Browser request failed.");
    assert.doesNotMatch(JSON.stringify(unknown), /cookie|secret|home/);
    client.close();
  });
});
