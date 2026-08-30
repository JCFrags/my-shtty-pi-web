import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserdServer } from "../../browserd/src/server.js";
import type { BrowserRuntime } from "../../../packages/browser-runtime/src/index.js";
import type { FrameEvent, WorkspaceBrokerRequest, WorkspaceSnapshot as BrowserWorkspaceSnapshot } from "../../../packages/browser-protocol/src/index.js";
import { encodeWorkspaceRecord, parseWorkspaceServerHeader, WorkspaceRecordDecoder, type WorkspaceWireRecord } from "../../../packages/workspace-protocol/src/index.js";
import { WorkspaceGateway } from "../src/workspace/gateway.js";
import { readWorkspaceDescriptor } from "../src/workspace/descriptor.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.().catch(() => undefined); });

describe("private workspace gateway", () => {
  it("publishes a private descriptor, authenticates framed clients, reports legacy unavailable, and cleans only its files", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-legacy-"));
    const runtimeDirectory = join(root, "workspace");
    const gateway = new WorkspaceGateway({ runtimeDirectory, browserBackend: "legacy" });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(runtimeDirectory, "workspace.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
    await expect(readWorkspaceDescriptor(join(runtimeDirectory, "workspace.json"), runtimeDirectory)).resolves.toEqual(descriptor);

    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    const bind = encodeWorkspaceRecord({ protocolVersion: "workspace.v1", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    for (const byte of bind) client.write(Uint8Array.of(byte));
    expect((await client.next()).header).toMatchObject({ kind: "bound", requestId: "request:bind", webxdRuntimeInstanceId: descriptor.webxdRuntimeInstanceId });
    expect((await client.next()).header).toMatchObject({ kind: "status", status: { connection: "unavailable", browserd: "unavailable" } });
    client.send({ protocolVersion: "workspace.v1", kind: "snapshot.get", requestId: "request:snapshot" });
    expect((await client.next()).header).toMatchObject({ kind: "response", requestId: "request:snapshot", ok: true, result: { kind: "snapshot", snapshot: { browserdState: "unavailable", sessions: [] } } });
    expect(client.receivedText).not.toContain(descriptor.bindingSecret);
    expect(client.receivedText).not.toContain(descriptor.socketPath);

    await gateway.stop();
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runtimeDirectory, "workspace.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the real browserd workspace role, translates an aggregate snapshot, reconnects after webxd restart, and detects browserd replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-real-"));
    const browserDirectory = join(root, "browserd");
    let browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, allowTemporaryRuntimeDirectoryForTest: true, chrome: { profileRoot: join(root, "profiles") } });
    const firstBrowser = await browserd.start(); cleanups.push(async () => await browserd.stop());
    let gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    let workspace = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const firstSnapshot = await bindAndSnapshot(workspace);
    expect(firstSnapshot).toMatchObject({ browserdRuntimeInstanceId: firstBrowser.runtimeInstanceId, browserdState: "ready", sessions: [] });
    expect(workspace.bindingSecret).not.toBe(firstBrowser.workspaceBrokerSecret);

    await gateway.stop();
    gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    workspace = await gateway.start(); cleanups.push(async () => await gateway.stop());
    expect(await bindAndSnapshot(workspace)).toMatchObject({ browserdRuntimeInstanceId: firstBrowser.runtimeInstanceId, browserdState: "ready" });

    await browserd.stop();
    browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, allowTemporaryRuntimeDirectoryForTest: true, chrome: { profileRoot: join(root, "profiles-new") } });
    const replacement = await browserd.start(); cleanups.push(async () => await browserd.stop());
    await waitUntil(() => gateway.diagnostics.broker.runtimeInstanceId === replacement.runtimeInstanceId && gateway.diagnostics.broker.connected, 4_000);
    const replacedSnapshot = await bindAndSnapshot(workspace);
    expect(replacedSnapshot).toMatchObject({ browserdRuntimeInstanceId: replacement.runtimeInstanceId, browserdState: "ready", sessions: [] });
    expect(replacement.runtimeInstanceId).not.toBe(firstBrowser.runtimeInstanceId);
  });

  it("selects one exact tab and emits verified raw frame payload bytes without base64", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-frame-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v1", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v1", kind: "snapshot.get", requestId: "request:snapshot" });
    const snapshotResponse = (await client.next()).header as { result: { snapshot: { sessions: Array<{ cursor: Record<string, unknown> }> } } };
    expect(snapshotResponse.result.snapshot.sessions).toHaveLength(1);
    expect(snapshotResponse.result.snapshot.sessions[0]?.cursor).not.toHaveProperty("personaId");
    client.send({ protocolVersion: "workspace.v1", kind: "frame.select", requestId: "request:select", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one" });
    const selected = (await client.next()).header as { result: { subscriptionId?: string } };
    expect(selected).toMatchObject({ kind: "response", ok: true, result: { kind: "selection", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one" } });
    await waitUntil(() => runtime.subscriptionId !== undefined);
    runtime.publishFrame();
    const frame = await client.next(4_000);
    expect(frame.header).toMatchObject({ kind: "frame", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one", frameSequence: 1, byteLength: runtime.frameBytes.byteLength, sha256: runtime.sha256 });
    expect(frame.payload).toEqual(runtime.frameBytes);
    expect(JSON.stringify(frame.header)).not.toContain("base64");
    expect(gateway.diagnostics.pendingFrames).toBe(0);

    client.send({ protocolVersion: "workspace.v1", kind: "frame.clear", requestId: "request:clear" });
    expect((await client.next()).header).toMatchObject({ kind: "response", ok: true, result: { kind: "ack" } });
    expect(runtime.subscriptionId).toBeUndefined();
    expect(gateway.diagnostics.selectedClients).toBe(0);
  });

  it("rejects insecure descriptor permissions and connection rebinding", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-security-"));
    const runtimeDirectory = join(root, "workspace");
    const gateway = new WorkspaceGateway({ runtimeDirectory, browserBackend: "legacy" });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    await chmod(join(runtimeDirectory, "workspace.json"), 0o644);
    await expect(readWorkspaceDescriptor(join(runtimeDirectory, "workspace.json"), runtimeDirectory)).rejects.toThrow("private regular file");
    await chmod(join(runtimeDirectory, "workspace.json"), 0o600);
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v1", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v1", kind: "bind", requestId: "request:rebind", bindingSecret: descriptor.bindingSecret });
    expect((await client.next()).header).toMatchObject({ kind: "response", requestId: "request:rebind", ok: false, error: { code: "AUTH_FAILED" } });
    await waitUntil(() => client.closed);
  });
});

class FramedClient {
  readonly #decoder = new WorkspaceRecordDecoder();
  readonly #records: WorkspaceWireRecord[] = [];
  readonly #waiters: Array<() => void> = [];
  receivedText = "";
  closed = false;
  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.receivedText += chunk.toString("latin1");
      for (const record of this.#decoder.push(chunk)) this.#records.push({ header: parseWorkspaceServerHeader(record.header), payload: record.payload });
      while (this.#waiters.length > 0) this.#waiters.shift()?.();
    });
    socket.once("close", () => { this.closed = true; while (this.#waiters.length > 0) this.#waiters.shift()?.(); });
  }
  static async open(path: string): Promise<FramedClient> { const socket = createConnection({ path }); await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }); return new FramedClient(socket); }
  send(header: unknown, payload = new Uint8Array()): void { this.socket.write(encodeWorkspaceRecord(header, payload)); }
  write(bytes: Uint8Array): void { this.socket.write(bytes); }
  async next(timeoutMs = 2_000): Promise<WorkspaceWireRecord> {
    const existing = this.#records.shift(); if (existing !== undefined) return existing;
    await new Promise<void>((resolve, reject) => { const done = () => { clearTimeout(timer); resolve(); }; const timer = setTimeout(() => { const index = this.#waiters.indexOf(done); if (index >= 0) this.#waiters.splice(index, 1); reject(new Error("timed out waiting for workspace record")); }, timeoutMs); this.#waiters.push(done); });
    const record = this.#records.shift(); if (record === undefined) throw new Error("workspace connection closed before a record arrived"); return record;
  }
  async close(): Promise<void> { if (this.socket.destroyed) return; await new Promise<void>((resolve) => { this.socket.once("close", resolve); this.socket.destroy(); }); }
}

class FakeWorkspaceRuntime extends EventEmitter {
  readonly frameBytes = Uint8Array.from({ length: 8192 }, (_, index) => (index * 31) & 0xff);
  readonly sha256 = createHash("sha256").update(this.frameBytes).digest("hex");
  subscriptionId?: string;
  connectionId?: string;
  readonly snapshot: BrowserWorkspaceSnapshot = {
    kind: "workspaceSnapshot", workspaceRevision: 1, generatedAt: new Date().toISOString(), sessions: [{ browserSessionId: "session:one", agentSessionId: "agent:one", actorDisplayId: "actor_1234567890123456", pathId: "agentcursor/chrome", state: "ready", controlState: "agent", personaId: "persona_1234567890123456", cursor: { x: 10, y: 20, visible: true, pathSequence: 1, sampleSequence: 2, personaId: "persona_1234567890123456" }, tabs: [{ tabId: "tab:one", url: "http://fixture.local/", title: "Fixture <script>", state: "ready", documentGeneration: 1, viewportGeneration: 1, frameSequence: 0 }] }],
  };
  workspaceSnapshot(): BrowserWorkspaceSnapshot { return this.snapshot; }
  workspaceSubscribeEvents(): void {}
  workspaceUnsubscribeEvents(): void {}
  shouldDeliverWorkspaceEvent(): boolean { return true; }
  workspaceSubscribeFrames(connectionId: string, subscriptionId: string): void { this.connectionId = connectionId; this.subscriptionId = subscriptionId; }
  async workspaceUnsubscribeFrames(_connectionId: string, subscriptionId: string): Promise<void> { if (this.subscriptionId === subscriptionId) { this.subscriptionId = undefined; this.connectionId = undefined; } }
  workspaceFrameDeliveries(connectionId: string, frame: FrameEvent): Array<{ subscriptionId: string; frame: FrameEvent }> { return connectionId === this.connectionId && this.subscriptionId !== undefined ? [{ subscriptionId: this.subscriptionId, frame }] : []; }
  recordWorkspaceFrameDelivered(): void {}
  async workspaceReadFrame(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.frame.read" }>): Promise<unknown> {
    const offset = request.offset ?? 0; const max = request.maxBytes ?? this.frameBytes.byteLength; const chunk = this.frameBytes.slice(offset, Math.min(this.frameBytes.byteLength, offset + max));
    return { kind: "workspaceFrameArtifact", artifactId: "artifact_1234567890123456", browserSessionId: "session:one", tabId: "tab:one", subscriptionId: request.subscriptionId, frameSequence: 1, mediaType: "image/png", byteLength: chunk.byteLength, sha256: this.sha256, offset, totalBytes: this.frameBytes.byteLength, eof: offset + chunk.byteLength === this.frameBytes.byteLength, base64: Buffer.from(chunk).toString("base64") };
  }
  releaseConnection(): void { this.subscriptionId = undefined; this.connectionId = undefined; }
  async close(): Promise<void> {}
  publishFrame(): void {
    const frame: FrameEvent = { protocolVersion: "browser.v2", kind: "frame.available", address: { browserSessionId: "session:one", tabId: "tab:one", targetId: "target_1234567890123456", controlEpoch: 1 }, documentGeneration: 1, viewportGeneration: 1, frameSequence: 1, capturedMonotonicMs: 100, publishedMonotonicMs: 110, mediaType: "image/png", byteLength: this.frameBytes.byteLength, artifactId: "artifact_1234567890123456", sha256: this.sha256, viewport: { width: 800, height: 600, devicePixelRatio: 1 }, url: "http://fixture.local/", title: "Fixture", cursor: { x: 10, y: 20, visible: true, pathSequence: 1, sampleSequence: 2, personaId: "persona_1234567890123456" } };
    this.emit("frame", frame);
  }
}

async function bindAndSnapshot(descriptor: { socketPath: string; bindingSecret: string }): Promise<Record<string, unknown>> {
  const client = await FramedClient.open(descriptor.socketPath);
  try {
    client.send({ protocolVersion: "workspace.v1", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v1", kind: "snapshot.get", requestId: "request:snapshot" });
    const response = (await client.next()).header as { result: { snapshot: Record<string, unknown> } }; return response.result.snapshot;
  } finally { await client.close(); }
}
async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) throw new Error("timed out waiting for condition"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
