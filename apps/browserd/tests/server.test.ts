import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, describe, it } from "vitest";
import { PROTOCOL_VERSION } from "@webx/browser-protocol";
import { BrowserdServer } from "../src/server.js";
import { readDescriptor } from "../src/descriptor.js";
import { NdjsonReader } from "../src/transport.js";

const servers: BrowserdServer[] = [];
afterEach(async () => { await Promise.allSettled(servers.splice(0).map(async (server) => server.stop())); });

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
  const server = new BrowserdServer({ runtimeDirectory: directory });
  servers.push(server);
  await server.start();
  return { server, directory };
}

function bind(secret: string, principalId = "owner:test", agentSessionId = "agent:test") {
  return { protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId: "request:bind", bindingSecret: secret, actor: { principalId, agentSessionId } };
}
function request(kind: "capabilities.get" | "session.list", id: string) {
  return { protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${id}`, operationId: `operation:${id}`, deadline: new Date(Date.now() + 60_000).toISOString() };
}

describe("browserd actor-bound Unix service", () => {
  it("creates private runtime, descriptor, and socket permissions and cleans them", async () => {
    const { server, directory } = await started();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "browserd.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "browserd.sock"))).mode & 0o777, 0o600);
    assert.deepEqual(await readDescriptor(join(directory, "browserd.json")), server.descriptor);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await assert.rejects(() => stat(join(directory, "browserd.json")));
    await assert.rejects(() => stat(join(directory, "browserd.sock")));
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

  it("enforces bounded NDJSON frames", () => {
    const reader = new NdjsonReader(16);
    assert.deepEqual(reader.push(Buffer.from("{\"a\":1}\n")), ["{\"a\":1}"]);
    assert.throws(() => reader.push(Buffer.alloc(17, 0x61)), /byte limit/i);
  });
});
