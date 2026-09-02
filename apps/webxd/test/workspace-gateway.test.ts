import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserdServer } from "../../browserd/src/server.js";
import type { BrowserRuntime } from "../../../packages/browser-runtime/src/index.js";
import { BrowserProtocolError, type FrameEvent, type WorkspaceBrokerRequest, type WorkspaceSnapshot as BrowserWorkspaceSnapshot } from "../../../packages/browser-protocol/src/index.js";
import { encodeWorkspaceRecord, parseWorkspaceServerHeader, WorkspaceRecordDecoder, type WorkspaceWireRecord } from "../../../packages/workspace-protocol/src/index.js";
import { WorkspaceGateway } from "../src/workspace/gateway.js";
import { readWorkspaceDescriptor } from "../src/workspace/descriptor.js";
import { sanitizeWorkspaceSnapshot } from "../src/workspace/sanitizer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.().catch(() => undefined); });

describe("private workspace gateway", () => {
  it("sanitizes bounded resource status into the trusted workspace snapshot", () => {
    const runtime = new FakeWorkspaceRuntime();
    const snapshot: BrowserWorkspaceSnapshot = {
      ...runtime.snapshot,
      sessions: runtime.snapshot.sessions.map((session) => ({
        ...session,
        resource: { state: "warning", reason: "session-memory" },
      })),
    };
    const sanitized = sanitizeWorkspaceSnapshot(snapshot, "runtime:one");
    expect(sanitized.sessions[0]?.resource).toEqual({ state: "warning", reason: "session-memory" });
  });

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
    const bind = encodeWorkspaceRecord({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    for (const byte of bind) client.write(Uint8Array.of(byte));
    expect((await client.next()).header).toMatchObject({ kind: "bound", requestId: "request:bind", webxdRuntimeInstanceId: descriptor.webxdRuntimeInstanceId });
    expect((await client.next()).header).toMatchObject({ kind: "status", status: { connection: "unavailable", browserd: "unavailable" } });
    client.send({ protocolVersion: "workspace.v2", kind: "snapshot.get", requestId: "request:snapshot" });
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
    const replacedSnapshot = await waitForSnapshot(
      workspace,
      (snapshot) => snapshot.browserdRuntimeInstanceId === replacement.runtimeInstanceId && snapshot.browserdState === "ready",
      4_000,
    );
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
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "snapshot.get", requestId: "request:snapshot" });
    const snapshotResponse = (await client.next()).header as { result: { snapshot: { sessions: Array<{ agentLabel: string; personaDisplayId: string; cursor: Record<string, unknown> }> } } };
    expect(snapshotResponse.result.snapshot.sessions).toHaveLength(1);
    const displaySession = snapshotResponse.result.snapshot.sessions[0];
    expect(displaySession?.cursor).not.toHaveProperty("personaId");
    expect(displaySession?.agentLabel).toMatch(/^Pi agent [0-9a-f]{12}$/u);
    expect(displaySession?.personaDisplayId).toMatch(/^persona-[0-9a-f]{12}$/u);
    expect(JSON.stringify(displaySession)).not.toContain("agent:one");
    expect(JSON.stringify(displaySession)).not.toContain("persona_1234567890123456");
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one" });
    const selected = (await client.next()).header as { result: { subscriptionId?: string } };
    expect(selected).toMatchObject({ kind: "response", ok: true, result: { kind: "selection", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one" } });
    await waitUntil(() => runtime.subscriptionId !== undefined);
    runtime.publishFrame();
    const frame = await client.next(4_000);
    expect(frame.header).toMatchObject({ kind: "frame", selectionId: "selection_1234567890", browserSessionId: "session:one", tabId: "tab:one", frameSequence: 1, byteLength: runtime.frameBytes.byteLength, sha256: runtime.sha256 });
    expect(frame.payload).toEqual(runtime.frameBytes);
    expect(JSON.stringify(frame.header)).not.toContain("base64");
    expect(gateway.diagnostics.pendingFrames).toBe(0);

    client.send({ protocolVersion: "workspace.v2", kind: "frame.clear", requestId: "request:clear" });
    expect((await client.next()).header).toMatchObject({ kind: "response", ok: true, result: { kind: "ack" } });
    expect(runtime.subscriptionId).toBeUndefined();
    expect(gateway.diagnostics.selectedClients).toBe(0);
  });

  it("preserves an acknowledged selection across a transient snapshot failure on a live broker connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-transient-snapshot-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_transient_01", browserSessionId: "session:one", tabId: "tab:one" });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select")).header).toMatchObject({ kind: "response", requestId: "request:select", ok: true });
    runtime.failNextSnapshot = true;
    await waitUntil(() => runtime.snapshotFailures === 1, 4_000);
    expect(gateway.diagnostics.selectedClients).toBe(1);
    expect(gateway.diagnostics.broker).toMatchObject({ connected: true, subscriptions: 1 });
    runtime.publishFrame();
    expect((await nextMatching(client, (header) => header.kind === "frame")).header).toMatchObject({ kind: "frame", selectionId: "selection_transient_01", browserSessionId: "session:one", tabId: "tab:one" });
  });

  it("preserves the former selection when an atomic replacement is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-replace-failure-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:first", selectionId: "selection_first_0001", browserSessionId: "session:one", tabId: "tab:one" });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:first")).header).toMatchObject({ kind: "response", ok: true });
    runtime.failReplace = true;
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:failed", selectionId: "selection_failed_001", browserSessionId: "session:missing", tabId: "tab:missing" });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:failed")).header).toMatchObject({ kind: "response", requestId: "request:failed", ok: false });
    runtime.failReplace = false;
    expect(gateway.diagnostics.selectedClients).toBe(1);
    expect(gateway.diagnostics.broker.subscriptions).toBe(1);
    runtime.publishFrame();
    expect((await nextMatching(client, (header) => header.kind === "frame")).header).toMatchObject({ kind: "frame", selectionId: "selection_first_0001", browserSessionId: "session:one", tabId: "tab:one" });
    expect(gateway.diagnostics.selectedClients).toBe(1);
    expect(gateway.diagnostics.broker.subscriptions).toBe(1);
  });

  it("orders an authoritative selection response before a rebound cached frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-cached-frame-"));
    const runtime = new FakeWorkspaceRuntime(); runtime.cachedOnReplace = true;
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:cached", selectionId: "selection_cached_001", browserSessionId: "session:one", tabId: "tab:one" });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:cached")).header).toMatchObject({ kind: "response", requestId: "request:cached", ok: true });
    const cached = await client.next();
    expect(cached.header).toMatchObject({ kind: "frame", selectionId: "selection_cached_001", frameSequence: 1, sha256: runtime.sha256 });
    expect(cached.payload).toEqual(runtime.frameBytes);
    expect(gateway.diagnostics.pendingFrames).toBe(0);
  });

  it("brokers control without exposing leases or retaining human text, and returns control on disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-control-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_control_01", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select");
    runtime.publishFrame();
    const agentFrame = (await nextMatching(client, (header) => header.kind === "frame")).header as Record<string, unknown>;
    const paintedAt = new Date().toISOString();
    const agentBinding = paintedBinding(agentFrame, paintedAt);

    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: agentBinding });
    const acquired = (await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header;
    expect(acquired).toMatchObject({ ok: true, result: { kind: "controlAcquired", browserSessionId: "session:one", selectedHumanControlTabId: "tab:one", controlState: "human", controlEpoch: 2, inputTargetGeneration: 1 } });
    expect(JSON.stringify(acquired)).not.toContain(runtime.leaseId);
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: agentBinding });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: true, result: { kind: "controlAcquired", controlEpoch: 2 } });
    expect(runtime.acquireCount).toBe(1);
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 2, frame: agentBinding });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT" } });
    expect(runtime.acquireCount).toBe(1);

    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:blocked-select", selectionId: "selection_blocked_1", browserSessionId: "session:one", tabId: "tab:one" });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:blocked-select")).header).toMatchObject({ ok: false, error: { code: "CONTROL_HELD_BY_HUMAN" } });

    runtime.controlEpoch = 2;
    runtime.publishFrame();
    const humanFrame = (await nextMatching(client, (header) => header.kind === "frame" && header.controlEpoch === 2)).header as Record<string, unknown>;
    const humanBinding = paintedBinding(humanFrame, new Date().toISOString());
    const secretText = "phase4a-secret-NeverRetain-Ω-42";
    const baseEvents = [
      { kind: "pointerMove", point: { imageX: 100, imageY: 50 } },
      { kind: "pointerDown", point: { imageX: 100, imageY: 50 }, button: "left", clickCount: 1 },
      { kind: "pointerMove", point: { imageX: 120, imageY: 70 } },
      { kind: "pointerUp", point: { imageX: 120, imageY: 70 }, button: "left", clickCount: 1 },
      { kind: "wheel", point: { imageX: 120, imageY: 70 }, deltaX: 1, deltaY: 2 },
      { kind: "keyDown", key: "A", code: "KeyA", location: 0, modifiers: 0, repeat: false },
      { kind: "text", text: secretText },
    ] as const;
    const sendInput = (events: readonly unknown[]): void => client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:input", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 1, inputTargetGeneration: 1, frame: humanBinding, events });
    sendInput(baseEvents);
    const input = (await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:input")).header;
    expect(input).toMatchObject({ ok: true, result: { kind: "inputAck", inputBatchSequence: 1, acceptedEventCount: baseEvents.length } });
    expect(runtime.inputEventCounts).toEqual({ pointerMove: 2, pointerDown: 1, pointerUp: 1, wheel: 1, keyDown: 1, text: 1 });
    expect(runtime.inputBatchCount).toBe(1);
    expect(JSON.stringify(input)).not.toContain(secretText);

    sendInput(baseEvents);
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:input")).header).toMatchObject({ ok: true, result: { kind: "inputAck", inputBatchSequence: 1 } });
    expect(runtime.inputBatchCount).toBe(1);

    const conflictingEvents = [
      baseEvents.map((event, index) => index === 0 ? { ...event, point: { imageX: 101, imageY: 50 } } : event),
      baseEvents.map((event, index) => index === 0 ? { ...event, point: { imageX: 100, imageY: 51 } } : event),
      baseEvents.map((event, index) => index === 1 ? { ...event, button: "right" } : event),
      baseEvents.map((event, index) => index === 1 ? { ...event, clickCount: 2 } : event),
      baseEvents.map((event, index) => index === 4 ? { ...event, deltaX: 2 } : event),
      baseEvents.map((event, index) => index === 4 ? { ...event, deltaY: 3 } : event),
      baseEvents.map((event, index) => index === 5 ? { ...event, code: "KeyB" } : event),
      baseEvents.map((event, index) => index === 5 ? { ...event, location: 1 } : event),
      baseEvents.map((event, index) => index === 5 ? { ...event, modifiers: 2 } : event),
      baseEvents.map((event, index) => index === 5 ? { ...event, repeat: true } : event),
      baseEvents.map((event, index) => index === 6 ? { ...event, text: "phase4a-secret-Different-雪-99" } : event),
      [baseEvents[1], baseEvents[0], ...baseEvents.slice(2)],
      baseEvents.map((event, index) => index === 2 ? { ...event, point: { imageX: 121, imageY: 70 } } : event),
    ];
    for (const events of conflictingEvents) {
      sendInput(events);
      expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:input")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT", retryable: false } });
      expect(runtime.inputBatchCount).toBe(1);
    }
    client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:input", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 2, inputTargetGeneration: 1, frame: humanBinding, events: baseEvents });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:input")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT" } });
    client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:input-other", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 1, inputTargetGeneration: 1, frame: humanBinding, events: baseEvents });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:input-other")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT" } });
    expect(runtime.inputBatchCount).toBe(1);
    expect(client.receivedText).not.toContain(runtime.leaseId);
    expect(client.receivedText).not.toContain(secretText);
    expect(client.receivedText).not.toContain("phase4a-secret-Different-雪-99");

    client.send({ protocolVersion: "workspace.v2", kind: "control.heartbeat", requestId: "request:heartbeat", browserSessionId: "session:one", controlEpoch: 2 });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:heartbeat")).header).toMatchObject({ ok: true, result: { kind: "controlHeartbeat", controlState: "human", controlEpoch: 2 } });
    expect(runtime.heartbeatCount).toBe(1);

    client.send({ protocolVersion: "workspace.v2", kind: "control.release", requestId: "request:release", browserSessionId: "session:one", controlEpoch: 2 });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:release")).header).toMatchObject({ ok: true, result: { kind: "controlReleased", controlState: "agent", controlEpoch: 3 } });
    client.send({ protocolVersion: "workspace.v2", kind: "control.release", requestId: "request:release", browserSessionId: "session:one", controlEpoch: 2 });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:release")).header).toMatchObject({ ok: true, result: { kind: "controlReleased", controlEpoch: 3 } });
    expect(runtime.releaseCount).toBe(1);
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: agentBinding });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT" } });

    await client.close();
    expect(runtime.releaseCount).toBe(1);
    expect(runtime.controlEpoch).toBe(3);
    expect(runtime.releasedLeaseIds).toEqual([runtime.leaseId]);
  });

  it("closes the trusted desktop authority and releases control when input fingerprinting fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-fingerprint-failure-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    let failFingerprint = false;
    const gateway = new WorkspaceGateway({
      runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor",
      browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory,
      heartbeatMs: 100, inputFingerprintFaultForTest: () => { if (failFingerprint) throw new Error("injected fingerprint failure"); },
    });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_digest_fail", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select");
    runtime.publishFrame();
    const agentFrame = (await nextMatching(client, (header) => header.kind === "frame")).header as Record<string, unknown>;
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: paintedBinding(agentFrame, new Date().toISOString()) });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: true, result: { controlState: "human", controlEpoch: 2 } });
    runtime.controlEpoch = 2;
    runtime.publishFrame();
    const humanFrame = (await nextMatching(client, (header) => header.kind === "frame" && header.controlEpoch === 2)).header as Record<string, unknown>;
    const secret = "phase4a-fingerprint-failure-secret-雪";
    failFingerprint = true;
    client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:fingerprint-failure", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 1, inputTargetGeneration: 1, frame: paintedBinding(humanFrame, new Date().toISOString()), events: [{ kind: "text", text: secret }] });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:fingerprint-failure")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT", retryable: false } });
    await waitUntil(() => gateway.diagnostics.clientConnections === 0 && runtime.releaseCount === 1);
    expect(runtime.inputBatchCount).toBe(0);
    expect(client.receivedText).not.toContain(secret);
    expect(client.receivedText).not.toContain(runtime.leaseId);
  });

  it("namespaces identical control request IDs across trusted desktop clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-cross-client-control-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());

    const first = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => first.close());
    first.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind-first", bindingSecret: descriptor.bindingSecret }); await first.next(); await first.next();
    first.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select-first", selectionId: "selection_cross_first", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(first, (header) => header.kind === "response" && header.requestId === "request:select-first");
    runtime.publishFrame();
    const firstFrame = (await nextMatching(first, (header) => header.kind === "frame")).header as Record<string, unknown>;
    first.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:same-acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: paintedBinding(firstFrame, new Date().toISOString()) });
    expect((await nextMatching(first, (header) => header.kind === "response" && header.requestId === "request:same-acquire")).header).toMatchObject({ ok: true, result: { kind: "controlAcquired", controlEpoch: 2 } });
    first.send({ protocolVersion: "workspace.v2", kind: "control.release", requestId: "request:first-release", browserSessionId: "session:one", controlEpoch: 2 });
    expect((await nextMatching(first, (header) => header.kind === "response" && header.requestId === "request:first-release")).header).toMatchObject({ ok: true, result: { controlEpoch: 3 } });
    await first.close();

    const second = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => second.close());
    second.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind-second", bindingSecret: descriptor.bindingSecret }); await second.next(); await second.next();
    second.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select-second", selectionId: "selection_cross_second", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(second, (header) => header.kind === "response" && header.requestId === "request:select-second");
    runtime.publishFrame();
    const secondFrame = (await nextMatching(second, (header) => header.kind === "frame")).header as Record<string, unknown>;
    second.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:same-acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 3, frame: paintedBinding(secondFrame, new Date().toISOString()) });
    expect((await nextMatching(second, (header) => header.kind === "response" && header.requestId === "request:same-acquire")).header).toMatchObject({ ok: true, result: { kind: "controlAcquired", controlEpoch: 4 } });
    expect(runtime.acquireCount).toBe(2);
  });

  it("expires control when the trusted desktop stops heartbeating and rejects stale local authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-heartbeat-expiry-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100, desktopHeartbeatTimeoutMs: 200 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_expiry_001", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select");
    runtime.publishFrame();
    const frame = (await nextMatching(client, (header) => header.kind === "frame")).header as Record<string, unknown>;
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: paintedBinding(frame, new Date().toISOString()) });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: true, result: { kind: "controlAcquired", controlEpoch: 2 } });

    await waitUntil(() => runtime.releaseCount === 1, 2_000);
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: paintedBinding(frame, new Date().toISOString()) });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_CONFLICT" } });
    expect(runtime.acquireCount).toBe(2);
    client.send({ protocolVersion: "workspace.v2", kind: "control.heartbeat", requestId: "request:late-heartbeat", browserSessionId: "session:one", controlEpoch: 2 });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:late-heartbeat")).header).toMatchObject({ ok: false, error: { code: "CONTROL_LEASE_REQUIRED", retryable: false } });
    expect(runtime.heartbeatCount).toBe(0);
    expect(runtime.controlEpoch).toBe(3);
  });

  it("rejects stale painted bindings before control or input reaches browserd", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-stale-control-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_stale_001", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select");
    runtime.publishFrame();
    const frame = (await nextMatching(client, (header) => header.kind === "frame")).header as Record<string, unknown>;
    const stale = { ...paintedBinding(frame, new Date().toISOString()), frameSequence: 99 };
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:stale", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: stale });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:stale")).header).toMatchObject({ ok: false, error: { code: "INPUT_FRAME_STALE", retryable: true } });
    expect(runtime.acquireCount).toBe(0);
  });

  it("forwards only held-input release shapes after the painted-frame age limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "webxd-workspace-stale-release-"));
    const runtime = new FakeWorkspaceRuntime();
    const browserDirectory = join(root, "browserd");
    const browserd = new BrowserdServer({ runtimeDirectory: browserDirectory, runtime: runtime as unknown as BrowserRuntime, allowTemporaryRuntimeDirectoryForTest: true });
    await browserd.start(); cleanups.push(async () => await browserd.stop());
    const gateway = new WorkspaceGateway({ runtimeDirectory: join(root, "workspace"), browserBackend: "agentcursor", browserDescriptorPath: join(browserDirectory, "browserd.json"), browserRuntimeDirectory: browserDirectory, heartbeatMs: 100 });
    const descriptor = await gateway.start(); cleanups.push(async () => await gateway.stop());
    const client = await FramedClient.open(descriptor.socketPath); cleanups.push(async () => client.close());
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "frame.select", requestId: "request:select", selectionId: "selection_release_01", browserSessionId: "session:one", tabId: "tab:one" });
    await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:select");
    runtime.publishFrame();
    const frame = (await nextMatching(client, (header) => header.kind === "frame")).header as Record<string, unknown>;
    const binding = paintedBinding(frame, new Date().toISOString());
    client.send({ protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire", browserSessionId: "session:one", tabId: "tab:one", expectedControlEpoch: 1, frame: binding });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:acquire")).header).toMatchObject({ ok: true, result: { kind: "controlAcquired", controlEpoch: 2 } });

    runtime.controlEpoch = 2;
    runtime.publishFrame();
    const humanFrame = (await nextMatching(client, (header) => header.kind === "frame" && header.controlEpoch === 2)).header as Record<string, unknown>;
    const humanBinding = paintedBinding(humanFrame, new Date().toISOString());
    client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:down", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 1, inputTargetGeneration: 1, frame: humanBinding, events: [{ kind: "pointerDown", point: { imageX: 100, imageY: 50 }, button: "left", clickCount: 1 }] });
    expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:down")).header).toMatchObject({ ok: true, result: { kind: "inputAck", inputBatchSequence: 1 } });

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    try {
      client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:up", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 2, inputTargetGeneration: 1, frame: humanBinding, events: [{ kind: "pointerUp", point: { imageX: 100, imageY: 50 }, button: "left", clickCount: 1 }] });
      expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:up")).header).toMatchObject({ ok: true, result: { kind: "inputAck", inputBatchSequence: 2 } });
      client.send({ protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:stale-mutation", browserSessionId: "session:one", tabId: "tab:one", controlEpoch: 2, inputBatchSequence: 3, inputTargetGeneration: 1, frame: humanBinding, events: [{ kind: "pointerDown", point: { imageX: 100, imageY: 50 }, button: "left", clickCount: 1 }] });
      expect((await nextMatching(client, (header) => header.kind === "response" && header.requestId === "request:stale-mutation")).header).toMatchObject({ ok: false, error: { code: "INPUT_FRAME_STALE" } });
    } finally {
      clock.mockRestore();
    }
    expect(runtime.inputBatchCount).toBe(2);
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
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret });
    await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:rebind", bindingSecret: descriptor.bindingSecret });
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
  readonly leaseId = "raw-lease-NeverExpose-1234567890";
  controlEpoch = 1;
  acquireCount = 0;
  heartbeatCount = 0;
  releaseCount = 0;
  readonly releasedLeaseIds: string[] = [];
  inputEventCounts: Record<string, number> = {};
  inputBatchCount = 0;
  subscriptionId?: string;
  connectionId?: string;
  failReplace = false;
  cachedOnReplace = false;
  failNextSnapshot = false;
  snapshotFailures = 0;
  readonly snapshot: BrowserWorkspaceSnapshot = {
    kind: "workspaceSnapshot", workspaceRevision: 1, generatedAt: new Date().toISOString(), sessions: [{ browserSessionId: "session:one", agentSessionId: "agent:one", actorDisplayId: "actor_1234567890123456", pathId: "agentcursor/chrome", state: "ready", controlState: "agent", controlEpoch: 1, controlTransfer: "none", leaseExpiry: "none", captureReadiness: "ready", personaId: "persona_1234567890123456", cursor: { x: 10, y: 20, visible: true, pathSequence: 1, sampleSequence: 2, personaId: "persona_1234567890123456" }, tabs: [{ tabId: "tab:one", url: "http://fixture.local/", title: "Fixture <script>", state: "ready", captureReadiness: "ready", documentGeneration: 1, viewportGeneration: 1, frameSequence: 0 }] }],
  };
  workspaceSnapshot(): BrowserWorkspaceSnapshot {
    if (this.failNextSnapshot) { this.failNextSnapshot = false; this.snapshotFailures++; throw new BrowserProtocolError("CAPABILITY_UNAVAILABLE", "injected transient snapshot failure", true); }
    return this.snapshot;
  }
  workspaceSubscribeEvents(): void {}
  workspaceUnsubscribeEvents(): void {}
  shouldDeliverWorkspaceEvent(): boolean { return true; }
  workspaceSubscribeFrames(connectionId: string, subscriptionId: string): void { this.connectionId = connectionId; this.subscriptionId = subscriptionId; }
  async workspaceUnsubscribeFrames(_connectionId: string, subscriptionId: string): Promise<void> { if (this.subscriptionId === subscriptionId) { this.subscriptionId = undefined; this.connectionId = undefined; } }
  workspaceReplaceFrames(connectionId: string, _prior: unknown, next: { subscriptionId: string }): FrameEvent | undefined {
    if (this.failReplace) throw new BrowserProtocolError("TAB_NOT_FOUND", "injected replacement failure");
    this.connectionId = connectionId; this.subscriptionId = next.subscriptionId;
    return this.cachedOnReplace ? this.frame() : undefined;
  }
  workspaceFrameDeliveries(connectionId: string, frame: FrameEvent): Array<{ subscriptionId: string; frame: FrameEvent }> { return connectionId === this.connectionId && this.subscriptionId !== undefined ? [{ subscriptionId: this.subscriptionId, frame }] : []; }
  recordWorkspaceFrameDelivered(): void {}
  async workspaceAcquireControl(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.acquire" }>): Promise<unknown> {
    this.acquireCount++;
    if (request.expectedControlEpoch !== this.controlEpoch) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "injected control epoch conflict", true);
    this.controlEpoch++;
    return { kind: "workspaceControlLease", browserSessionId: "session:one", selectedTabId: "tab:one", controlState: "human", controlEpoch: this.controlEpoch, controlTransfer: "none", captureReadiness: "ready", leaseExpiry: "healthy", inputTargetGeneration: 1, leaseId: this.leaseId, leaseExpiresInMs: 8_000 };
  }
  workspaceHeartbeatControl(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.heartbeat" }>): unknown {
    if (request.leaseId !== this.leaseId) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "injected lease conflict");
    this.heartbeatCount++;
    return { kind: "workspaceControlHeartbeat", browserSessionId: "session:one", selectedTabId: "tab:one", controlState: "human", controlEpoch: this.controlEpoch, leaseExpiry: "healthy", leaseExpiresInMs: 8_000 };
  }
  async workspaceReleaseControl(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.control.release" }>): Promise<unknown> {
    if (request.leaseId !== this.leaseId) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "injected lease conflict");
    this.releaseCount++; this.releasedLeaseIds.push(request.leaseId); this.controlEpoch++;
    return this.workspaceControlStatus();
  }
  workspaceControlStatus(): unknown { return { kind: "workspaceControlStatus", browserSessionId: "session:one", controlState: this.releaseCount > 0 ? "agent" : this.controlEpoch > 1 ? "human" : "agent", controlEpoch: this.controlEpoch, controlTransfer: "none", ...(this.controlEpoch > 1 && this.releaseCount === 0 ? { selectedHumanControlTabId: "tab:one" } : {}), captureReadiness: "ready", leaseExpiry: this.controlEpoch > 1 && this.releaseCount === 0 ? "healthy" : "none" }; }
  async workspaceInputBatch(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.input.batch" }>): Promise<unknown> {
    if (request.leaseId !== this.leaseId) throw new BrowserProtocolError("CONTROL_LEASE_CONFLICT", "injected lease conflict");
    this.inputBatchCount++;
    this.inputEventCounts = {};
    for (const event of request.events) this.inputEventCounts[event.kind] = (this.inputEventCounts[event.kind] ?? 0) + 1;
    return { kind: "workspaceInputAck", inputBatchSequence: request.inputBatchSequence, acceptedEventCount: request.events.length, coalescedPointerMoveCount: 0, awaitingNewFrame: true };
  }
  async workspaceReadFrame(_connectionId: string, request: Extract<WorkspaceBrokerRequest, { kind: "workspace.frame.read" }>): Promise<unknown> {
    const offset = request.offset ?? 0; const max = request.maxBytes ?? this.frameBytes.byteLength; const chunk = this.frameBytes.slice(offset, Math.min(this.frameBytes.byteLength, offset + max));
    return { kind: "workspaceFrameArtifact", artifactId: "artifact_1234567890123456", browserSessionId: "session:one", tabId: "tab:one", subscriptionId: request.subscriptionId, frameSequence: 1, mediaType: "image/png", byteLength: chunk.byteLength, sha256: this.sha256, offset, totalBytes: this.frameBytes.byteLength, eof: offset + chunk.byteLength === this.frameBytes.byteLength, base64: Buffer.from(chunk).toString("base64") };
  }
  releaseConnection(): void { this.subscriptionId = undefined; this.connectionId = undefined; }
  async close(): Promise<void> {}
  frame(): FrameEvent { return { protocolVersion: "browser.v3", kind: "frame.available", address: { browserSessionId: "session:one", tabId: "tab:one", targetId: "target_1234567890123456", controlEpoch: this.controlEpoch }, documentGeneration: 1, viewportGeneration: 1, frameSequence: 1, capturedMonotonicMs: 100, publishedMonotonicMs: 110, mediaType: "image/png", byteLength: this.frameBytes.byteLength, artifactId: "artifact_1234567890123456", sha256: this.sha256, imagePixelWidth: 800, imagePixelHeight: 600, viewport: { width: 800, height: 600, devicePixelRatio: 1 }, url: "http://fixture.local/", title: "Fixture", cursor: { x: 10, y: 20, visible: true, pathSequence: 1, sampleSequence: 2, personaId: "persona_1234567890123456" } }; }
  publishFrame(): void { this.emit("frame", this.frame()); }
}

function paintedBinding(frame: Record<string, unknown>, paintedAt: string): Record<string, unknown> {
  return {
    selectionId: frame.selectionId, browserdRuntimeInstanceId: frame.browserdRuntimeInstanceId,
    browserSessionId: frame.browserSessionId, tabId: frame.tabId, subscriptionId: frame.subscriptionId,
    controlEpoch: frame.controlEpoch, frameSequence: frame.frameSequence,
    documentGeneration: frame.documentGeneration, viewportGeneration: frame.viewportGeneration,
    imagePixelWidth: frame.imagePixelWidth, imagePixelHeight: frame.imagePixelHeight,
    cssViewportWidth: frame.cssViewportWidth, cssViewportHeight: frame.cssViewportHeight,
    devicePixelRatio: frame.devicePixelRatio, paintedAt,
  };
}

async function bindAndSnapshot(descriptor: { socketPath: string; bindingSecret: string }): Promise<Record<string, unknown>> {
  const client = await FramedClient.open(descriptor.socketPath);
  try {
    client.send({ protocolVersion: "workspace.v2", kind: "bind", requestId: "request:bind", bindingSecret: descriptor.bindingSecret }); await client.next(); await client.next();
    client.send({ protocolVersion: "workspace.v2", kind: "snapshot.get", requestId: "request:snapshot" });
    const response = (await client.next()).header as { result: { snapshot: Record<string, unknown> } }; return response.result.snapshot;
  } finally { await client.close(); }
}
async function waitForSnapshot(
  descriptor: { socketPath: string; bindingSecret: string },
  check: (snapshot: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await bindAndSnapshot(descriptor);
    if (check(snapshot)) return snapshot;
    if (Date.now() >= deadline) throw new Error("timed out waiting for workspace snapshot");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) throw new Error("timed out waiting for condition"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
async function nextMatching(client: FramedClient, predicate: (header: Record<string, unknown>) => boolean, timeoutMs = 4_000): Promise<WorkspaceWireRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await client.next(Math.max(1, deadline - Date.now()));
    if (predicate(record.header as Record<string, unknown>)) return record;
  }
  throw new Error("timed out waiting for matching workspace record");
}
