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
interface WireFrame { kind: "frame.available"; capturedMonotonicMs: number; publishedMonotonicMs: number; receivedMonotonicMs?: number; address: { browserSessionId: string; tabId: string }; frameSequence: number }
interface ResourceSample {
  elapsedSeconds: number;
  pssKiB: number;
  privateDirtyKiB: number;
  cpuPercent: number;
  processCount: number;
  browserdHeapUsedBytes: number;
  eventLoopMeanMs: number;
  eventLoopMaxMs: number;
  profileBytes: number;
  artifactCount: number;
  artifactBytes: number;
  operationCount: number;
  droppedFrames: number;
  receivedFrames: number;
}

class BrowserClient {
  private sequence = 0;
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
    const suffix = `${kind.replaceAll(".", ":")}:${++this.sequence}`;
    const response = await this.raw({ protocolVersion: PROTOCOL_VERSION, kind, requestId: `request:${suffix}`, operationId: `operation:${suffix}`, deadline: new Date(Date.now() + Math.min(timeoutMs, 5 * 60_000)).toISOString(), ...payload }, timeoutMs);
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
  const tabA1 = firstTabAddress(sessionA);
  const tabB1 = firstTabAddress(sessionB);
  const tabA2Result = asRecord(await clientA.call("tab.create", { browserSessionId: sessionAId, controlEpoch: epochA, url: `${origin}/second` }));
  const tabA2 = asRecord(tabA2Result.address);
  assert.notEqual(sessionAId, sessionBId);
  assert.equal(numberField(tabB1, "controlEpoch"), epochB);

  await Promise.all([
    clientA.call("frames.subscribe", { address: tabA1, interest: "idle" }),
    clientA.call("frames.subscribe", { address: tabA2, interest: "idle" }),
    clientB.call("frames.subscribe", { address: tabB1, interest: "idle" }),
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
  const soakEndsAt = soakStarted + durationSeconds * 1_000;

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

    const cdpStarted = performance.now();
    await internalA.host.cdp.send("Browser.getVersion", {});
    cdpRoundTripsMs.push(performance.now() - cdpStarted);

    const now = performance.now();
    if (now >= nextSampleAt) {
      const memory = await processTreeMemory(roots);
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
      clientA.frames.length = 0;
      clientB.frames.length = 0;
      samples.push({
        elapsedSeconds: (cpuAt - soakStarted) / 1_000,
        pssKiB: memory.pssKiB,
        privateDirtyKiB: memory.privateDirtyKiB,
        cpuPercent,
        processCount: memory.processCount,
        browserdHeapUsedBytes: process.memoryUsage().heapUsed,
        eventLoopMeanMs: Number.isFinite(lag.mean) ? lag.mean / 1_000_000 : 0,
        eventLoopMaxMs: lag.max / 1_000_000,
        profileBytes: await directoryBytes(profileRoot),
        artifactCount: runtime.artifacts.entryCount,
        artifactBytes: runtime.artifacts.totalBytes,
        operationCount: runtime.operations.size,
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
  assert.ok(runtime.artifacts.entryCount <= 128, "Artifact registry exceeded its configured entry bound.");
  assert.ok(runtime.operations.size <= 2_048, "Operation registry exceeded its configured entry bound.");

  await Promise.all([
    clientA.call("frames.unsubscribe", { address: tabA1 }),
    clientA.call("frames.unsubscribe", { address: tabA2 }),
    clientB.call("frames.unsubscribe", { address: tabB1 }),
  ]);
  clientA.close();
  clientB.close();
  await browserd.stop();
  browserd = undefined;
  await new Promise<void>((resolvePromise) => fixture?.close(() => resolvePromise()));
  fixture = undefined;
  const remainingProfileEntries = (await readdir(profileRoot).catch(() => [])).filter((name) => name.startsWith("session-"));
  assert.equal(remainingProfileEntries.length, 0, "A temporary browser profile leaked.");
  assert.equal(runtime.artifacts.entryCount, 0, "Artifacts remained after browserd shutdown.");
  assert.equal(runtime.operations.size, 0, "Operations remained after browserd shutdown.");

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
    profileBytes: range(samples.map((sample) => sample.profileBytes)),
    processCount: range(samples.map((sample) => sample.processCount)),
    artifactCount: range(samples.map((sample) => sample.artifactCount)),
    artifactBytes: range(samples.map((sample) => sample.artifactBytes)),
    operationCount: range(samples.map((sample) => sample.operationCount)),
    droppedFrames: range(samples.map((sample) => sample.droppedFrames)),
    receivedFrameCount: framePublicationLatenciesMs.length,
    slopesPerHour: {
      pssKiB: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.pssKiB])),
      privateDirtyKiB: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.privateDirtyKiB])),
      browserdHeapBytes: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.browserdHeapUsedBytes])),
      profileBytes: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.profileBytes])),
      artifactBytes: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.artifactBytes])),
      operationCount: slopePerHour(samples.map((sample) => [sample.elapsedSeconds, sample.operationCount])),
    },
    cleanup: { profilesRemaining: remainingProfileEntries.length, artifactsRemaining: runtime.artifacts.entryCount, operationsRemaining: runtime.operations.size, descriptorRemoved: !(await exists(join(root, "transport", "browserd.json"))), socketRemoved: !(await exists(join(root, "transport", "browserd.sock"))) },
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
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
async function executableOutput(file: string, args: string[]): Promise<string> { return await new Promise((resolvePromise, reject) => execFile(file, args, (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim()))); }
async function clockTicksPerSecond(): Promise<number> { return Number(await executableOutput("/usr/bin/getconf", ["CLK_TCK"])); }
async function exists(path: string): Promise<boolean> { return await stat(path).then(() => true, () => false); }
async function directoryBytes(path: string): Promise<number> { let total = 0; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const child = join(path, entry.name); if (entry.isDirectory()) total += await directoryBytes(child); else if (entry.isFile()) total += (await stat(child)).size; } return total; }
async function processTree(roots: number[]): Promise<Set<number>> { const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); const parents = new Map<number, number>(); for (const entry of entries) { const text = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => ""); const end = text.lastIndexOf(")"); if (end > 0) parents.set(Number(entry), Number(text.slice(end + 2).split(" ")[1])); } const tree = new Set(roots); let changed = true; while (changed) { changed = false; for (const [pid, ppid] of parents) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); changed = true; } } return tree; }
async function processTreeMemory(roots: number[]): Promise<{ pssKiB: number; privateDirtyKiB: number; processCount: number }> { const tree = await processTree(roots); let pssKiB = 0, privateDirtyKiB = 0, processCount = 0; for (const pid of tree) { const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => ""); if (rollup.length === 0) continue; processCount++; pssKiB += Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0); privateDirtyKiB += Number(rollup.match(/^Private_Dirty:\s+(\d+)/m)?.[1] ?? 0); } return { pssKiB, privateDirtyKiB, processCount }; }
async function processTreeCpu(roots: number[]): Promise<{ ticks: number }> { let ticks = 0; for (const pid of await processTree(roots)) { const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""); const end = text.lastIndexOf(")"); if (end <= 0) continue; const fields = text.slice(end + 2).split(" "); ticks += Number(fields[11] ?? 0) + Number(fields[12] ?? 0); } return { ticks }; }
function distribution(values: number[]): { count: number; min: number; median: number; p95: number; max: number; mean: number } { if (values.length === 0) return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }; const sorted = [...values].sort((a, b) => a - b); const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0; return { count: values.length, min: sorted[0] ?? 0, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, mean: values.reduce((sum, value) => sum + value, 0) / values.length }; }
function range(values: number[]): { start: number; end: number; min: number; max: number } { if (values.length === 0) return { start: 0, end: 0, min: 0, max: 0 }; return { start: values[0] ?? 0, end: values.at(-1) ?? 0, min: Math.min(...values), max: Math.max(...values) }; }
function slopePerHour(points: [number, number][]): number { if (points.length < 2) return 0; const xMean = points.reduce((sum, [x]) => sum + x, 0) / points.length; const yMean = points.reduce((sum, [, y]) => sum + y, 0) / points.length; let numerator = 0, denominator = 0; for (const [x, y] of points) { numerator += (x - xMean) * (y - yMean); denominator += (x - xMean) ** 2; } return denominator === 0 ? 0 : numerator / denominator * 3_600; }

try { await main(); }
catch (error) {
  console.error(error);
  await browserd?.stop().catch(() => undefined);
  await new Promise<void>((resolvePromise) => fixture?.close(() => resolvePromise()) ?? resolvePromise());
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  process.exitCode = 1;
}
