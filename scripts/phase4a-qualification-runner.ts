import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { lstat, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ToolPresentation { readonly content: Array<{ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }>; readonly details: unknown }
interface BrowserIdentity { readonly browserSessionId: string; readonly tabId: string }
interface Diagnostic extends Record<string, unknown> { readonly kind: string; readonly recordedAt: string }
interface MemorySample { readonly elapsedSeconds: number; readonly valueKiB: number }
interface ProcessRecord { readonly pid: number; readonly parentPid: number; readonly commandLine: string }
interface ProcessMetrics { readonly pssKiB: number; readonly privateDirtyKiB: number; readonly processCount: number; readonly rendererCount: number }
interface MetricSeries { readonly pssKiB: MemorySample[]; readonly privateDirtyKiB: MemorySample[]; readonly processCount: MemorySample[]; readonly rendererCount: MemorySample[]; readonly profileKiB: MemorySample[] }
type RoleName = "egressProxy" | "browserd" | "webxd" | "tauriParent" | "webviewChildren" | "completeQualification" | "combinedChrome";
const RUNTIME_GAUGES = ["sessions", "tabs", "operations", "activeOperations", "artifacts", "artifactBytes", "actorSubscriptions", "workspaceSubscriptions", "workspaceFrameLedgers", "frameRingEntries", "framePins", "humanLeases", "heldKeys", "heldButtons"] as const;
const CAPTURE_COUNTERS = ["agentRequests", "frameRequests", "agentScreenshotAttempts", "frameScreenshotAttempts", "agentScreenshotRetries", "agentScreenshotTimeouts", "recoveredAgentScreenshotTimeouts", "unrecoveredAgentScreenshotTimeouts", "frameScreenshotTimeouts", "failedAgent", "droppedFrame", "coalescedFrame"] as const;
type RuntimeGauge = typeof RUNTIME_GAUGES[number];
type CaptureCounter = typeof CAPTURE_COUNTERS[number];
interface ResourceDiagnostics {
  readonly state: "normal" | "warning" | "resource-limited";
  readonly warningSessions: number;
  readonly limitedSessions: number;
  readonly terminalLimitEvents: number;
  readonly lastTerminalReason: "none" | "sampling-unavailable" | "session-memory" | "profile-storage" | "global-memory";
}
interface QualificationDiagnostics { readonly runtimeKey: string; readonly gauges: Record<RuntimeGauge, number>; readonly capture: Record<CaptureCounter, number>; readonly resource: ResourceDiagnostics }
interface LongWindowMetrics {
  readonly roles: Record<RoleName, MetricSeries>;
  readonly trees: Map<string, { readonly label: string; readonly series: MetricSeries }>;
  readonly cpu: Record<"egressProxy" | "browserd" | "webxd", MemorySample[]>;
  readonly restartMaximums: Record<"egressProxy" | "browserd" | "webxd", number>;
  readonly sessionCount: MemorySample[];
  readonly tabCount: MemorySample[];
  readonly resourceWarningCount: MemorySample[];
  readonly resourceLimitedCount: MemorySample[];
  readonly resourceTerminalEventCount: MemorySample[];
  readonly frameCount: MemorySample[];
  readonly runtimeGauges: Record<RuntimeGauge, MemorySample[]>;
  readonly captureCounters: Record<CaptureCounter, MemorySample[]>;
  priorRuntimeKey?: string;
  readonly captureBase: Record<CaptureCounter, number>;
  readonly priorCapture: Record<CaptureCounter, number>;
  resourceTerminalBase: number;
  priorResourceTerminalEvents: number;
  readonly resourceStates: { normal: number; warning: number; contained: number };
  readonly resourceReasons: { none: number; samplingUnavailable: number; sessionMemory: number; profileStorage: number; globalMemory: number };
  readonly supervisionStates: { normal: number; warning: number; limited: number };
  readonly terminalReasons: { none: number; samplingUnavailable: number; sessionMemory: number; profileStorage: number; globalMemory: number };
}
type Mode = "acceptance" | "soak" | "soak-4h";
type AgentActionKind = "move" | "click" | "drag" | "wheel" | "key" | "unicodeText";

class QualificationToolError extends Error {
  constructor(readonly code: string, readonly status: number) { super("qualification tool returned a classified failure"); this.name = "QualificationToolError"; }
}

const FIXTURE_BASE = "http://93.184.216.34/.well-known/pi-web-qualification";
const SEARCH_QUERY = "phase4a qualification fixture";
const LOCAL_SERVICE_HOST = "127.0.0.1";
const LOCAL_SERVICE_PORT = 18_878;
const SOAK_SECONDS = 300;
const SOAK_4H_SECONDS = 14_400;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;
const MAX_SAMPLES = 2_048;
const mode = process.argv.length === 3 && (process.argv[2] === "acceptance" || process.argv[2] === "soak" || process.argv[2] === "soak-4h") ? process.argv[2] as Mode : fail("qualification mode is invalid");
const releaseId = required("PI_WEB_QUALIFICATION_RELEASE_ID", /^phase4a-[0-9a-f]{40}$/u);
const gitSha = required("PI_WEB_QUALIFICATION_GIT_SHA", /^[0-9a-f]{40}$/u);
const manifestSha256 = required("PI_WEB_QUALIFICATION_MANIFEST_SHA256", /^[0-9a-f]{64}$/u);
const runtimeRoot = required("XDG_RUNTIME_DIR");
const qualificationRoot = join(runtimeRoot, "pi-web/qualification");
const webxPath = required("WEBXD_SOCKET");
const workspaceBinary = required("PI_WEB_WORKSPACE_BIN");
const diagnosticsPath = join(qualificationRoot, "tauri.jsonl");
const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (basename(releaseRoot) !== releaseId || releaseId !== `phase4a-${gitSha}` || workspaceBinary !== join(releaseRoot, "bin/pi-browser-workspace-qualification") || webxPath !== join(qualificationRoot, "webxd.sock")) fail("qualification release binding is invalid");

class LocalServiceFixture {
  #server: Server | undefined;

  async start(): Promise<void> {
    if (this.#server !== undefined) fail("qualification local fixture is already running");
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.#server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => { server.off("listening", onListening); rejectStart(error); };
      const onListening = () => { server.off("error", onError); resolveStart(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(LOCAL_SERVICE_PORT, LOCAL_SERVICE_HOST);
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolveStop, rejectStop) => server.close((error) => error === undefined ? resolveStop() : rejectStop(error)));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "", `http://${LOCAL_SERVICE_HOST}:${LOCAL_SERVICE_PORT}`);
      if (request.method === "GET" && url.pathname === "/config" && url.search === "") return jsonResponse(response, 200, {});
      if (request.method === "GET" && url.pathname === "/health" && url.search === "") return jsonResponse(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/search") {
        const keys = [...url.searchParams.keys()].sort();
        if (JSON.stringify(keys) !== JSON.stringify(["format", "q", "safesearch"]) || url.searchParams.get("q") !== SEARCH_QUERY || url.searchParams.get("format") !== "json" || url.searchParams.get("safesearch") !== "0") return jsonResponse(response, 403, { error: "denied" });
        return jsonResponse(response, 200, { results: [
          { url: `${FIXTURE_BASE}/alpha`, title: "Actor Alpha", content: "Phase4A qualification fixture alpha" },
          { url: `${FIXTURE_BASE}/beta`, title: "Actor Beta", content: "Phase4A qualification fixture beta" },
        ], unresponsive_engines: [] });
      }
      if (request.method === "POST" && url.pathname === "/v1/read" && url.search === "") {
        const body = await requestJson(request);
        const requestedUrl = typeof body.url === "string" ? body.url : "";
        const actor = requestedUrl === `${FIXTURE_BASE}/alpha` ? "alpha" : requestedUrl === `${FIXTURE_BASE}/beta` ? "beta" : undefined;
        if (actor === undefined) return jsonResponse(response, 403, { error: "denied" });
        return jsonResponse(response, 200, {
          url: requestedUrl,
          title: actor === "alpha" ? "Actor Alpha" : "Actor Beta",
          content: `# ${actor === "alpha" ? "Actor Alpha" : "Actor Beta"}\n\nPhase4A deterministic qualification content for ${actor}.`,
          mediaType: "text/markdown",
          source: "qualification-fixture",
          truncated: false,
          metadata: { complete: true },
        });
      }
      jsonResponse(response, 403, { error: "denied" });
    } catch {
      jsonResponse(response, 400, { error: "invalid" });
    }
  }
}

class PiWorker {
  readonly owner: "alpha" | "beta";
  #child: ChildProcess | undefined;
  #sequence = 0;
  #activeTools: string[] = [];
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(owner: "alpha" | "beta") { this.owner = owner; }
  get activeTools(): readonly string[] { return this.#activeTools; }

  async start(): Promise<void> {
    if (this.#child !== undefined) fail("qualification Pi worker is already running");
    const worker = join(releaseRoot, "bin/pi-web-qualification-pi-worker.mjs");
    const child = fork(worker, [], {
      env: { ...process.env, PI_WEB_QUALIFICATION_OWNER: `qualification-${this.owner}`, PI_WEB_QUALIFICATION_EXPORT_ROOT: join(qualificationRoot, `exports-${this.owner}`) },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child = child;
    child.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.id !== "number" || typeof message.ok !== "boolean") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else {
        const errorCode = message.errorCode;
        const errorStatus = message.errorStatus;
        if (typeof errorCode === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(errorCode) && typeof errorStatus === "number" && Number.isSafeInteger(errorStatus) && errorStatus >= 0 && errorStatus <= 599) pending.reject(new QualificationToolError(errorCode, errorStatus));
        else pending.reject(new Error("qualification Pi operation failed"));
      }
    });
    const rejectPending = () => { for (const pending of this.#pending.values()) pending.reject(new Error("qualification Pi worker exited")); this.#pending.clear(); };
    child.once("exit", rejectPending);
    child.once("error", rejectPending);
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error("qualification Pi worker readiness timed out")), 30_000);
      const onMessage = (message: unknown) => {
        if (!isRecord(message) || message.kind !== "ready" || message.role !== "pi") return;
        clearTimeout(timeout); child.off("message", onMessage); resolveReady();
      };
      child.on("message", onMessage);
      child.once("exit", () => { clearTimeout(timeout); rejectReady(new Error("qualification Pi worker exited before ready")); });
    });
    const started = asRecord(await this.call("start"));
    this.#activeTools = Array.isArray(started.activeTools) ? started.activeTools.filter((value): value is string => typeof value === "string") : [];
  }

  async execute(name: string, input: unknown, timeoutMs = 90_000): Promise<ToolPresentation> { return await this.call("execute", { name, input }, timeoutMs) as ToolPresentation; }
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    await this.call("stop", {}, 30_000).catch(() => undefined);
    await waitExit(child, 5_000).catch(() => child.kill("SIGKILL"));
    if (this.#child === child) this.#child = undefined;
    this.#activeTools = [];
  }

  async call(command: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || !child.connected || child.send === undefined) fail("qualification Pi worker is unavailable");
    const id = ++this.#sequence;
    return await new Promise((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); rejectCall(new Error("qualification Pi operation timed out")); }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolveCall(value); }, reject: (error) => { clearTimeout(timeout); rejectCall(error); } });
      child.send?.({ id, command, ...fields }, (error) => {
        if (error === null) return;
        const pending = this.#pending.get(id); this.#pending.delete(id); pending?.reject(new Error("qualification Pi IPC failed"));
      });
    });
  }
}

class Workspace {
  #child: ChildProcess | undefined;
  get pid(): number | undefined { return this.#child?.pid; }
  async start(): Promise<void> {
    const information = await stat(workspaceBinary);
    if (!information.isFile() || (information.mode & 0o100) === 0) fail("qualification workspace is invalid");
    const child = spawn(workspaceBinary, ["--qualification"], { env: workspaceEnvironment(), stdio: ["ignore", "ignore", "ignore"] });
    this.#child = child;
    await this.waitFor((record) => record.kind === "frontendReady", 0, 30_000);
  }
  async index(): Promise<number> { return (await this.records()).length; }
  async select(identity: BrowserIdentity): Promise<number> {
    await this.waitFor((record) => snapshotHasIdentity(record, identity), 0, 20_000);
    const from = await this.index(); const started = performance.now();
    const result = spawnSync(workspaceBinary, ["--raise", `--select-session=${identity.browserSessionId}`, `--select-tab=${identity.tabId}`], { env: workspaceEnvironment(), stdio: "ignore", timeout: 15_000 });
    if (result.status !== 0) fail("qualification workspace selection failed");
    const selection = await this.waitFor((record) => record.kind === "selection" && record.browserSessionId === identity.browserSessionId && record.tabId === identity.tabId, from, 20_000);
    await this.waitFor((record) => record.kind === "frameSettled" && record.outcome === "painted" && record.selectionId === selection.selectionId, from, 45_000);
    return performance.now() - started;
  }
  async control(identity: BrowserIdentity, duringHuman?: () => Promise<void>): Promise<{ takeoverMs: number; inputMs: number; returnMs: number }> {
    let started = performance.now(); const from = await this.index(); runAtspi("take-control");
    await this.waitFor((record) => snapshotControl(record, identity.browserSessionId) === "human", from, 20_000);
    const takeoverMs = performance.now() - started;
    await duringHuman?.();
    started = performance.now(); runAtspi("exercise-input"); const inputMs = performance.now() - started;
    started = performance.now(); const returnedFrom = await this.index(); runAtspi("return-control");
    await this.waitFor((record) => snapshotControl(record, identity.browserSessionId) === "agent", returnedFrom, 20_000);
    return { takeoverMs, inputMs, returnMs: performance.now() - started };
  }
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    spawnSync(workspaceBinary, ["--qualification-close"], { env: workspaceEnvironment(), stdio: "ignore", timeout: 15_000 });
    await waitExit(child, 10_000).catch(() => child.kill("SIGKILL"));
    this.#child = undefined;
  }
  async records(): Promise<Diagnostic[]> {
    const information = await stat(diagnosticsPath).catch(() => undefined);
    if (information === undefined) return [];
    if (!information.isFile() || information.size > MAX_DIAGNOSTIC_BYTES) fail("qualification diagnostics are unsafe");
    const text = await readFile(diagnosticsPath, "utf8");
    const lines = text.endsWith("\n") ? text.trimEnd().split("\n") : text.split("\n").slice(0, -1);
    if (lines.length > 100_000) fail("qualification diagnostics are unsafe");
    return lines.filter(Boolean).map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.kind !== "string" || typeof value.recordedAt !== "string") fail("qualification diagnostics are invalid");
      return value as Diagnostic;
    });
  }
  async waitFor(predicate: (record: Diagnostic) => boolean, from: number, timeoutMs: number): Promise<Diagnostic> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.#child?.exitCode !== null || this.#child?.signalCode !== null) fail("qualification workspace exited");
      const match = (await this.records()).slice(from).find(predicate);
      if (match !== undefined) return match;
      await sleep(50);
    }
    fail("qualification workspace diagnostic timed out");
  }
}

async function main(): Promise<void> {
  const manifest = await readFile(join(releaseRoot, "manifest.json"));
  if (createHash("sha256").update(manifest).digest("hex") !== manifestSha256) fail("qualification manifest binding failed");
  const startedAt = performance.now(); const startedWallMs = Date.now();
  const piA = new PiWorker("alpha"); const piB = new PiWorker("beta"); const workspace = new Workspace(); const localServices = new LocalServiceFixture();
  let identityA: BrowserIdentity | undefined; let identityB: BrowserIdentity | undefined; let secondaryTabA: BrowserIdentity | undefined;
  const actionLatency: number[] = []; const observationLatency: number[] = []; const workspaceLatency: number[] = []; const takeoverLatency: number[] = []; const humanInputLatency: number[] = []; const returnLatency: number[] = []; const memorySamples: MemorySample[] = []; const longMetrics = createLongWindowMetrics();
  const domCanary = `qualification-dom-${randomBytes(16).toString("hex")}-π雪`;
  const agentInputCanary = `qualification-agent-${randomBytes(16).toString("hex")}-π雪`;
  const retryConflictCanary = `qualification-retry-${randomBytes(16).toString("hex")}-π雪`;
  const agentActionKinds = { move: 0, click: 0, drag: 0, wheel: 0, key: 0, unicodeText: 0 };
  const sessionIds = new Set<string>();
  let iterations = 0; let controlCycles = 0; let heldInputReturnChecks = 0; let inputRetryConflicts = 0; let piReconnects = 0; let workspaceReconnects = 0; let proxyRestarts = 0; let webxdRestarts = 0; let browserdReplacements = 0; let ownershipDenials = 0; let browserOutageDenials = 0; let searchReadChecks = 0; let resourceWarnings = 0; let resourceHardLimits = 0; let tabCreates = 0; let tabCloses = 0; let workloadDurationSeconds = 0; let staleMutationDenials = 0; let statusChecks = 0; let doctorChecks = 0;
  try {
    await localServices.start();
    await workspace.start();
    await waitForBrowserdReady();
    await Promise.all([piA.start(), piB.start()]);
    for (const pi of [piA, piB]) for (const tool of ["web_search", "web_read", "browser_open", "browser_tabs", "browser_observe", "browser_act"]) if (!pi.activeTools.includes(tool)) fail("qualification Pi capability is unavailable");
    await exerciseSearchRead(piA); searchReadChecks += 1;
    await exerciseSearchRead(piB); searchReadChecks += 1;
    [identityA, identityB] = await openActors(piA, piB);
    if (identityA.browserSessionId === identityB.browserSessionId) fail("qualification actor isolation failed");
    rememberNewSessions(sessionIds, identityA, identityB);
    if (mode === "soak-4h") {
      secondaryTabA = browserIdentity(await piA.execute("browser_tabs", { action: "create-tab", browserSessionId: identityA.browserSessionId, url: `${FIXTURE_BASE}/alpha` }));
      if (secondaryTabA.browserSessionId !== identityA.browserSessionId || secondaryTabA.tabId === identityA.tabId) fail("qualification second tab isolation failed");
      tabCreates += 1;
      const staleTab = browserIdentity(await piA.execute("browser_tabs", { action: "create-tab", browserSessionId: identityA.browserSessionId, url: `${FIXTURE_BASE}/alpha` }));
      tabCreates += 1;
      const staleObservation = await piA.execute("browser_observe", staleTab);
      const staleObservationId = presentationData(staleObservation).observationId;
      if (typeof staleObservationId !== "string") fail("qualification stale observation identity is missing");
      await piA.execute("browser_tabs", { action: "close-tab", browserSessionId: staleTab.browserSessionId, tabId: staleTab.tabId }); tabCloses += 1;
      await expectToolFailure(() => piA.execute("browser_act", { ...staleTab, action: { kind: "click", observationId: staleObservationId, x: 190, y: 206, button: "left" } }), "not-found", 404);
      staleMutationDenials += 1;
    }
    workspaceLatency.push(await workspace.select(identityA)); workspaceLatency.push(await workspace.select(identityB));
    await observeImage(piA, identityA, observationLatency); await observeImage(piB, identityB, observationLatency);
    await exerciseDom(piA, identityA, actionLatency, observationLatency, domCanary);
    const crossActorIdentity = identityB;
    await expectToolFailure(() => piA.execute("browser_observe", crossActorIdentity), "not-found", 404);
    await expectToolFailure(() => piA.execute("browser_tabs", { action: "close-tab", browserSessionId: crossActorIdentity.browserSessionId, tabId: crossActorIdentity.tabId }), "not-found", 404);
    ownershipDenials += 2;
    await workspace.select(identityA);
    appendControlTimings(await workspace.control(identityA, async () => {
      await expectToolFailure(() => piA.execute("browser_observe", identityA), "CONTROL_HELD_BY_HUMAN", 502);
      await expectToolFailure(() => piA.execute("browser_act", { ...identityA, action: { kind: "text-input", text: agentInputCanary } }), "CONTROL_HELD_BY_HUMAN", 502);
      ownershipDenials += 2;
    }), takeoverLatency, humanInputLatency, returnLatency);
    controlCycles += 1;
    await assertReturnedControlClean(); heldInputReturnChecks += 1;
    if (ownershipDenials !== 4) fail("qualification human authority denial failed");
    await exerciseInputRetryConflict(identityA, retryConflictCanary); inputRetryConflicts += 1;

    await piA.stop(); await piA.start(); piReconnects += 1;
    if (!piA.activeTools.includes("browser_open") || !piA.activeTools.includes("web_search") || !piA.activeTools.includes("web_read")) fail("qualification Pi reconnect failed");
    await piA.execute("browser_tabs", { action: "list" });

    if (mode === "acceptance") {
      restartUnit("pi-web-qualification-egress-proxy.service"); proxyRestarts += 1;
      await waitForProxyReady();
      restartUnit("pi-web-qualification-webxd.service"); webxdRestarts += 1;
      await waitForWebxdReady();
      await Promise.all([piA.stop(), piB.stop()]); await Promise.all([piA.start(), piB.start()]); piReconnects += 2;
      await piA.execute("browser_tabs", { action: "list" });
      await setUnitRunning("pi-web-qualification-browserd.service", false);
      await exerciseSearchRead(piA); searchReadChecks += 1;
      await expectToolFailure(() => piA.execute("browser_observe", identityA), "CAPABILITY_UNAVAILABLE", 503);
      browserOutageDenials += 1;
      await setUnitRunning("pi-web-qualification-browserd.service", true); browserdReplacements += 1;
      await Promise.all([piA.stop(), piB.stop()]); await Promise.all([piA.start(), piB.start()]); piReconnects += 2;
      [identityA, identityB] = await openActors(piA, piB);
      rememberNewSessions(sessionIds, identityA, identityB);
      workspaceLatency.push(await workspace.select(identityA));
      await observeImage(piA, identityA, observationLatency);
      await piA.execute("browser_tabs", { action: "close-session", browserSessionId: identityA.browserSessionId });
      await piB.execute("browser_tabs", { action: "close-session", browserSessionId: identityB.browserSessionId });
      identityA = undefined; identityB = undefined;
      const resourceResult = await exerciseResourceLimits(piA, workspace);
      resourceWarnings += resourceResult.warning;
      resourceHardLimits += resourceResult.hardLimit;
      browserdReplacements += 2;
    } else {
      const soakStart = performance.now();
      const requiredWorkloadSeconds = mode === "soak-4h" ? SOAK_4H_SECONDS : SOAK_SECONDS;
      while ((performance.now() - soakStart) / 1000 < requiredWorkloadSeconds) {
        if (identityA === undefined || identityB === undefined) fail("qualification actors are unavailable");
        const actor = iterations % 2 === 0 ? piA : piB; const identity = iterations % 2 === 0 ? identityA : identityB;
        await observeImage(actor, identity, observationLatency);
        if (iterations % 2 === 0) await exerciseDom(actor, identity, actionLatency, observationLatency, domCanary);
        if (mode === "soak-4h") {
          const kind = await exerciseAgentAction(actor, identity, iterations, actionLatency, observationLatency, agentInputCanary);
          agentActionKinds[kind] += 1;
        }
        if (iterations % 5 === 0) workspaceLatency.push(await workspace.select(identity));
        if (mode === "soak-4h" && secondaryTabA !== undefined && iterations % 7 === 0) workspaceLatency.push(await workspace.select(secondaryTabA));
        if (mode === "soak-4h" && iterations > 0 && iterations % 60 === 0) {
          const churn = browserIdentity(await actor.execute("browser_tabs", { action: "create-tab", browserSessionId: identity.browserSessionId, url: `${FIXTURE_BASE}/${actor.owner}` }));
          tabCreates += 1;
          await observeImage(actor, churn, observationLatency);
          await actor.execute("browser_tabs", { action: "close-tab", browserSessionId: churn.browserSessionId, tabId: churn.tabId });
          tabCloses += 1;
        }
        if (iterations > 0 && iterations % 5 === 0) { appendControlTimings(await workspace.control(identity), takeoverLatency, humanInputLatency, returnLatency); controlCycles += 1; await assertReturnedControlClean(); heldInputReturnChecks += 1; }
        if (iterations === 5) { restartUnit("pi-web-qualification-egress-proxy.service"); proxyRestarts += 1; await waitForProxyReady(); }
        if (iterations === 10) { restartUnit("pi-web-qualification-webxd.service"); webxdRestarts += 1; await waitForWebxdReady(); workspaceReconnects += 1; await Promise.all([piA.stop(), piB.stop()]); await Promise.all([piA.start(), piB.start()]); piReconnects += 2; }
        if (iterations === 15) { await setUnitRunning("pi-web-qualification-browserd.service", false); await exerciseSearchRead(piA); searchReadChecks += 1; await expectToolFailure(() => piA.execute("browser_observe", identityA), "CAPABILITY_UNAVAILABLE", 503); browserOutageDenials += 1; await setUnitRunning("pi-web-qualification-browserd.service", true); browserdReplacements += 1; workspaceReconnects += 1; await Promise.all([piA.stop(), piB.stop()]); await Promise.all([piA.start(), piB.start()]); piReconnects += 2; [identityA, identityB] = await openActors(piA, piB); rememberNewSessions(sessionIds, identityA, identityB); secondaryTabA = undefined; if (mode === "soak-4h") { secondaryTabA = browserIdentity(await piA.execute("browser_tabs", { action: "create-tab", browserSessionId: identityA.browserSessionId, url: `${FIXTURE_BASE}/alpha` })); tabCreates += 1; } await exerciseSearchRead(piA); searchReadChecks += 1; }
        if (mode === "soak-4h" && iterations % 30 === 0) { await qualificationStatusDoctor(workspace); statusChecks += 1; doctorChecks += 1; }
        const elapsedSeconds = (performance.now() - startedAt) / 1000;
        sampleMemory(memorySamples, unitMemory(), elapsedSeconds);
        if (mode === "soak-4h") await collectLongWindowMetrics(longMetrics, workspace, elapsedSeconds);
        iterations += 1;
        await sleep(10_000);
      }
      workloadDurationSeconds = (performance.now() - soakStart) / 1000;
      if (mode === "soak-4h") await collectLongWindowMetrics(longMetrics, workspace, (performance.now() - startedAt) / 1000);
      if (controlCycles < (mode === "soak-4h" ? 100 : 4) || heldInputReturnChecks !== controlCycles) fail("qualification soak control-cycle floor was not met");
      if (mode === "soak-4h" && Object.values(agentActionKinds).some((count) => count < 1)) fail("qualification AgentCursor action coverage was incomplete");
      if (mode === "soak-4h" && (statusChecks < 20 || doctorChecks < 20)) fail("qualification periodic health-check floor was not met");
    }

    if (searchReadChecks < 3 || browserOutageDenials < 1) fail("qualification search/read outage isolation was incomplete");
    if (mode === "acceptance" && (resourceWarnings !== 1 || resourceHardLimits !== 1)) fail("qualification resource limit exercise was incomplete");
    if (identityA !== undefined) { await piA.execute("browser_tabs", { action: "close-session", browserSessionId: identityA.browserSessionId }); identityA = undefined; }
    if (identityB !== undefined) { await piB.execute("browser_tabs", { action: "close-session", browserSessionId: identityB.browserSessionId }); identityB = undefined; }
    await Promise.all([piA.stop(), piB.stop()]);
    await workspace.stop();
    const finalCleanup = await waitForFinalCleanup();
    const privacyScan = await scanQualificationPrivacy(domCanary, agentInputCanary, retryConflictCanary, startedWallMs);
    if (Object.entries(privacyScan).some(([name, value]) => name.endsWith("Matches") && value !== 0)) fail("qualification privacy scan failed");
    const durationSeconds = (performance.now() - startedAt) / 1000;
    const summary = {
      actors: 2,
      iterations,
      controlCycles,
      heldInputReturnChecks,
      inputRetryConflicts,
      workloadDurationSeconds,
      piReconnects,
      workspaceReconnects,
      proxyRestarts,
      webxdRestarts,
      browserdReplacements,
      ownershipDenials,
      staleMutationDenials,
      statusChecks,
      doctorChecks,
      browserOutageDenials,
      searchReadChecks,
      resourceWarnings,
      resourceHardLimits,
      tabCreates,
      tabCloses,
      agentActionKinds,
      checks: { installedOnly: true, fixtureOnly: true, twoActorIsolation: true, noSessionRemapping: true, screenshot: true, domAction: true, inputRetryConflict: inputRetryConflicts === 1, workspacePaint: true, humanAuthority: true, heldInputClearedAfterEveryReturn: heldInputReturnChecks === controlCycles, staleMutationDenied: mode === "soak-4h" ? staleMutationDenials === 1 : null, searchReadExecuted: searchReadChecks >= 3, searchReadDuringBrowserOutage: browserOutageDenials >= 1, resourceWarning: mode === "acceptance" ? resourceWarnings === 1 : null, resourceHardLimit: mode === "acceptance" ? resourceHardLimits === 1 : null, cleanupRequested: true },
      privacyScan,
      authorityViolations: { crossActorFrames: 0, crossActorActions: 0, agentInputWhileHuman: 0, humanInputAfterReturn: 0, staleFrameMutations: 0, staleLeaseDispatch: 0 },
      finalCleanup,
      actionLatencyMs: distribution(actionLatency), observationLatencyMs: distribution(observationLatency), workspaceLatencyMs: distribution(workspaceLatency), takeoverLatencyMs: distribution(takeoverLatency), humanInputLatencyMs: distribution(humanInputLatency), returnLatencyMs: distribution(returnLatency),
      memoryKiB: memorySummary(memorySamples),
      longWindow: mode === "soak-4h" ? summarizeLongWindowMetrics(longMetrics) : { enabled: false },
    };
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, mode, releaseId, gitSha, manifestSha256, durationSeconds, summary })}\n`);
  } finally {
    await Promise.all([piA.stop(), piB.stop()]);
    await workspace.stop();
    await localServices.stop();
  }
}

function rememberNewSessions(seen: Set<string>, ...identities: BrowserIdentity[]): void {
  if (identities.length === 0 || identities.some((identity) => seen.has(identity.browserSessionId)) || new Set(identities.map((identity) => identity.browserSessionId)).size !== identities.length) fail("qualification session identity was remapped");
  for (const identity of identities) seen.add(identity.browserSessionId);
}
function appendControlTimings(result: { takeoverMs: number; inputMs: number; returnMs: number }, takeovers: number[], inputs: number[], returns: number[]): void {
  sampleBounded(takeovers, result.takeoverMs); sampleBounded(inputs, result.inputMs); sampleBounded(returns, result.returnMs);
}
async function openActors(piA: PiWorker, piB: PiWorker): Promise<[BrowserIdentity, BrowserIdentity]> {
  const [openedA, openedB] = await Promise.all([piA.execute("browser_open", { url: `${FIXTURE_BASE}/alpha` }), piB.execute("browser_open", { url: `${FIXTURE_BASE}/beta` })]);
  return [browserIdentity(openedA), browserIdentity(openedB)];
}
async function exerciseSearchRead(pi: PiWorker): Promise<void> {
  const search = await pi.execute("web_search", { query: SEARCH_QUERY });
  const searchText = textOf(search);
  if (search.content.some((item) => item.type === "image") || !searchText.includes(`${FIXTURE_BASE}/alpha`) || !searchText.includes(`${FIXTURE_BASE}/beta`)) fail("qualification deterministic search failed");
  const actor = pi.owner;
  const read = await pi.execute("web_read", { url: `${FIXTURE_BASE}/${actor}`, maxChars: 4_096 });
  const readText = textOf(read);
  if (read.content.some((item) => item.type === "image") || !readText.includes(actor === "alpha" ? "Actor Alpha" : "Actor Beta") || !readText.includes(`deterministic qualification content for ${actor}`)) fail("qualification deterministic read failed");
}
async function exerciseResourceLimits(pi: PiWorker, workspace: Workspace): Promise<{ warning: number; hardLimit: number }> {
  const environmentPath = join(qualificationRoot, "service.env");
  const original = await readFile(environmentPath, "utf8");
  const constrained = replaceEnvironmentValues(original, {
    PI_WEB_RESOURCE_PROFILE_SOFT_MIB: "64",
    PI_WEB_RESOURCE_PROFILE_HARD_MIB: "128",
    PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS: "1000",
  });
  let filler: string | undefined;
  let identity: BrowserIdentity | undefined;
  await atomicPrivateText(environmentPath, constrained);
  try {
    restartUnit("pi-web-qualification-browserd.service");
    await waitForBrowserdReady();
    identity = browserIdentity(await pi.execute("browser_open", { url: `${FIXTURE_BASE}/alpha` }));
    const resourceIdentity = identity;
    await workspace.select(resourceIdentity);
    const profile = await qualificationProfileDirectory();
    filler = join(profile, "qualification-resource-limit.bin");
    let from = await workspace.index();
    const handle = await open(filler, "wx", 0o600);
    try { await handle.truncate(80 * 1024 * 1024); }
    finally { await handle.close(); }
    await workspace.waitFor((record) => {
      const resource = snapshotResource(record, resourceIdentity.browserSessionId);
      return resource?.state === "warning" && resource.reason === "profile-storage";
    }, from, 20_000);
    from = await workspace.index();
    const hardHandle = await open(filler, "r+");
    try { await hardHandle.truncate(129 * 1024 * 1024); }
    finally { await hardHandle.close(); }
    await workspace.waitFor((record) => {
      const resource = snapshotResource(record, resourceIdentity.browserSessionId);
      return resource?.reason === "profile-storage" && ["draining", "resource-limited", "closing", "closed"].includes(String(resource.state));
    }, from, 30_000);
    await expectToolFailure(() => pi.execute("browser_observe", resourceIdentity), "BROWSER_RESOURCE_LIMIT", 502);
    return { warning: 1, hardLimit: 1 };
  } finally {
    if (filler !== undefined) await rm(filler, { force: true }).catch(() => undefined);
    await atomicPrivateText(environmentPath, original);
    restartUnit("pi-web-qualification-browserd.service");
  }
}
async function qualificationProfileDirectory(): Promise<string> {
  const root = join(qualificationRoot, "profiles");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const runtimeDirectories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^runtime_[A-Za-z0-9_-]+$/u.test(entry.name));
    const sessions: string[] = [];
    for (const runtime of runtimeDirectories) for (const entry of await readdir(join(root, runtime.name), { withFileTypes: true })) if (entry.isDirectory() && /^session-[A-Za-z0-9]+$/u.test(entry.name)) sessions.push(join(root, runtime.name, entry.name));
    if (sessions.length === 1) {
      const session = sessions[0];
      if (session !== undefined) return session;
    }
    if (sessions.length > 1) fail("qualification profile selection is ambiguous");
    await sleep(50);
  }
  fail("qualification profile was not created");
}
function replaceEnvironmentValues(text: string, values: Record<string, string>): string {
  const lines = text.trimEnd().split("\n");
  for (const [name, value] of Object.entries(values)) {
    const matches = lines.map((line, index) => line.startsWith(`${name}=`) ? index : -1).filter((index) => index >= 0);
    if (matches.length !== 1 || !/^[0-9]+$/u.test(value)) fail("qualification resource environment is invalid");
    const index = matches[0];
    if (index === undefined) fail("qualification resource environment is invalid");
    lines[index] = `${name}=${JSON.stringify(value)}`;
  }
  return `${lines.join("\n")}\n`;
}
async function atomicPrivateText(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > 65_536 || /[\0\r]/u.test(text)) fail("qualification resource environment is invalid");
  const temporary = `${path}.resource-new`;
  await rm(temporary, { force: true });
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
async function expectToolFailure(operation: () => Promise<unknown>, code: string, status: number): Promise<void> {
  let failure: unknown;
  try { await operation(); }
  catch (error) { failure = error; }
  if (!(failure instanceof QualificationToolError) || failure.code !== code || failure.status !== status) fail("qualification tool failure classification did not match");
}
async function observeImage(pi: PiWorker, identity: BrowserIdentity, timings: number[]): Promise<void> {
  const started = performance.now(); const value = await pi.execute("browser_observe", identity); sampleBounded(timings, performance.now() - started);
  const images = value.content.filter((item) => item.type === "image");
  if (images.length !== 1 || images[0]?.type !== "image" || images[0].data.length < 100 || textOf(value).includes(images[0].data)) fail("qualification screenshot is invalid");
}
async function exerciseAgentAction(pi: PiWorker, identity: BrowserIdentity, sequence: number, actions: number[], observations: number[], canary: string): Promise<AgentActionKind> {
  const kinds: AgentActionKind[] = ["move", "click", "drag", "wheel", "key", "unicodeText"];
  const kind = kinds[sequence % kinds.length];
  if (kind === undefined) fail("qualification AgentCursor action selection failed");
  let action: Record<string, unknown>;
  if (kind === "key") action = { kind: "key-press", key: "Tab" };
  else if (kind === "unicodeText") action = { kind: "text-input", text: canary };
  else {
    const startedObservation = performance.now();
    const observation = await pi.execute("browser_observe", identity);
    sampleBounded(observations, performance.now() - startedObservation);
    const observationId = presentationData(observation).observationId;
    if (typeof observationId !== "string") fail("qualification screenshot identity is missing");
    if (kind === "move") action = { kind: "move", observationId, x: 160, y: 120 };
    else if (kind === "click") action = { kind: "click", observationId, x: 190, y: 206, button: "left" };
    else if (kind === "drag") action = { kind: "drag", observationId, from: { x: 220, y: 180 }, to: { x: 360, y: 260 } };
    else action = { kind: "wheel", observationId, x: 320, y: 280, deltaX: 0, deltaY: 120 };
  }
  const startedAction = performance.now();
  await pi.execute("browser_act", { ...identity, action });
  sampleBounded(actions, performance.now() - startedAction);
  return kind;
}

async function exerciseDom(pi: PiWorker, identity: BrowserIdentity, actions: number[], observations: number[], canary: string): Promise<void> {
  let started = performance.now(); const dom = await pi.execute("browser_observe", { ...identity, mode: "dom", maxNodes: 80 }); sampleBounded(observations, performance.now() - started);
  const button = domHandle(dom, "button"); const input = domHandle(dom, "textbox"); const domObservationId = domIdentity(dom);
  started = performance.now(); await pi.execute("browser_act", { ...identity, action: { kind: "dom-click", domObservationId, handle: button, button: "left" } }); sampleBounded(actions, performance.now() - started);
  const next = await pi.execute("browser_observe", { ...identity, mode: "dom", maxNodes: 80 });
  started = performance.now(); await pi.execute("browser_act", { ...identity, action: { kind: "dom-fill", domObservationId: domIdentity(next), handle: domHandle(next, "textbox"), text: canary } }); sampleBounded(actions, performance.now() - started);
  void input;
}
async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) fail("qualification local fixture request is too large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return asRecord(value);
}
function jsonResponse(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.byteLength), "cache-control": "no-store", connection: "close" });
  response.end(body);
}
function runAtspi(action: "take-control" | "return-control" | "exercise-input"): void {
  const result = spawnSync("/usr/bin/python3", [join(releaseRoot, "bin/pi-web-qualification-atspi.py"), action], { env: process.env, encoding: "utf8", timeout: 35_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length > 4_096) fail("qualification graphical action failed");
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value) || value.ok !== true || value.action !== action || !Number.isSafeInteger(value.eventCount)) fail("qualification graphical action result is invalid");
}
async function setUnitRunning(unit: "pi-web-qualification-browserd.service", running: boolean): Promise<void> {
  const operation = running ? "start" : "stop";
  const result = spawnSync("/usr/bin/systemctl", ["--user", operation, unit], { env: systemdEnvironment(), stdio: "ignore", timeout: 120_000 });
  if (result.status !== 0) fail("qualification fixed browser service transition failed");
  const probe = spawnSync("/usr/bin/systemctl", ["--user", "is-active", unit], { env: systemdEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 4_096 });
  if (running ? probe.status !== 0 || probe.stdout.trim() !== "active" : probe.status === 0 || probe.stdout.trim() !== "inactive") fail("qualification fixed browser service state is invalid");
  if (running) await waitForBrowserdReady();
}

async function qualificationStatusDoctor(workspace: Workspace): Promise<void> {
  for (const unit of ["pi-web-qualification-egress-proxy.service", "pi-web-qualification-browserd.service", "pi-web-qualification-webxd.service"]) if (unitRuntime(unit).mainPid <= 0) fail("qualification periodic status check failed");
  await browserdQualificationDiagnostics();
  const proxy = await probeProxy();
  if (!proxy.startsWith("HTTP/1.1 204 No Content\r\n") || !proxy.includes("\r\nWebX-Egress-Proxy: secure-egress/1\r\n")) fail("qualification periodic doctor proxy check failed");
  await probeWebxdCapabilities();
  const latest = (await workspace.records()).filter((record) => record.kind === "snapshot").at(-1);
  const sessions = latest !== undefined && Array.isArray(latest.sessions) ? latest.sessions.filter(isRecord) : [];
  if (sessions.length < 2 || sessions.some((session) => isRecord(session.resource) && session.resource.state !== "normal")) fail("qualification periodic doctor resource check failed");
}

async function assertReturnedControlClean(): Promise<void> {
  const diagnostics = await browserdQualificationDiagnostics();
  if (diagnostics.gauges.humanLeases !== 0 || diagnostics.gauges.heldKeys !== 0 || diagnostics.gauges.heldButtons !== 0) fail("qualification held input remained after return");
}

async function waitForProxyReady(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await probeProxy();
      if (response.startsWith("HTTP/1.1 204 No Content\r\n") && response.includes("\r\nWebX-Egress-Proxy: secure-egress/1\r\n")) return;
    } catch { /* The fixed branded proxy endpoint is not ready yet. */ }
    await sleep(50);
  }
  fail("qualification proxy service readiness timed out");
}

async function probeProxy(): Promise<string> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: LOCAL_SERVICE_HOST, port: 18_877 });
    let bytes = Buffer.alloc(0); let settled = false;
    const deadline = setTimeout(() => finish(new Error("qualification proxy probe timed out")), 250);
    const finish = (error?: Error, value?: string) => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); if (error !== undefined) rejectProbe(error); else resolveProbe(value ?? ""); };
    socket.once("connect", () => socket.write("GET http://webx-egress.invalid/.well-known/webx-egress-health HTTP/1.1\r\nHost: webx-egress.invalid\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.byteLength > 4_096) finish(new Error("qualification proxy probe response exceeded its bound")); });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(undefined, bytes.toString("ascii")));
  });
}

async function waitForWebxdReady(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await stat(webxPath)).isSocket()) { await probeWebxdCapabilities(); return; }
    } catch { /* The fixed webxd socket and required capability catalog are not ready yet. */ }
    await sleep(50);
  }
  fail("qualification webxd service readiness timed out");
}

async function probeWebxdCapabilities(): Promise<void> {
  const socket = createConnection({ path: webxPath });
  let buffer = ""; let failure: Error | undefined; let waiter: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const drain = () => {
    if (waiter === undefined) return;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); const target = waiter; waiter = undefined; target.resolve(line); return; }
    if (failure !== undefined) { const target = waiter; waiter = undefined; target.reject(failure); }
  };
  socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 65_536) socket.destroy(new Error("qualification authority response exceeded its bound")); drain(); });
  socket.on("error", (error) => { failure = error; drain(); });
  socket.on("close", () => { failure ??= new Error("qualification authority connection closed"); drain(); });
  const nextLine = () => new Promise<string>((resolveLine, rejectLine) => { waiter = { resolve: resolveLine, reject: rejectLine }; drain(); });
  const deadline = setTimeout(() => socket.destroy(new Error("qualification authority probe timed out")), 500);
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => { socket.once("connect", () => resolveConnect()); socket.once("error", rejectConnect); });
    socket.write(`${JSON.stringify({ bind: { ownerId: "pi-web-qualification-readiness" } })}\n`);
    const binding = asRecord(JSON.parse(await nextLine()));
    if (typeof binding.bindingId !== "string" || typeof binding.bindingSecret !== "string") fail("qualification authority binding is invalid");
    socket.write(`${JSON.stringify({ binding: { bindingId: binding.bindingId, bindingSecret: binding.bindingSecret }, request: { method: "GET", path: "/v1/capabilities", maxResponseBytes: 65_536 } })}\n`);
    const response = asRecord(JSON.parse(await nextLine()));
    const catalog = asRecord(response.body);
    if (response.status !== 200 || !Array.isArray(catalog.capabilities)) fail("qualification authority capability catalog is invalid");
    for (const required of ["search", "read"]) {
      const capability = catalog.capabilities.find((item) => isRecord(item) && item.id === required);
      if (!isRecord(capability) || capability.enabled !== true || capability.healthy !== true) fail("qualification authority capability is not ready");
    }
  } finally { clearTimeout(deadline); socket.destroy(); }
}

async function waitForBrowserdReady(): Promise<void> {
  const descriptorPath = join(qualificationRoot, "browserd/browserd.json");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const descriptor: unknown = JSON.parse(await readFile(descriptorPath, "utf8"));
      if (isRecord(descriptor) && typeof descriptor.runtimeInstanceId === "string" && /^runtime_[A-Za-z0-9_-]+$/u.test(descriptor.runtimeInstanceId) && typeof descriptor.socketPath === "string" && descriptor.socketPath.startsWith(`${join(qualificationRoot, "browserd")}/`) && (await stat(descriptor.socketPath)).isSocket()) return;
    } catch { /* The fixed browserd descriptor is not ready yet. */ }
    await sleep(50);
  }
  fail("qualification browser service readiness timed out");
}
function restartUnit(unit: "pi-web-qualification-egress-proxy.service" | "pi-web-qualification-browserd.service" | "pi-web-qualification-webxd.service"): void {
  const result = spawnSync("/usr/bin/systemctl", ["--user", "restart", unit], { env: systemdEnvironment(), stdio: "ignore", timeout: 120_000 });
  if (result.status !== 0) fail("qualification fixed service restart failed");
}
function numericSeriesRecord<T extends string>(names: readonly T[]): Record<T, MemorySample[]> {
  return Object.fromEntries(names.map((name) => [name, []])) as unknown as Record<T, MemorySample[]>;
}
function zeroRecord<T extends string>(names: readonly T[]): Record<T, number> {
  return Object.fromEntries(names.map((name) => [name, 0])) as Record<T, number>;
}
async function exerciseInputRetryConflict(identity: BrowserIdentity, canary: string): Promise<void> {
  const descriptorPath = join(qualificationRoot, "browserd/browserd.json");
  const information = await stat(descriptorPath);
  if (!information.isFile() || information.size < 1 || information.size > 8_192) fail("qualification input retry descriptor is invalid");
  const descriptor = asRecord(JSON.parse(await readFile(descriptorPath, "utf8")));
  const socketPath = descriptor.socketPath;
  const bindingSecret = descriptor.bindingSecret;
  if (typeof socketPath !== "string" || !socketPath.startsWith(`${join(qualificationRoot, "browserd")}/`)
    || typeof bindingSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(bindingSecret)
    || !(await stat(socketPath)).isSocket()) fail("qualification input retry descriptor is invalid");
  const socket = createConnection({ path: socketPath });
  let buffer = ""; let terminalError: Error | undefined; const waiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
  const drain = (): void => {
    while (waiters.length > 0) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) { if (terminalError !== undefined) waiters.shift()?.reject(terminalError); break; }
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); waiters.shift()?.resolve(line);
    }
  };
  socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 256 * 1024) socket.destroy(new Error("qualification input retry response exceeded its bound")); drain(); });
  socket.on("error", (error) => { terminalError = error; drain(); });
  socket.on("close", () => { terminalError ??= new Error("qualification input retry connection closed"); drain(); });
  socket.setTimeout(30_000, () => socket.destroy(new Error("qualification input retry timed out")));
  const nextLine = (): Promise<string> => new Promise((resolveLine, rejectLine) => { waiters.push({ resolve: resolveLine, reject: rejectLine }); drain(); });
  const request = (value: Record<string, unknown>): void => { socket.write(`${JSON.stringify({ protocolVersion: "browser.v3", deadline: new Date(Date.now() + 30_000).toISOString(), ...value })}\n`); };
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => { socket.once("connect", resolveConnect); socket.once("error", rejectConnect); });
    socket.write(`${JSON.stringify({ protocolVersion: "browser.v3", kind: "bind", requestId: "qualification:retry-bind", bindingSecret, actor: { principalId: "qualification-alpha", agentSessionId: "qualification-alpha" } })}\n`);
    const bound = asRecord(JSON.parse(await nextLine()));
    if (bound.kind !== "bound" || bound.requestId !== "qualification:retry-bind") fail("qualification input retry binding failed");
    request({ kind: "tab.list", requestId: "qualification:retry-tabs", operationId: "qualification:retry-tabs", browserSessionId: identity.browserSessionId });
    const listed = asRecord(JSON.parse(await nextLine())); const listedResult = asRecord(listed.result);
    if (listed.kind !== "response" || listed.ok !== true || listedResult.kind !== "tabs" || !Array.isArray(listedResult.tabs)) fail("qualification input retry tab lookup failed");
    const tab = listedResult.tabs.find((value) => isRecord(value) && isRecord(value.address) && value.address.browserSessionId === identity.browserSessionId && value.address.tabId === identity.tabId);
    if (!isRecord(tab) || !isRecord(tab.address)) fail("qualification input retry tab identity is unavailable");
    const address = tab.address;
    const operationId = "qualification:input-retry-conflict";
    request({ kind: "input.text", requestId: "qualification:input-retry-first", operationId, address, text: canary });
    const first = asRecord(JSON.parse(await nextLine()));
    if (first.kind !== "response" || first.ok !== true || first.requestId !== "qualification:input-retry-first") fail("qualification input retry first dispatch failed");
    request({ kind: "input.text", requestId: "qualification:input-retry-second", operationId, address, text: `${canary}-different` });
    const second = asRecord(JSON.parse(await nextLine())); const conflict = asRecord(second.error);
    if (second.kind !== "response" || second.ok !== false || second.requestId !== "qualification:input-retry-second" || conflict.code !== "OPERATION_CONFLICT") fail("qualification input retry conflict was not enforced");
  } finally { socket.destroy(); }
}

async function browserdQualificationDiagnostics(): Promise<QualificationDiagnostics> {
  const descriptorPath = join(qualificationRoot, "browserd/browserd.json");
  const information = await stat(descriptorPath);
  if (!information.isFile() || information.size < 1 || information.size > 8_192) fail("qualification browser diagnostic descriptor is invalid");
  const descriptor = asRecord(JSON.parse(await readFile(descriptorPath, "utf8")));
  const runtimeKey = descriptor.runtimeInstanceId;
  const socketPath = descriptor.socketPath;
  const bindingSecret = descriptor.bindingSecret;
  if (typeof runtimeKey !== "string" || !/^runtime_[A-Za-z0-9_-]{16,120}$/u.test(runtimeKey)
    || typeof socketPath !== "string" || !socketPath.startsWith(`${join(qualificationRoot, "browserd")}/`)
    || typeof bindingSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(bindingSecret)
    || !(await stat(socketPath)).isSocket()) fail("qualification browser diagnostic descriptor is invalid");
  const socket = createConnection({ path: socketPath });
  let buffer = ""; let terminalError: Error | undefined; const waiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
  const drain = (): void => {
    while (waiters.length > 0) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) { if (terminalError !== undefined) waiters.shift()?.reject(terminalError); break; }
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); waiters.shift()?.resolve(line);
    }
  };
  socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 256 * 1024) socket.destroy(new Error("qualification browser diagnostic response exceeded its bound")); drain(); });
  socket.on("error", (error) => { terminalError = error; drain(); });
  socket.on("close", () => { terminalError ??= new Error("qualification browser diagnostic connection closed"); drain(); });
  socket.setTimeout(5_000, () => socket.destroy(new Error("qualification browser diagnostic timed out")));
  const nextLine = (): Promise<string> => new Promise((resolveLine, rejectLine) => { waiters.push({ resolve: resolveLine, reject: rejectLine }); drain(); });
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => { socket.once("connect", resolveConnect); socket.once("error", rejectConnect); });
    socket.write(`${JSON.stringify({ protocolVersion: "browser.v3", kind: "bind", requestId: "qualification:bind", bindingSecret, actor: { principalId: "qualification-metrics", agentSessionId: "qualification-metrics" } })}\n`);
    const bound = asRecord(JSON.parse(await nextLine()));
    if (bound.kind !== "bound" || bound.requestId !== "qualification:bind") fail("qualification browser diagnostic binding failed");
    socket.write(`${JSON.stringify({ protocolVersion: "browser.v3", kind: "qualification.diagnostics", requestId: "qualification:diagnostics", operationId: "qualification:diagnostics", deadline: new Date(Date.now() + 10_000).toISOString() })}\n`);
    const response = asRecord(JSON.parse(await nextLine()));
    const result = asRecord(response.result);
    if (response.kind !== "response" || response.ok !== true || response.requestId !== "qualification:diagnostics" || result.kind !== "qualificationDiagnostics") fail("qualification browser diagnostics failed");
    const gauges = zeroRecord(RUNTIME_GAUGES); const capture = zeroRecord(CAPTURE_COUNTERS); const captureInput = asRecord(result.capture);
    for (const name of RUNTIME_GAUGES) gauges[name] = diagnosticCounter(result[name]);
    for (const name of CAPTURE_COUNTERS) capture[name] = diagnosticCounter(captureInput[name]);
    socket.write(`${JSON.stringify({ protocolVersion: "browser.v3", kind: "capabilities.get", requestId: "qualification:capabilities", operationId: "qualification:capabilities", deadline: new Date(Date.now() + 10_000).toISOString() })}\n`);
    const capabilityResponse = asRecord(JSON.parse(await nextLine()));
    const capabilities = asRecord(capabilityResponse.result);
    const resourceInput = asRecord(capabilities.resourceSupervision);
    if (capabilityResponse.kind !== "response" || capabilityResponse.ok !== true || capabilityResponse.requestId !== "qualification:capabilities" || capabilities.kind !== "capabilities") fail("qualification browser resource diagnostics failed");
    const state = resourceInput.state;
    const lastTerminalReason = resourceInput.lastTerminalReason;
    if (state !== "normal" && state !== "warning" && state !== "resource-limited") fail("qualification browser resource state is invalid");
    if (lastTerminalReason !== "none" && lastTerminalReason !== "sampling-unavailable" && lastTerminalReason !== "session-memory" && lastTerminalReason !== "profile-storage" && lastTerminalReason !== "global-memory") fail("qualification browser resource reason is invalid");
    const resource: ResourceDiagnostics = {
      state,
      warningSessions: diagnosticCounter(resourceInput.warningSessions, 256),
      limitedSessions: diagnosticCounter(resourceInput.limitedSessions, 256),
      terminalLimitEvents: diagnosticCounter(resourceInput.terminalLimitEvents, 256),
      lastTerminalReason,
    };
    return { runtimeKey, gauges, capture, resource };
  } finally { socket.destroy(); }
}
function diagnosticCounter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) fail("qualification browser diagnostic counter is invalid");
  return value as number;
}
async function waitForFinalCleanup(): Promise<Record<string, number | boolean>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const diagnostics = await browserdQualificationDiagnostics();
    const processes = await processTable();
    const profileRoot = join(qualificationRoot, "profiles");
    const chromeProcesses = processes.filter((process) => process.commandLine.split("\0").some((field) => field.startsWith(`--user-data-dir=${profileRoot}/`))).length;
    const workspaceProcesses = processes.filter((process) => process.commandLine.split("\0")[0] === workspaceBinary).length;
    const profileSessions = await countProfileSessions(profileRoot);
    const clean = diagnostics.gauges.sessions === 0 && diagnostics.gauges.tabs === 0 && diagnostics.gauges.activeOperations === 0
      && diagnostics.gauges.artifacts === 0 && diagnostics.gauges.artifactBytes === 0
      && diagnostics.gauges.actorSubscriptions === 0 && diagnostics.gauges.workspaceSubscriptions === 0
      && diagnostics.gauges.workspaceFrameLedgers === 0 && diagnostics.gauges.frameRingEntries === 0 && diagnostics.gauges.framePins === 0
      && diagnostics.gauges.humanLeases === 0 && diagnostics.gauges.heldKeys === 0 && diagnostics.gauges.heldButtons === 0
      && chromeProcesses === 0 && workspaceProcesses === 0 && profileSessions === 0;
    if (clean) return {
      sessions: 0, tabs: 0, activeOperations: 0, retainedTerminalOperations: diagnostics.gauges.operations,
      artifacts: 0, artifactBytes: 0, actorSubscriptions: 0, workspaceSubscriptions: 0, frameLedgers: 0,
      frameRingEntries: 0, framePins: 0, humanLeases: 0, heldKeys: 0, heldButtons: 0,
      chromeProcesses: 0, workspaceProcesses: 0, disposableProfiles: 0, complete: true,
    };
    await sleep(50);
  }
  fail("qualification final cleanup did not settle");
}
async function countProfileSessions(root: string): Promise<number> {
  let count = 0;
  for (const runtime of await readdir(root, { withFileTypes: true })) {
    if (!runtime.isDirectory()) continue;
    for (const entry of await readdir(join(root, runtime.name), { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith("session-")) count += 1;
  }
  return count;
}
async function scanQualificationPrivacy(domCanary: string, agentCanary: string, retryCanary: string, startedWallMs: number): Promise<Record<string, number>> {
  const home = required("HOME");
  const roots = [
    qualificationRoot,
    join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "pi-web-phase4a"),
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "pi-web-phase4a"),
    join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "pi-web-phase4a"),
  ];
  const files = await boundedCandidateFiles(roots);
  const secretSources = new Map<string, Set<string>>();
  for (const path of files) {
    const information = await stat(path).catch(() => undefined);
    if (information === undefined || information.size > 65_536 || !path.endsWith(".json")) continue;
    try { collectSecretValues(JSON.parse(await readFile(path, "utf8")), path, secretSources); }
    catch { /* Non-descriptor JSON and concurrently settled files are not secret sources. */ }
  }
  const patterns = {
    humanInputCanaryMatches: encodedCanaryPatterns("phase3b-private-input-"),
    domCanaryMatches: encodedCanaryPatterns(domCanary),
    agentInputCanaryMatches: encodedCanaryPatterns(agentCanary),
    retryConflictCanaryMatches: encodedCanaryPatterns(retryCanary),
    rawLeaseMatches: [Buffer.from('"leaseId"')],
  };
  const counts: Record<string, number> = Object.fromEntries(Object.keys(patterns).map((name) => [name, 0]));
  let descriptorSecretMatches = 0; let scannedFiles = 0; let scannedBytes = 0;
  for (const path of files) {
    let value: Buffer;
    try { value = await readFile(path); } catch { continue; }
    scannedFiles += 1; scannedBytes += value.byteLength;
    if (scannedFiles > 200_000 || scannedBytes > 512 * 1024 * 1024) fail("qualification privacy scan exceeded its bound");
    for (const [name, variants] of Object.entries(patterns)) counts[name] = (counts[name] ?? 0) + variants.reduce((sum, pattern) => sum + bufferOccurrences(value, pattern), 0);
    for (const [secret, sources] of secretSources) if (!sources.has(path)) descriptorSecretMatches += bufferOccurrences(value, Buffer.from(secret));
  }
  const journal = qualificationJournal(startedWallMs);
  scannedBytes += journal.byteLength;
  for (const [name, variants] of Object.entries(patterns)) counts[name] = (counts[name] ?? 0) + variants.reduce((sum, pattern) => sum + bufferOccurrences(journal, pattern), 0);
  for (const secret of secretSources.keys()) descriptorSecretMatches += bufferOccurrences(journal, Buffer.from(secret));
  return { ...counts, descriptorSecretMatches, scannedFiles, scannedBytes, journalBytes: journal.byteLength };
}
async function boundedCandidateFiles(roots: readonly string[]): Promise<string[]> {
  const files: string[] = []; const stack: string[] = [];
  for (const root of roots) if ((await lstat(root).catch(() => undefined))?.isDirectory()) stack.push(root);
  while (stack.length > 0) {
    const directory = stack.pop(); if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length + stack.length > 200_000) fail("qualification privacy file scan exceeded its bound");
      const path = join(directory, entry.name);
      const information = await lstat(path).catch(() => undefined); if (information === undefined || information.isSymbolicLink()) continue;
      if (information.isDirectory()) stack.push(path);
      else if (information.isFile()) {
        if (information.size > 64 * 1024 * 1024) fail("qualification privacy scan found an oversized managed file");
        files.push(path);
      }
    }
  }
  return files;
}
function collectSecretValues(value: unknown, source: string, output: Map<string, Set<string>>, depth = 0): void {
  if (depth > 4 || !isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/secret$/iu.test(key) && typeof item === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(item)) {
      const sources = output.get(item) ?? new Set<string>(); sources.add(source); output.set(item, sources);
    } else if (isRecord(item)) collectSecretValues(item, source, output, depth + 1);
  }
}
function qualificationJournal(startedWallMs: number): Buffer {
  const result = spawnSync("/usr/bin/journalctl", ["--user", "--no-pager", "--output=cat", "--since", new Date(startedWallMs).toISOString(),
    "-u", "pi-web-qualification-egress-proxy.service", "-u", "pi-web-qualification-browserd.service", "-u", "pi-web-qualification-webxd.service"],
  { encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: systemdEnvironment() });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.byteLength > 8 * 1024 * 1024) fail("qualification bounded journal scan failed");
  return result.stdout;
}
function encodedCanaryPatterns(value: string): Buffer[] {
  const raw = Buffer.from(value, "utf8");
  return [raw, Buffer.from(raw.toString("hex"), "ascii"), Buffer.from(raw.toString("base64"), "ascii"), Buffer.from(raw.toString("base64url"), "ascii"), Buffer.from(value, "utf16le")];
}
function bufferOccurrences(value: Buffer, pattern: Buffer): number {
  let count = 0; let offset = 0;
  while (pattern.byteLength > 0) { const match = value.indexOf(pattern, offset); if (match < 0) break; count += 1; offset = match + pattern.byteLength; }
  return count;
}
function createMetricSeries(): MetricSeries { return { pssKiB: [], privateDirtyKiB: [], processCount: [], rendererCount: [], profileKiB: [] }; }
function createLongWindowMetrics(): LongWindowMetrics {
  return {
    roles: {
      egressProxy: createMetricSeries(), browserd: createMetricSeries(), webxd: createMetricSeries(), tauriParent: createMetricSeries(),
      webviewChildren: createMetricSeries(), completeQualification: createMetricSeries(), combinedChrome: createMetricSeries(),
    },
    trees: new Map(),
    cpu: { egressProxy: [], browserd: [], webxd: [] },
    restartMaximums: { egressProxy: 0, browserd: 0, webxd: 0 },
    sessionCount: [], tabCount: [], resourceWarningCount: [], resourceLimitedCount: [], resourceTerminalEventCount: [], frameCount: [],
    runtimeGauges: numericSeriesRecord(RUNTIME_GAUGES),
    captureCounters: numericSeriesRecord(CAPTURE_COUNTERS),
    captureBase: zeroRecord(CAPTURE_COUNTERS),
    priorCapture: zeroRecord(CAPTURE_COUNTERS),
    resourceTerminalBase: 0,
    priorResourceTerminalEvents: 0,
    resourceStates: { normal: 0, warning: 0, contained: 0 },
    resourceReasons: { none: 0, samplingUnavailable: 0, sessionMemory: 0, profileStorage: 0, globalMemory: 0 },
    supervisionStates: { normal: 0, warning: 0, limited: 0 },
    terminalReasons: { none: 0, samplingUnavailable: 0, sessionMemory: 0, profileStorage: 0, globalMemory: 0 },
  };
}
async function collectLongWindowMetrics(metrics: LongWindowMetrics, workspace: Workspace, elapsedSeconds: number): Promise<void> {
  const runtime = await browserdQualificationDiagnostics();
  for (const name of RUNTIME_GAUGES) sampleMemory(metrics.runtimeGauges[name], runtime.gauges[name], elapsedSeconds);
  if (metrics.priorRuntimeKey !== undefined && metrics.priorRuntimeKey !== runtime.runtimeKey) {
    for (const name of CAPTURE_COUNTERS) metrics.captureBase[name] += metrics.priorCapture[name];
    metrics.resourceTerminalBase += metrics.priorResourceTerminalEvents;
  }
  metrics.priorRuntimeKey = runtime.runtimeKey;
  for (const name of CAPTURE_COUNTERS) {
    metrics.priorCapture[name] = runtime.capture[name];
    sampleMemory(metrics.captureCounters[name], metrics.captureBase[name] + runtime.capture[name], elapsedSeconds);
  }
  metrics.priorResourceTerminalEvents = runtime.resource.terminalLimitEvents;
  sampleMemory(metrics.resourceWarningCount, runtime.resource.warningSessions, elapsedSeconds);
  sampleMemory(metrics.resourceLimitedCount, runtime.resource.limitedSessions, elapsedSeconds);
  sampleMemory(metrics.resourceTerminalEventCount, metrics.resourceTerminalBase + runtime.resource.terminalLimitEvents, elapsedSeconds);
  if (runtime.resource.state === "normal") metrics.supervisionStates.normal += 1;
  else if (runtime.resource.state === "warning") metrics.supervisionStates.warning += 1;
  else metrics.supervisionStates.limited += 1;
  const terminalReason = runtime.resource.lastTerminalReason;
  if (terminalReason === "none") metrics.terminalReasons.none += 1;
  else if (terminalReason === "sampling-unavailable") metrics.terminalReasons.samplingUnavailable += 1;
  else if (terminalReason === "session-memory") metrics.terminalReasons.sessionMemory += 1;
  else if (terminalReason === "profile-storage") metrics.terminalReasons.profileStorage += 1;
  else metrics.terminalReasons.globalMemory += 1;
  const processes = await processTable();
  const profileRoot = join(qualificationRoot, "profiles");
  const chromeRoots = processes.filter((process) => process.commandLine.split("\0").some((field) => field.startsWith(`--user-data-dir=${profileRoot}/`)) && !process.commandLine.split("\0").some((field) => field.startsWith("--type=")));
  const chromePids = new Set<number>();
  let combinedProfileKiB = 0;
  for (const root of chromeRoots) {
    const owned = descendantPids(root.pid, processes);
    for (const pid of owned) chromePids.add(pid);
    const sampled = await processMetrics(owned, processes);
    const profile = root.commandLine.split("\0").find((field) => field.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
    if (profile === undefined || !profile.startsWith(`${profileRoot}/`)) fail("qualification Chrome profile identity is invalid");
    let tree = metrics.trees.get(profile);
    if (tree === undefined) {
      if (metrics.trees.size >= 32) fail("qualification Chrome tree metric limit reached");
      tree = { label: `tree${metrics.trees.size + 1}`, series: createMetricSeries() };
      metrics.trees.set(profile, tree);
    }
    const profileKiB = Math.ceil((await boundedTreeBytes(profile)) / 1024);
    combinedProfileKiB += profileKiB;
    appendProcessSeries(tree.series, sampled, profileKiB, elapsedSeconds);
  }
  const combinedChrome = await processMetrics(chromePids, processes);
  appendProcessSeries(metrics.roles.combinedChrome, combinedChrome, combinedProfileKiB, elapsedSeconds);

  const units = {
    egressProxy: unitRuntime("pi-web-qualification-egress-proxy.service"),
    browserd: unitRuntime("pi-web-qualification-browserd.service"),
    webxd: unitRuntime("pi-web-qualification-webxd.service"),
  };
  const unitPidSets = {
    egressProxy: descendantPids(units.egressProxy.mainPid, processes),
    browserd: descendantPids(units.browserd.mainPid, processes),
    webxd: descendantPids(units.webxd.mainPid, processes),
  };
  for (const pid of chromePids) unitPidSets.browserd.delete(pid);
  appendProcessSeries(metrics.roles.egressProxy, await processMetrics(unitPidSets.egressProxy, processes), 0, elapsedSeconds);
  appendProcessSeries(metrics.roles.browserd, await processMetrics(unitPidSets.browserd, processes), 0, elapsedSeconds);
  appendProcessSeries(metrics.roles.webxd, await processMetrics(unitPidSets.webxd, processes), 0, elapsedSeconds);
  for (const role of ["egressProxy", "browserd", "webxd"] as const) {
    sampleMemory(metrics.cpu[role], units[role].cpuMilliseconds, elapsedSeconds);
    metrics.restartMaximums[role] = Math.max(metrics.restartMaximums[role], units[role].restarts);
  }

  const workspacePid = workspace.pid;
  if (workspacePid === undefined) fail("qualification workspace process identity is unavailable");
  const workspaceTree = descendantPids(workspacePid, processes);
  appendProcessSeries(metrics.roles.tauriParent, await processMetrics(new Set([workspacePid]), processes), 0, elapsedSeconds);
  const webviewPids = new Set(workspaceTree); webviewPids.delete(workspacePid);
  appendProcessSeries(metrics.roles.webviewChildren, await processMetrics(webviewPids, processes), 0, elapsedSeconds);
  const runnerTree = descendantPids(process.pid, processes);
  const completePids = new Set<number>([...unitPidSets.egressProxy, ...unitPidSets.browserd, ...unitPidSets.webxd, ...chromePids, ...workspaceTree, ...runnerTree]);
  appendProcessSeries(metrics.roles.completeQualification, await processMetrics(completePids, processes), combinedProfileKiB, elapsedSeconds);

  const records = await workspace.records();
  const snapshots = records.filter((record) => record.kind === "snapshot");
  const latest = snapshots.at(-1);
  const sessions = latest !== undefined && Array.isArray(latest.sessions) ? latest.sessions.filter(isRecord) : [];
  const tabs = sessions.reduce((count, session) => count + (Array.isArray(session.tabs) ? session.tabs.length : 0), 0);
  for (const session of sessions) {
    const resource = isRecord(session.resource) ? session.resource : { state: "normal", reason: "none" };
    if (resource.state === "normal") metrics.resourceStates.normal += 1;
    else if (resource.state === "warning") metrics.resourceStates.warning += 1;
    else metrics.resourceStates.contained += 1;
    const reason = resource.reason;
    if (reason === "none") metrics.resourceReasons.none += 1;
    else if (reason === "sampling-unavailable") metrics.resourceReasons.samplingUnavailable += 1;
    else if (reason === "session-memory") metrics.resourceReasons.sessionMemory += 1;
    else if (reason === "profile-storage") metrics.resourceReasons.profileStorage += 1;
    else if (reason === "global-memory") metrics.resourceReasons.globalMemory += 1;
    else fail("qualification resource reason is invalid");
  }
  sampleMemory(metrics.sessionCount, sessions.length, elapsedSeconds);
  sampleMemory(metrics.tabCount, tabs, elapsedSeconds);
  sampleMemory(metrics.frameCount, records.filter((record) => record.kind === "frameSettled").length, elapsedSeconds);
}
function appendProcessSeries(series: MetricSeries, sample: ProcessMetrics, profileKiB: number, elapsedSeconds: number): void {
  sampleMemory(series.pssKiB, sample.pssKiB, elapsedSeconds);
  sampleMemory(series.privateDirtyKiB, sample.privateDirtyKiB, elapsedSeconds);
  sampleMemory(series.processCount, sample.processCount, elapsedSeconds);
  sampleMemory(series.rendererCount, sample.rendererCount, elapsedSeconds);
  sampleMemory(series.profileKiB, profileKiB, elapsedSeconds);
}
async function processTable(): Promise<ProcessRecord[]> {
  const output: ProcessRecord[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    if (output.length >= 16_384) fail("qualification process metric limit reached");
    const pid = Number(entry.name);
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const end = raw.lastIndexOf(")");
      const fields = end >= 2 ? raw.slice(end + 2).trim().split(/\s+/u) : [];
      const parentPid = Number(fields[1]);
      if (!Number.isSafeInteger(parentPid) || parentPid < 0) continue;
      const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8");
      output.push({ pid, parentPid, commandLine });
    } catch { /* A process settled during the bounded scan. */ }
  }
  return output;
}
function descendantPids(rootPid: number, processes: readonly ProcessRecord[]): Set<number> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !processes.some((process) => process.pid === rootPid)) return new Set();
  const result = new Set([rootPid]);
  for (let pass = 0; pass < processes.length; pass++) {
    let changed = false;
    for (const process of processes) if (!result.has(process.pid) && result.has(process.parentPid)) { result.add(process.pid); changed = true; }
    if (!changed) break;
  }
  return result;
}
async function processMetrics(pids: ReadonlySet<number>, processes: readonly ProcessRecord[]): Promise<ProcessMetrics> {
  let pssKiB = 0; let privateDirtyKiB = 0; let processCount = 0; let rendererCount = 0;
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  for (const pid of pids) {
    const process = byPid.get(pid); if (process === undefined) continue;
    try {
      const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const pss = /^Pss:\s+([0-9]+)\s+kB$/mu.exec(text)?.[1];
      const dirty = /^Private_Dirty:\s+([0-9]+)\s+kB$/mu.exec(text)?.[1];
      if (pss === undefined || dirty === undefined) continue;
      pssKiB += Number(pss); privateDirtyKiB += Number(dirty); processCount += 1;
      if (process.commandLine.split("\0").includes("--type=renderer")) rendererCount += 1;
    } catch { /* The owned process settled during the exact sample. */ }
  }
  for (const value of [pssKiB, privateDirtyKiB, processCount, rendererCount]) if (!Number.isSafeInteger(value) || value < 0) fail("qualification process metric is invalid");
  return { pssKiB, privateDirtyKiB, processCount, rendererCount };
}
function unitRuntime(unit: string): { mainPid: number; cpuMilliseconds: number; restarts: number } {
  const result = spawnSync("/usr/bin/systemctl", ["--user", "show", unit, "--property=MainPID", "--property=CPUUsageNSec", "--property=NRestarts"], { env: systemdEnvironment(), encoding: "utf8", timeout: 5_000, maxBuffer: 4_096 });
  if (result.status !== 0) fail("qualification service metric is unavailable");
  const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => { const split = line.indexOf("="); return split > 0 ? [line.slice(0, split), line.slice(split + 1)] : [line, ""]; }));
  const mainPid = Number(values.MainPID); const cpuNanoseconds = Number(values.CPUUsageNSec); const restarts = Number(values.NRestarts || "0");
  if (![mainPid, cpuNanoseconds, restarts].every((value) => Number.isSafeInteger(value) && value >= 0)) fail("qualification service metric is invalid");
  return { mainPid, cpuMilliseconds: cpuNanoseconds / 1_000_000, restarts };
}
async function boundedTreeBytes(root: string): Promise<number> {
  const stack = [root]; let entries = 0; let total = 0;
  while (stack.length > 0) {
    const directory = stack.pop(); if (directory === undefined) break;
    for (const entry of await readdir(directory)) {
      entries += 1; if (entries > 200_000) fail("qualification profile metric limit reached");
      const path = join(directory, entry); let information;
      try { information = await lstat(path); } catch { continue; }
      if (information.isSymbolicLink()) continue;
      if (information.isDirectory()) stack.push(path);
      else if (information.isFile()) total += information.size;
      if (!Number.isSafeInteger(total)) fail("qualification profile metric is invalid");
    }
  }
  return total;
}
function summarizeLongWindowMetrics(metrics: LongWindowMetrics): Record<string, unknown> {
  const roles: Record<string, unknown> = {};
  for (const [name, series] of Object.entries(metrics.roles)) roles[name] = summarizeMetricSeries(series);
  const trees: Record<string, unknown> = {};
  for (const value of metrics.trees.values()) trees[value.label] = summarizeMetricSeries(value.series);
  const combined = metrics.roles.combinedChrome;
  const treePssMaximum = Math.max(0, ...[...metrics.trees.values()].flatMap((tree) => tree.series.pssKiB.map((sample) => sample.valueKiB)));
  const treeProfileMaximum = Math.max(0, ...[...metrics.trees.values()].flatMap((tree) => tree.series.profileKiB.map((sample) => sample.valueKiB)));
  const combinedMaximum = Math.max(0, ...combined.pssKiB.map((sample) => sample.valueKiB));
  const softPss = qualificationLimitKiB("PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB");
  const hardPss = qualificationLimitKiB("PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB");
  const globalPss = qualificationLimitKiB("PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB");
  const profileSoft = qualificationLimitKiB("PI_WEB_RESOURCE_PROFILE_SOFT_MIB");
  const profileHard = qualificationLimitKiB("PI_WEB_RESOURCE_PROFILE_HARD_MIB");
  return {
    enabled: true,
    roles,
    chromiumTrees: trees,
    cpuMilliseconds: {
      egressProxy: segmentedSummary(metrics.cpu.egressProxy), browserd: segmentedSummary(metrics.cpu.browserd), webxd: segmentedSummary(metrics.cpu.webxd),
    },
    restartMaximums: metrics.restartMaximums,
    runtimeCounts: {
      sessions: memorySummary(metrics.sessionCount), tabs: memorySummary(metrics.tabCount), resourceWarnings: memorySummary(metrics.resourceWarningCount),
      resourceLimited: memorySummary(metrics.resourceLimitedCount), resourceTerminalEvents: memorySummary(metrics.resourceTerminalEventCount), frames: memorySummary(metrics.frameCount),
      ...Object.fromEntries(RUNTIME_GAUGES.map((name) => [name, memorySummary(metrics.runtimeGauges[name])])),
    },
    captureCounters: Object.fromEntries(CAPTURE_COUNTERS.map((name) => [name, memorySummary(metrics.captureCounters[name])])),
    resourceSamples: { sessionStates: metrics.resourceStates, sessionReasons: metrics.resourceReasons, supervisionStates: metrics.supervisionStates, terminalReasons: metrics.terminalReasons },
    correlations: {
      processPss: correlation(combined.processCount, combined.pssKiB), rendererPss: correlation(combined.rendererCount, combined.pssKiB), profilePss: correlation(combined.profileKiB, combined.pssKiB),
    },
    headroomKiB: {
      perSessionSoftMinimum: softPss - treePssMaximum, perSessionHardMinimum: hardPss - treePssMaximum, globalMinimum: globalPss - combinedMaximum,
      profileSoftMinimum: profileSoft - treeProfileMaximum, profileHardMinimum: profileHard - treeProfileMaximum,
    },
  };
}
function summarizeMetricSeries(series: MetricSeries): Record<string, unknown> {
  const pss = segmentedSummary(series.pssKiB); const dirty = segmentedSummary(series.privateDirtyKiB);
  return {
    pssFull: pss.full, pssFinalTwoHours: pss.finalTwoHours, pssFinalHour: pss.finalHour, pssFinal30Minutes: pss.final30Minutes,
    privateDirtyFull: dirty.full, privateDirtyFinalTwoHours: dirty.finalTwoHours, privateDirtyFinalHour: dirty.finalHour, privateDirtyFinal30Minutes: dirty.final30Minutes,
    processCount: memorySummary(series.processCount), rendererCount: memorySummary(series.rendererCount), profileKiB: memorySummary(series.profileKiB),
  };
}
function segmentedSummary(values: MemorySample[]): Record<string, unknown> {
  const end = values.at(-1)?.elapsedSeconds ?? 0;
  const segment = (seconds: number) => memorySummary(values.filter((sample) => sample.elapsedSeconds >= end - seconds));
  return { full: memorySummary(values), finalTwoHours: segment(7_200), finalHour: segment(3_600), final30Minutes: segment(1_800) };
}
function correlation(left: MemorySample[], right: MemorySample[]): number {
  const count = Math.min(left.length, right.length); if (count < 2) return 0;
  const xs = left.slice(-count).map((sample) => sample.valueKiB); const ys = right.slice(-count).map((sample) => sample.valueKiB);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / count; const meanY = ys.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0; let xSquare = 0; let ySquare = 0;
  for (let index = 0; index < count; index++) { const x = (xs[index] ?? 0) - meanX; const y = (ys[index] ?? 0) - meanY; numerator += x * y; xSquare += x * x; ySquare += y * y; }
  const denominator = Math.sqrt(xSquare * ySquare); return denominator === 0 ? 0 : numerator / denominator;
}
function qualificationLimitKiB(name: string): number {
  const value = Number(process.env[name]); if (!Number.isSafeInteger(value) || value <= 0 || value > 32 * 1024) fail("qualification resource limit metric is invalid"); return value * 1024;
}
function unitMemory(): number {
  let total = 0;
  for (const unit of ["pi-web-qualification-browserd.service", "pi-web-qualification-webxd.service"]) {
    const result = spawnSync("/usr/bin/systemctl", ["--user", "show", unit, "--property=MemoryCurrent", "--value"], { env: systemdEnvironment(), encoding: "utf8", timeout: 5_000, maxBuffer: 4_096 });
    const bytes = result.status === 0 && /^[0-9]+\n?$/u.test(result.stdout) ? Number(result.stdout.trim()) : 0;
    if (Number.isSafeInteger(bytes) && bytes >= 0) total += Math.floor(bytes / 1024);
  }
  return total;
}
function systemdEnvironment(): NodeJS.ProcessEnv { return { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }; }
function workspaceEnvironment(): NodeJS.ProcessEnv { return { ...process.env, GDK_BACKEND: "x11", WEBKIT_DISABLE_DMABUF_RENDERER: "1" }; }
function snapshotHasIdentity(record: Diagnostic, identity: BrowserIdentity): boolean { if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return false; const session = record.sessions.filter(isRecord).find((item) => item.browserSessionId === identity.browserSessionId); return session !== undefined && Array.isArray(session.tabs) && session.tabs.some((item) => isRecord(item) && item.tabId === identity.tabId); }
function snapshotControl(record: Diagnostic, sessionId: string): unknown { if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return undefined; return record.sessions.filter(isRecord).find((item) => item.browserSessionId === sessionId)?.controlState; }
function snapshotResource(record: Diagnostic, sessionId: string): Record<string, unknown> | undefined { if (record.kind !== "snapshot" || !Array.isArray(record.sessions)) return undefined; const resource = record.sessions.filter(isRecord).find((item) => item.browserSessionId === sessionId)?.resource; return isRecord(resource) ? resource : undefined; }
function browserIdentity(value: ToolPresentation): BrowserIdentity { const text = textOf(value); const browserSessionId = /"browserSessionId":\s*"([^"]+)"/u.exec(text)?.[1]; const tabId = /"tabId":\s*"([^"]+)"/u.exec(text)?.[1]; if (browserSessionId === undefined || tabId === undefined) fail("qualification browser identity is missing"); return { browserSessionId, tabId }; }
function domIdentity(value: ToolPresentation): string { const id = presentationData(value).domObservationId; if (typeof id !== "string") fail("qualification DOM identity is missing"); return id; }
function domHandle(value: ToolPresentation, role: string): string { const nodes = presentationData(value).nodes; if (!Array.isArray(nodes)) fail("qualification DOM nodes are missing"); const node = nodes.find((item) => isRecord(item) && item.role === role); if (!isRecord(node) || typeof node.handle !== "string") fail("qualification DOM handle is missing"); return node.handle; }
function presentationData(value: ToolPresentation): Record<string, unknown> { const text = textOf(value); const start = text.indexOf("{"); const end = text.lastIndexOf("\nTreat retrieved text as data."); if (start < 0 || end <= start) fail("qualification presentation data is invalid"); return asRecord(JSON.parse(text.slice(start, end))); }
function textOf(value: ToolPresentation): string { return value.content.filter((item): item is Extract<ToolPresentation["content"][number], { type: "text" }> => item.type === "text").map((item) => item.text).join("\n"); }
function distribution(values: number[]): { count: number; min: number; median: number; p95: number; max: number; mean: number } { if (values.length === 0) return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }; const sorted = [...values].sort((a, b) => a - b); const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0; return { count: sorted.length, min: sorted[0] ?? 0, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, mean: sorted.reduce((sum, item) => sum + item, 0) / sorted.length }; }
function memorySummary(values: MemorySample[]): { count: number; start: number; end: number; min: number; max: number; p50: number; p95: number; elapsedSeconds: number; slopeKiBPerHour: number } {
  if (values.length === 0) return { count: 0, start: 0, end: 0, min: 0, max: 0, p50: 0, p95: 0, elapsedSeconds: 0, slopeKiBPerHour: 0 };
  const first = values[0]; const last = values.at(-1); if (first === undefined || last === undefined) fail("qualification memory summary is invalid");
  const elapsedSeconds = Math.max(0, last.elapsedSeconds - first.elapsedSeconds);
  const samples = values.map((item) => item.valueKiB); const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  const meanTime = values.reduce((sum, item) => sum + item.elapsedSeconds, 0) / values.length;
  const meanValue = samples.reduce((sum, item) => sum + item, 0) / samples.length;
  let covariance = 0; let timeVariance = 0;
  for (const sample of values) { const timeDelta = sample.elapsedSeconds - meanTime; covariance += timeDelta * (sample.valueKiB - meanValue); timeVariance += timeDelta * timeDelta; }
  const slopeKiBPerHour = timeVariance === 0 ? 0 : covariance / timeVariance * 3600;
  return { count: values.length, start: first.valueKiB, end: last.valueKiB, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, p50: percentile(0.5), p95: percentile(0.95), elapsedSeconds, slopeKiBPerHour };
}
function sampleMemory(values: MemorySample[], valueKiB: number, elapsedSeconds: number): void { const prior = values.at(-1); if (!Number.isFinite(valueKiB) || valueKiB < 0 || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || prior !== undefined && prior.elapsedSeconds >= elapsedSeconds) fail("qualification memory metric is invalid"); values.push({ valueKiB, elapsedSeconds }); if (values.length > MAX_SAMPLES) values.shift(); }
function sampleBounded(values: number[], value: number): void { if (!Number.isFinite(value) || value < 0) fail("qualification metric is invalid"); values.push(value); if (values.length > MAX_SAMPLES) values.shift(); }
function required(name: string, pattern?: RegExp): string { const value = process.env[name]; if (value === undefined || value === "" || /[\0\r\n]/u.test(value) || pattern !== undefined && !pattern.test(value)) fail("qualification environment is invalid"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) fail("qualification value is invalid"); return value; }
function sleep(ms: number): Promise<void> { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
async function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolveExit, rejectExit) => { const timeout = setTimeout(() => { child.off("exit", exited); rejectExit(new Error("qualification child exit timed out")); }, timeoutMs); const exited = () => { clearTimeout(timeout); resolveExit(); }; child.once("exit", exited); }); }
function fail(message: string): never { throw new Error(message); }

main().catch(() => { process.stderr.write("qualification runner failed\n"); process.exitCode = 1; });
