import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { connect, type Socket } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@webx/browser-protocol";
import { BrowserRuntime, LoopbackFixtureAuthorization } from "@webx/browser-runtime";
import type { BrowserSession } from "../../../packages/browser-runtime/src/registry/session.js";
import { BrowserdServer } from "../src/server.js";

interface WireResponse { kind: "response"; requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
interface WireFrame { kind: "frame.available"; capturedMonotonicMs: number; publishedMonotonicMs: number; receivedMonotonicMs?: number; artifactId: string; address: { browserSessionId: string; tabId: string }; frameSequence: number }
interface ArtifactStat { owner: string; browserSessionId: string; purpose: "agent-observation" | "workspace-frame"; count: number; bytes: number }
interface ChromeTreeSample {
  browserSessionId: string;
  browserPid: number;
  pssKiB: number;
  privateDirtyKiB: number;
  processCount: number;
  rendererPssKiB: number;
  rendererPrivateDirtyKiB: number;
  rendererCount: number;
  profileBytes: number;
}
interface ResourceSample {
  elapsedSeconds: number;
  pssKiB: number;
  privateDirtyKiB: number;
  cpuPercent: number;
  processCount: number;
  browserdPssKiB: number;
  browserdPrivateDirtyKiB: number;
  chromeSessions: ChromeTreeSample[];
  browserdHeapUsedBytes: number;
  eventLoopMeanMs: number;
  eventLoopMaxMs: number;
  profileBytes: number;
  artifactCount: number;
  artifactBytes: number;
  operationCount: number;
  subscriptionCount: number;
  heldButtonCount: number;
  heldKeyCount: number;
  profileCount: number;
  runtimeRootCount: number;
  targetCount: number;
  artifactStats: ArtifactStat[];
  droppedFrames: number;
  receivedFrames: number;
}

class BrowserClient {
  private sequence = 0;
  private readonly clientId = randomBytes(6).toString("hex");
  private buffer = "";
  private readonly pending = new Map<string, (value: WireResponse) => void>();
  readonly frames: WireFrame[] = [];

  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line) as WireResponse | WireFrame | { kind: "bound"; requestId: string };
        if (message.kind === "frame.available") this.frames.push({ ...message, receivedMonotonicMs: performance.now() });
        else if (message.kind === "response") this.pending.get(message.requestId)?.(message);
        else this.pending.get(message.requestId)?.({ kind: "response", requestId: message.requestId, ok: true, result: message });
      }
    });
  }

  static async open(socketPath: string, secret: string, actor: { principalId: string; agentSessionId: string }): Promise<BrowserClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolvePromise, reject) => { socket.once("connect", resolvePromise); socket.once("error", reject); });
    const client = new BrowserClient(socket);
    await client.raw({ protocolVersion: PROTOCOL_VERSION, kind: "bind", requestId: `bind:${randomBytes(6).toString("hex")}`, bindingSecret: secret, actor }, 10_000);
    return client;
  }

  async call(kind: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    return await this.callOperation(kind, `operation:${this.clientId}:${kind.replaceAll(".", ":")}:${++this.sequence}`, payload, timeoutMs);
  }

  async callOperation(kind: string, operationId: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const suffix = `${kind.replaceAll(".", ":")}:${++this.sequence}`;
    const response = await this.raw({ protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${suffix}`, operationId, deadline: new Date(Date.now() + Math.min(timeoutMs, 5 * 60_000)).toISOString(), ...payload }, timeoutMs);
    if (!response.ok) throw new Error(`${response.error?.code ?? "ERROR"}: ${response.error?.message ?? "request failed"}`);
    return response.result;
  }

  close(): void { this.socket.destroy(); }

  private async raw(message: Record<string, unknown>, timeoutMs: number): Promise<WireResponse> {
    const requestId = String(message.requestId);
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<WireResponse>((resolvePromise, reject) => {
      this.pending.set(requestId, resolvePromise);
      timer = setTimeout(() => reject(new Error(`Timeout for ${requestId}`)), timeoutMs);
    });
    this.socket.write(`${JSON.stringify(message)}\n`);
    try { return await response; }
    finally { if (timer !== undefined) clearTimeout(timer); this.pending.delete(requestId); }
  }
}

const page = (label: string): string => `<!doctype html><html><head><title>${label}</title><style>body{margin:0;height:1800px;background:#eef;font:20px sans-serif}button,input{position:absolute;left:80px;width:240px;height:52px;font-size:18px}button{top:110px}input{top:190px}</style></head><body><h1>${label}</h1><button>${label} count 0</button><input aria-label="${label} text"><script>let n=0;document.querySelector('button').onclick=e=>e.target.textContent='${label} count '+(++n)</script></body></html>`;

let browserd: BrowserdServer | undefined;
let fixture: HttpServer | undefined;
let root: string | undefined;

async function main(): Promise<void> {
  const durationSeconds = numberArgument("--duration-seconds", 1_800, 60, 86_400);
  const sampleSeconds = numberArgument("--sample-seconds", 15, 5, 300);
  const outputPath = resolve(argument("--output") ?? "../../docs/browser-rebuild/evidence/phase1-soak-results.json");
  const chromeExecutable = process.env.BROWSERD_CHROME_BIN ?? "/usr/bin/chromium-browser";

  fixture = createHttpServer((request, response) => {
    const label = request.url?.includes("beta") ? "beta" : request.url?.includes("second") ? "alpha-second" : "alpha";
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(page(label));
  });
  await new Promise<void>((resolvePromise) => fixture?.listen(0, "127.0.0.1", resolvePromise));
  const fixtureAddress = fixture.address();
  if (fixtureAddress === null || typeof fixtureAddress === "string") throw new Error("Fixture did not bind.");
  const origin = `http://127.0.0.1:${fixtureAddress.port}`;

  root = await mkdtemp(join(tmpdir(), "browserd-soak-"));
  const profileRoot = join(root, "profiles");
  const runtime = new BrowserRuntime({
    navigationAuthorization: new LoopbackFixtureAuthorization(new Set([origin])),
    chrome: { executable: chromeExecutable, profileRoot },
    personaSeedForTest: 987_654,
    motorMinimumPathMsForTest: 700,
    observationFreshnessMsForTest: 60_000,
  });
  browserd = new BrowserdServer({ runtimeDirectory: join(root, "transport"), runtime });
  const startupStarted = performance.now();
  await browserd.start();
  const browserdSocketPath = browserd.descriptor.socketPath;
  const actorA = { principalId: "soak:owner-a", agentSessionId: "soak:agent-a" };
  const actorB = { principalId: "soak:owner-b", agentSessionId: "soak:agent-b" };
  const clientA = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);
  const clientB = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorB);
  const [sessionAUnknown, sessionBUnknown] = await Promise.all([
    clientA.call("session.create", { initialUrl: `${origin}/alpha` }),
    clientB.call("session.create", { initialUrl: `${origin}/beta` }),
  ]);
  const startupMs = performance.now() - startupStarted;
  const sessionA = asRecord(sessionAUnknown);
  const sessionB = asRecord(sessionBUnknown);
  const sessionAId = stringField(sessionA, "browserSessionId");
  const sessionBId = stringField(sessionB, "browserSessionId");
  const epochA = numberField(sessionA, "controlEpoch");
  const epochB = numberField(sessionB, "controlEpoch");
  let tabA1 = firstTabAddress(sessionA);
  const tabB1 = firstTabAddress(sessionB);
  const tabA2Result = asRecord(await clientA.call("tab.create", { browserSessionId: sessionAId, controlEpoch: epochA, url: `${origin}/second` }));
  let tabA2 = asRecord(tabA2Result.address);
  assert.notEqual(sessionAId, sessionBId);
  assert.equal(numberField(tabB1, "controlEpoch"), epochB);

  let subscriptionA1 = "subscription_soak_a1";
  let subscriptionA2 = "subscription_soak_a2";
  await Promise.all([
    clientA.call("frames.subscribe", { address: tabA1, subscriptionId: subscriptionA1, interest: "idle" }),
    clientA.call("frames.subscribe", { address: tabA2, subscriptionId: subscriptionA2, interest: "idle" }),
    clientB.call("frames.subscribe", { address: tabB1, subscriptionId: "subscription_soak_b1", interest: "idle" }),
  ]);

  const internalA = privateSession(runtime, actorA, sessionAId);
  const internalB = privateSession(runtime, actorB, sessionBId);
  const roots = [process.pid, internalA.host.pid, internalB.host.pid];
  const clkTck = await clockTicksPerSecond();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const samples: ResourceSample[] = [];
  const screenshotLatenciesMs: number[] = [];
  const domLatenciesMs: number[] = [];
  const pathLatenciesMs: number[] = [];
  const cdpRoundTripsMs: number[] = [];
  const framePublicationLatenciesMs: number[] = [];
  const frameDeliveryLatenciesMs: number[] = [];
  const soakStarted = performance.now();
  let priorCpu = await processTreeCpu(roots);
  let priorCpuAt = performance.now();
  let iteration = 0;
  let nextSampleAt = soakStarted;
  let nextIterationAt = soakStarted;
  let subscriberReconnects = 0;
  let duplicateSubscribeCalls = 0;
  let epochInvalidations = 0;
  let operationRetryCalls = 0;
  let artifactReadCalls = 0;
  let tabsCreatedAndClosed = 0;
  const soakEndsAt = soakStarted + durationSeconds * 1_000;
  const epochCadence = durationSeconds < 300 ? 6 : 30;

  while (performance.now() < soakEndsAt) {
    iteration++;
    const observations = await Promise.all([
      timedCall(clientA, "observe.screenshot", { address: tabA1, delivery: "artifact" }, screenshotLatenciesMs),
      timedCall(clientA, "observe.screenshot", { address: tabA2, delivery: "artifact" }, screenshotLatenciesMs),
      timedCall(clientB, "observe.screenshot", { address: tabB1, delivery: "artifact" }, screenshotLatenciesMs),
    ]);

    if (iteration % 2 === 0) {
      await Promise.all([
        timedCall(clientA, "observe.domFallback", { address: tabA1, maxNodes: 50 }, domLatenciesMs),
        timedCall(clientB, "observe.domFallback", { address: tabB1, maxNodes: 50 }, domLatenciesMs),
      ]);
      const x = iteration % 4 === 0 ? 620 : 360;
      const y = iteration % 4 === 0 ? 390 : 300;
      await Promise.all([
        timedCall(clientA, "action.coordinate", { address: iteration % 4 === 0 ? tabA2 : tabA1, observationId: stringField(asRecord(iteration % 4 === 0 ? observations[1] : observations[0]), "observationId"), action: { kind: "move", to: { x, y } } }, pathLatenciesMs),
        timedCall(clientB, "action.coordinate", { address: tabB1, observationId: stringField(asRecord(observations[2]), "observationId"), action: { kind: "move", to: { x: 760 - x, y: 540 - y / 2 } } }, pathLatenciesMs),
      ]);
    }

    const artifactObservation = asRecord(iteration % 2 === 0 ? observations[0] : observations[2]);
    await (iteration % 2 === 0 ? clientA : clientB).call("artifact.read", { artifactId: observationArtifactId(artifactObservation), offset: 0, maxBytes: 65_536 });
    artifactReadCalls++;

    if (iteration % 8 === 0) {
      const transient = await BrowserClient.open(browserd.descriptor.socketPath, browserd.descriptor.bindingSecret, actorA);
      const subscriptionId = `subscription_reconnect_${iteration}`;
      const payload = { address: tabA1, subscriptionId, interest: "idle" };
      await transient.call("frames.subscribe", payload);
      await transient.call("frames.subscribe", payload);
      duplicateSubscribeCalls++;
      assert.equal(runtime.subscriptionCount, 4);
      transient.close();
      await waitFor(() => runtime.subscriptionCount === 3);
      subscriberReconnects++;
    }

    if (iteration % 10 === 0) {
      await clientA.call("action.coordinate", { address: tabA1, observationId: stringField(asRecord(observations[0]), "observationId"), action: { kind: "click", at: { x: 150, y: 215 }, button: "left" } });
      await clientA.call("input.text", { address: tabA1, text: `iteration-${iteration}`, replace: true });
      await clientA.call("input.key", { address: tabA1, key: "Enter" });
    }

    if (iteration % 12 === 0) {
      const operationId = `operation:soak-retry:${iteration}`;
      const payload = { address: tabA1 };
      await clientA.callOperation("tab.focus", operationId, payload);
      await clientA.callOperation("tab.focus", operationId, payload);
      operationRetryCalls++;
    }

    if (iteration % 15 === 0) {
      const currentEpoch = numberField(tabA1, "controlEpoch");
      const created = asRecord(await clientA.call("tab.create", { browserSessionId: sessionAId, controlEpoch: currentEpoch, url: `${origin}/alpha?churn=${iteration}` }));
      const churnAddress = asRecord(created.address);
      await clientA.call("tab.close", { address: churnAddress });
      tabsCreatedAndClosed++;
    }

    if (iteration % epochCadence === 0) {
      const currentEpoch = runtime.incrementControlEpochForTest(actorA, sessionAId);
      tabA1 = { ...tabA1, controlEpoch: currentEpoch };
      tabA2 = { ...tabA2, controlEpoch: currentEpoch };
      assert.equal(runtime.subscriptionCount, 1);
      subscriptionA1 = `subscription_soak_a1_epoch_${currentEpoch}`;
      subscriptionA2 = `subscription_soak_a2_epoch_${currentEpoch}`;
      await Promise.all([
        clientA.call("frames.subscribe", { address: tabA1, subscriptionId: subscriptionA1, interest: "idle" }),
        clientA.call("frames.subscribe", { address: tabA2, subscriptionId: subscriptionA2, interest: "idle" }),
      ]);
      epochInvalidations++;
    }

    const cdpStarted = performance.now();
    await internalA.host.cdp.send("Browser.getVersion", {});
    cdpRoundTripsMs.push(performance.now() - cdpStarted);

    const now = performance.now();
    if (now >= nextSampleAt) {
      const [memory, browserdMemory, chromeA, chromeB, profileABytes, profileBBytes, runtimeRootCount] = await Promise.all([
        processTreeMemory(roots), processMemory(process.pid), processTreeBreakdown(internalA.host.pid), processTreeBreakdown(internalB.host.pid),
        directoryBytes(internalA.host.profileDirectory), directoryBytes(internalB.host.profileDirectory), profileRuntimeRoots(profileRoot).then((values) => values.length),
      ]);
      const currentCpu = await processTreeCpu(roots);
      const cpuAt = performance.now();
      const cpuPercent = ((currentCpu.ticks - priorCpu.ticks) / clkTck) / ((cpuAt - priorCpuAt) / 1_000) * 100;
      priorCpu = currentCpu;
      priorCpuAt = cpuAt;
      const newFrames = [...clientA.frames, ...clientB.frames];
      for (const frame of newFrames) {
        framePublicationLatenciesMs.push(frame.publishedMonotonicMs - frame.capturedMonotonicMs);
        frameDeliveryLatenciesMs.push(Math.max(0, (frame.receivedMonotonicMs ?? frame.publishedMonotonicMs) - frame.publishedMonotonicMs));
      }
      const actorAFrame = clientA.frames.at(-1);
      const actorBFrame = clientB.frames.at(-1);
      if (actorAFrame !== undefined) { await clientA.call("artifact.read", { artifactId: actorAFrame.artifactId, offset: 0, maxBytes: 65_536 }); artifactReadCalls++; }
      if (actorBFrame !== undefined) { await clientB.call("artifact.read", { artifactId: actorBFrame.artifactId, offset: 0, maxBytes: 65_536 }); artifactReadCalls++; }
      clientA.frames.length = 0;
      clientB.frames.length = 0;
      const artifactStats = runtime.artifacts.stats();
      samples.push({
        elapsedSeconds: (cpuAt - soakStarted) / 1_000,
        pssKiB: memory.pssKiB,
        privateDirtyKiB: memory.privateDirtyKiB,
        cpuPercent,
        processCount: memory.processCount,
        browserdPssKiB: browserdMemory.pssKiB,
        browserdPrivateDirtyKiB: browserdMemory.privateDirtyKiB,
        chromeSessions: [
          { browserSessionId: sessionAId, browserPid: internalA.host.pid, ...chromeA, profileBytes: profileABytes },
          { browserSessionId: sessionBId, browserPid: internalB.host.pid, ...chromeB, profileBytes: profileBBytes },
        ],
        browserdHeapUsedBytes: process.memoryUsage().heapUsed,
        eventLoopMeanMs: Number.isFinite(lag.mean) ? lag.mean / 1_000_000 : 0,
        eventLoopMaxMs: lag.max / 1_000_000,
        profileBytes: await directoryBytes(profileRoot),
        artifactCount: runtime.artifacts.entryCount,
        artifactBytes: runtime.artifacts.totalBytes,
        operationCount: runtime.operations.size,
        subscriptionCount: runtime.subscriptionCount,
        heldButtonCount: internalA.motor.heldInputState.buttons.length + internalB.motor.heldInputState.buttons.length,
        heldKeyCount: internalA.motor.heldInputState.keys.length + internalB.motor.heldInputState.keys.length,
        profileCount: (await profileDirectories(profileRoot)).length,
        runtimeRootCount,
        targetCount: countOpenTargets(internalA) + countOpenTargets(internalB),
        artifactStats,
        droppedFrames: internalA.frames.droppedFrames + internalB.frames.droppedFrames,
        receivedFrames: newFrames.length,
      });
      lag.reset();
      nextSampleAt += sampleSeconds * 1_000;
    }

    nextIterationAt += 15_000;
    const delay = Math.min(Math.max(0, nextIterationAt - performance.now()), Math.max(0, soakEndsAt - performance.now()));
    if (delay > 0) await sleep(delay);
  }

  lag.disable();
  const actualDurationSeconds = (performance.now() - soakStarted) / 1_000;
  assert.ok(actualDurationSeconds >= durationSeconds, `Soak ended early at ${actualDurationSeconds}s.`);
  assert.ok(samples.length >= Math.floor(durationSeconds / sampleSeconds) - 1, "Too few resource samples.");
  assert.ok(runtime.artifacts.entryCount <= 256, "Artifact registry exceeded its configured entry bound.");
  assert.ok(runtime.operations.size <= 2_048, "Operation registry exceeded its configured entry bound.");
  assert.ok(samples.every((sample) => sample.subscriptionCount === 3), "Frame subscription count did not return to its steady bound.");
  assert.ok(samples.every((sample) => sample.heldButtonCount === 0 && sample.heldKeyCount === 0), "Held input leaked between soak iterations.");
  assert.ok(samples.every((sample) => sample.profileCount === 2), "Profile count changed while both sessions were live.");
  assert.ok(samples.every((sample) => sample.runtimeRootCount === 1), "Profile-manager runtime-root count changed while the service was live.");
  assert.ok(samples.every((sample) => sample.targetCount === 3), "Open target count changed outside bounded tab churn.");

  await Promise.all([
    clientA.call("frames.unsubscribe", { address: tabA1, subscriptionId: subscriptionA1 }),
    clientA.call("frames.unsubscribe", { address: tabA2, subscriptionId: subscriptionA2 }),
    clientB.call("frames.unsubscribe", { address: tabB1, subscriptionId: "subscription_soak_b1" }),
  ]);
  assert.equal(runtime.subscriptionCount, 0, "Frame subscriptions remained after explicit unsubscribe.");
  clientA.close();
  clientB.close();
  const browserPids = [internalA.host.pid, internalB.host.pid];
  await browserd.stop();
  browserd = undefined;
  await new Promise<void>((resolvePromise) => fixture?.close(() => resolvePromise()));
  fixture = undefined;
  const remainingProfileEntries = await profileDirectories(profileRoot);
  const remainingRuntimeRoots = await profileRuntimeRoots(profileRoot);
  assert.equal(remainingProfileEntries.length, 0, "A temporary browser profile leaked.");
  assert.equal(remainingRuntimeRoots.length, 0, "A profile-manager runtime root leaked.");
  assert.equal(runtime.artifacts.entryCount, 0, "Artifacts remained after browserd shutdown.");
  assert.equal(runtime.operations.size, 0, "Operations remained after browserd shutdown.");
  assert.equal(runtime.subscriptionCount, 0, "Subscriptions remained after browserd shutdown.");
  assert.deepEqual(internalA.motor.heldInputState, { buttons: [], keys: [] });
  assert.deepEqual(internalB.motor.heldInputState, { buttons: [], keys: [] });
  assert.ok(browserPids.every((pid) => !processIsAlive(pid)), "A Chromium process remained after browserd shutdown.");

  const result = {
    passed: true,
    requestedDurationSeconds: durationSeconds,
    actualDurationSeconds,
    sampleIntervalSeconds: sampleSeconds,
    sampleCount: samples.length,
    chromium: await executableOutput(chromeExecutable, ["--version"]),
    startupMs,
    sessionCount: 2,
    tabCount: 3,
    idleFrameSubscriptions: 3,
    subscriberReconnects,
    duplicateSubscribeCalls,
    epochInvalidations,
    operationRetryCalls,
    artifactReadCalls,
    tabsCreatedAndClosed,
    screenshotLatencyMs: distribution(screenshotLatenciesMs),
    domFallbackLatencyMs: distribution(domLatenciesMs),
    pathWallLatencyMs: distribution(pathLatenciesMs),
    cdpRoundTripMs: distribution(cdpRoundTripsMs),
    framePublicationLatencyMs: distribution(framePublicationLatenciesMs),
    frameDeliveryLatencyMs: distribution(frameDeliveryLatenciesMs),
    pssKiB: range(samples.map((sample) => sample.pssKiB)),
    privateDirtyKiB: range(samples.map((sample) => sample.privateDirtyKiB)),
    cpuPercent: distribution(samples.slice(1).map((sample) => sample.cpuPercent)),
    eventLoopMeanMs: distribution(samples.map((sample) => sample.eventLoopMeanMs)),
    eventLoopMaxMs: range(samples.map((sample) => sample.eventLoopMaxMs)),
    browserdHeapUsedBytes: range(samples.map((sample) => sample.browserdHeapUsedBytes)),
    browserdPssKiB: range(samples.map((sample) => sample.browserdPssKiB)),
    browserdPrivateDirtyKiB: range(samples.map((sample) => sample.browserdPrivateDirtyKiB)),
    chromeSessions: [
      { browserSessionId: sessionAId, pssKiB: range(chromeValues(samples, 0, "pssKiB")), privateDirtyKiB: range(chromeValues(samples, 0, "privateDirtyKiB")), rendererPssKiB: range(chromeValues(samples, 0, "rendererPssKiB")), rendererPrivateDirtyKiB: range(chromeValues(samples, 0, "rendererPrivateDirtyKiB")), rendererCount: range(chromeValues(samples, 0, "rendererCount")), processCount: range(chromeValues(samples, 0, "processCount")), profileBytes: range(chromeValues(samples, 0, "profileBytes")) },
      { browserSessionId: sessionBId, pssKiB: range(chromeValues(samples, 1, "pssKiB")), privateDirtyKiB: range(chromeValues(samples, 1, "privateDirtyKiB")), rendererPssKiB: range(chromeValues(samples, 1, "rendererPssKiB")), rendererPrivateDirtyKiB: range(chromeValues(samples, 1, "rendererPrivateDirtyKiB")), rendererCount: range(chromeValues(samples, 1, "rendererCount")), processCount: range(chromeValues(samples, 1, "processCount")), profileBytes: range(chromeValues(samples, 1, "profileBytes")) },
    ],
    profileBytes: range(samples.map((sample) => sample.profileBytes)),
    processCount: range(samples.map((sample) => sample.processCount)),
    artifactCount: range(samples.map((sample) => sample.artifactCount)),
    artifactBytes: range(samples.map((sample) => sample.artifactBytes)),
    operationCount: range(samples.map((sample) => sample.operationCount)),
    subscriptionCount: range(samples.map((sample) => sample.subscriptionCount)),
    heldButtonCount: range(samples.map((sample) => sample.heldButtonCount)),
    heldKeyCount: range(samples.map((sample) => sample.heldKeyCount)),
    targetCount: range(samples.map((sample) => sample.targetCount)),
    runtimeRootCount: range(samples.map((sample) => sample.runtimeRootCount)),
    artifactStatsByActorSessionPurpose: latestArtifactStats(samples),
    droppedFrames: range(samples.map((sample) => sample.droppedFrames)),
    receivedFrameCount: framePublicationLatenciesMs.length,
    slopesPerHour: resourceTrend(samples),
    trendWindowsPerHour: {
      fullRun: resourceTrend(samples),
      finalHour: resourceTrend(finalWindow(samples, 3_600)),
      final30Minutes: resourceTrend(finalWindow(samples, 1_800)),
    },
    lifecycleEvents: { tabCycles: tabsCreatedAndClosed, epochInvalidations, explicitGcObservable: false },
    cleanup: { profilesRemaining: remainingProfileEntries.length, runtimeRootsRemaining: remainingRuntimeRoots.length, artifactsRemaining: runtime.artifacts.entryCount, operationsRemaining: runtime.operations.size, subscriptionsRemaining: runtime.subscriptionCount, heldButtonsRemaining: internalA.motor.heldInputState.buttons.length + internalB.motor.heldInputState.buttons.length, heldKeysRemaining: internalA.motor.heldInputState.keys.length + internalB.motor.heldInputState.keys.length, browserProcessesRemaining: browserPids.filter(processIsAlive).length, descriptorRemoved: !(await exists(join(root, "transport", "browserd.json"))), socketRemoved: !(await exists(browserdSocketPath)) },
    samples,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  await rm(root, { recursive: true, force: true });
  root = undefined;
}

function privateSession(runtime: BrowserRuntime, actor: { principalId: string; agentSessionId: string }, id: string): BrowserSession {
  return (runtime as unknown as { getSession(boundActor: typeof actor, browserSessionId: string): BrowserSession }).getSession(actor, id);
}
async function timedCall(client: BrowserClient, kind: string, payload: Record<string, unknown>, samples: number[]): Promise<unknown> { const started = performance.now(); const result = await client.call(kind, payload); samples.push(performance.now() - started); return result; }
function argument(name: string): string | undefined { const prefix = `${name}=`; return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length); }
function numberArgument(name: string, fallback: number, minimum: number, maximum: number): number { const raw = argument(name); const value = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be from ${minimum} through ${maximum}.`); return value; }
function asRecord(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object result."); return value as Record<string, unknown>; }
function stringField(value: Record<string, unknown>, key: string): string { const field = value[key]; if (typeof field !== "string") throw new Error(`Expected string field ${key}.`); return field; }
function numberField(value: Record<string, unknown>, key: string): number { const field = value[key]; if (typeof field !== "number") throw new Error(`Expected numeric field ${key}.`); return field; }
function firstTabAddress(session: Record<string, unknown>): Record<string, unknown> { const tabs = session.tabs; if (!Array.isArray(tabs) || tabs.length === 0) throw new Error("Session has no tab."); return asRecord(asRecord(tabs[0]).address); }
function observationArtifactId(observation: Record<string, unknown>): string { return stringField(asRecord(observation.image), "artifactId"); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> { const deadline = performance.now() + timeoutMs; while (performance.now() < deadline) { if (predicate()) return; await sleep(10); } throw new Error("Timed out waiting for soak cleanup."); }
function countOpenTargets(session: BrowserSession): number { return session.listTabs().filter((tab) => tab.state === "ready" || tab.state === "attaching").length; }
function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function executableOutput(file: string, args: string[]): Promise<string> { return await new Promise((resolvePromise, reject) => execFile(file, args, (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim()))); }
async function clockTicksPerSecond(): Promise<number> { return Number(await executableOutput("/usr/bin/getconf", ["CLK_TCK"])); }
async function exists(path: string): Promise<boolean> { return await stat(path).then(() => true, () => false); }
async function directoryBytes(path: string): Promise<number> { let total = 0; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const child = join(path, entry.name); if (entry.isDirectory()) total += await directoryBytes(child); else if (entry.isFile()) total += (await stat(child)).size; } return total; }
async function profileDirectories(path: string): Promise<string[]> { const values: string[] = []; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const child = join(path, entry.name); if (!entry.isDirectory()) continue; if (entry.name.startsWith("session-")) values.push(child); else values.push(...await profileDirectories(child)); } return values; }
async function profileRuntimeRoots(path: string): Promise<string[]> { const values: string[] = []; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { if (!entry.isDirectory()) continue; const child = join(path, entry.name); if (entry.name.startsWith("runtime_")) values.push(child); else values.push(...await profileRuntimeRoots(child)); } return values; }
async function processTree(roots: number[]): Promise<Set<number>> { const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); const parents = new Map<number, number>(); for (const entry of entries) { const text = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => ""); const end = text.lastIndexOf(")"); if (end > 0) parents.set(Number(entry), Number(text.slice(end + 2).split(" ")[1])); } const tree = new Set(roots); let changed = true; while (changed) { changed = false; for (const [pid, ppid] of parents) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); changed = true; } } return tree; }
async function processMemory(pid: number): Promise<{ pssKiB: number; privateDirtyKiB: number }> { const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => ""); return { pssKiB: Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0), privateDirtyKiB: Number(rollup.match(/^Private_Dirty:\s+(\d+)/m)?.[1] ?? 0) }; }
async function processTreeMemory(roots: number[]): Promise<{ pssKiB: number; privateDirtyKiB: number; processCount: number }> { const tree = await processTree(roots); let pssKiB = 0, privateDirtyKiB = 0, processCount = 0; for (const pid of tree) { const memory = await processMemory(pid); if (memory.pssKiB === 0 && memory.privateDirtyKiB === 0) continue; processCount++; pssKiB += memory.pssKiB; privateDirtyKiB += memory.privateDirtyKiB; } return { pssKiB, privateDirtyKiB, processCount }; }
async function processTreeBreakdown(rootPid: number): Promise<Omit<ChromeTreeSample, "browserSessionId" | "browserPid" | "profileBytes">> { let pssKiB = 0, privateDirtyKiB = 0, processCount = 0, rendererPssKiB = 0, rendererPrivateDirtyKiB = 0, rendererCount = 0; for (const pid of await processTree([rootPid])) { const memory = await processMemory(pid); if (memory.pssKiB === 0 && memory.privateDirtyKiB === 0) continue; processCount++; pssKiB += memory.pssKiB; privateDirtyKiB += memory.privateDirtyKiB; const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""); if (command.includes("--type=renderer")) { rendererCount++; rendererPssKiB += memory.pssKiB; rendererPrivateDirtyKiB += memory.privateDirtyKiB; } } return { pssKiB, privateDirtyKiB, processCount, rendererPssKiB, rendererPrivateDirtyKiB, rendererCount }; }
async function processTreeCpu(roots: number[]): Promise<{ ticks: number }> { let ticks = 0; for (const pid of await processTree(roots)) { const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""); const end = text.lastIndexOf(")"); if (end <= 0) continue; const fields = text.slice(end + 2).split(" "); ticks += Number(fields[11] ?? 0) + Number(fields[12] ?? 0); } return { ticks }; }
function distribution(values: number[]): { count: number; min: number; median: number; p95: number; max: number; mean: number } { if (values.length === 0) return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }; const sorted = [...values].sort((a, b) => a - b); const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0; return { count: values.length, min: sorted[0] ?? 0, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, mean: values.reduce((sum, value) => sum + value, 0) / values.length }; }
function range(values: number[]): { start: number; end: number; min: number; max: number } { if (values.length === 0) return { start: 0, end: 0, min: 0, max: 0 }; return { start: values[0] ?? 0, end: values.at(-1) ?? 0, min: Math.min(...values), max: Math.max(...values) }; }
function chromeValues(samples: ResourceSample[], index: number, key: keyof ChromeTreeSample): number[] { return samples.map((sample) => { const value = sample.chromeSessions[index]?.[key]; return typeof value === "number" ? value : 0; }); }
function finalWindow(samples: ResourceSample[], seconds: number): ResourceSample[] { const end = samples.at(-1)?.elapsedSeconds ?? 0; return samples.filter((sample) => sample.elapsedSeconds >= end - seconds); }
function resourceTrend(samples: ResourceSample[]) {
  const trend = (values: number[]): number => slopePerHour(samples.map((sample, index) => [sample.elapsedSeconds, values[index] ?? 0]));
  return {
    pssKiB: trend(samples.map((sample) => sample.pssKiB)),
    privateDirtyKiB: trend(samples.map((sample) => sample.privateDirtyKiB)),
    browserdPssKiB: trend(samples.map((sample) => sample.browserdPssKiB)),
    browserdPrivateDirtyKiB: trend(samples.map((sample) => sample.browserdPrivateDirtyKiB)),
    browserdHeapBytes: trend(samples.map((sample) => sample.browserdHeapUsedBytes)),
    chromeSessionAPssKiB: trend(chromeValues(samples, 0, "pssKiB")),
    chromeSessionBPssKiB: trend(chromeValues(samples, 1, "pssKiB")),
    rendererAPssKiB: trend(chromeValues(samples, 0, "rendererPssKiB")),
    rendererBPssKiB: trend(chromeValues(samples, 1, "rendererPssKiB")),
    profileBytes: trend(samples.map((sample) => sample.profileBytes)),
    artifactBytes: trend(samples.map((sample) => sample.artifactBytes)),
    operationCount: trend(samples.map((sample) => sample.operationCount)),
  };
}
function slopePerHour(points: [number, number][]): number { if (points.length < 2) return 0; const xMean = points.reduce((sum, [x]) => sum + x, 0) / points.length; const yMean = points.reduce((sum, [, y]) => sum + y, 0) / points.length; let numerator = 0, denominator = 0; for (const [x, y] of points) { numerator += (x - xMean) * (y - yMean); denominator += (x - xMean) ** 2; } return denominator === 0 ? 0 : numerator / denominator * 3_600; }
function latestArtifactStats(samples: ResourceSample[]): ArtifactStat[] { return samples.at(-1)?.artifactStats ?? []; }

try { await main(); }
catch (error) {
  console.error(error);
  await browserd?.stop().catch(() => undefined);
  await new Promise<void>((resolvePromise) => fixture?.close(() => resolvePromise()) ?? resolvePromise());
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  process.exitCode = 1;
}
