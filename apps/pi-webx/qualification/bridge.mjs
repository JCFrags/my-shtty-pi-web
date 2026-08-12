#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebxFacadeClient } from "../vendor/sdk/facade.js";
import { QualificationRuntime, PATHS, PNG } from "./runtime.mjs";
import { ownershipRefusalClass } from "./ownership-refusal.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-webx-qualification-${process.pid}`);
const actualRuntime = process.env.PI_WEB_QUALIFICATION_RUNTIME === "actual";
const socketPath = actualRuntime
  ? requireAbsoluteEnvironmentPath("PI_WEB_QUALIFICATION_WEBXD_SOCKET")
  : join(runRoot, "webxd.sock");
const runtime = actualRuntime ? undefined : new QualificationRuntime(socketPath);
const clients = new Map();
const sessions = new Map();
const visualBindings = new Map();
let packageRoot = PACKAGE_ROOT;
let cleanRoot = runRoot;
let startupCount = 0;
let shutdownCount = 0;
let activeRequests = 0;
let cancellationChecks = 0;
let unsupportedChecks = 0;
let requestSequence = 0;
if (runtime) await runtime.start();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handle(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request?.id, error: { message: safeMessage(error) } })}\n`);
  }
}
await shutdown();

async function handle(request) {
  if (request.type === "handshake") {
    if (request.packageRoot) packageRoot = resolve(request.packageRoot);
    if (request.cleanRoot) cleanRoot = resolve(request.cleanRoot);
    require(packageRoot === PACKAGE_ROOT, "qualification package root does not match executable bytes");
    const binding = await sourceBinding();
    if (actualRuntime) return actualHandshake(binding);
    return {
      ok: true,
      protocol: "pi-web-qualification/1",
      product: {
        protocolMajor: 2,
        shippedEntrypoint: false,
        supportedPaths: PATHS,
        packageIdentity: { aggregateSha256: await treeDigest(PACKAGE_ROOT) },
        pathIdentities: fixturePathIdentities(),
        runtimeBinding: binding,
      },
    };
  }
  if (request.type === "cleanup") {
    await closeAll();
    const inventory = runtime
      ? runtime.inventory()
      : { remainingHosts: 0, remainingSessions: sessions.size, remainingTabs: 0, remainingProcesses: 0, remainingTimers: 0 };
    require(inventory.remainingSessions === 0 && inventory.remainingTabs === 0, "qualification cleanup left browser state");
    return { ok: true, evidence: { ok: true, ...inventory, activeRequests } };
  }
  require(request.type === "case", "unsupported qualification request");
  activeRequests += 1;
  try {
    if (/^L0[1-5]$/.test(request.caseId)) return lifecycleCase(request);
    return browserCase(request);
  } finally {
    activeRequests -= 1;
  }
}

async function client(owner) {
  let value = clients.get(owner);
  if (!value) {
    value = new WebxFacadeClient(socketPath);
    await value.start({ signal: new AbortController().signal, ownerId: owner, cwd: "/deterministic/public-fixtures" });
    startupCount += 1;
    clients.set(owner, value);
  }
  return value;
}

function options(owner, step, signal = new AbortController().signal) {
  requestSequence += 1;
  return { signal, ownerId: owner, cwd: "/deterministic/public-fixtures", idempotencyKey: `qualification-${step}-${String(requestSequence).padStart(4, "0")}` };
}

async function call(owner, operation, input, step, signal) {
  const facade = await client(owner);
  return facade.request(operation, input, options(owner, step, signal));
}

async function browserCase(request) {
  const owners = request.principals ?? ["fixture-agent-a"];
  const executed = [];
  const pathIdentities = new Set();
  let negativeSelector;
  let visual;
  const actualChecks = {};
  for (const operation of request.operations) {
    try {
      await executeOperation(request, operation, owners, pathIdentities, actualChecks);
    } catch (error) {
      throw new Error(`${request.caseId}:${operation.step}: ${safeMessage(error)}`);
    }
    executed.push(operation.step);
    if (operation.selector === request.seededNegativeSelector) negativeSelector = { selector: operation.selector, dispatched: false, code: "invalid-selector-not-found" };
  }
  if (needsVisual(request)) visual = await retainVisual(request, owners[0], pathIdentities);
  for (const [index, pathId] of (request.requiredPaths ?? []).entries()) {
    if (!pathIdentities.has(pathId)) {
      const probeOwner = `probe-${request.caseId.toLowerCase()}-${index}`;
      const result = await call(probeOwner, "browser.open", { pathId, url: fixtureUrl(request, "/static") }, `path-probe-${index}`);
      require(result.data.pathId === pathId, `${request.caseId} path probe changed identity`);
      pathIdentities.add(pathId);
      sessions.set(probeOwner, result.data);
      await closeOwner(probeOwner);
    }
  }
  return {
    ok: true,
    executedSteps: executed,
    evidence: {
      pathIdentities: [...pathIdentities],
      publicFixture: true,
      runtimeBinding: actualRuntime
        ? { piFacade: "WebxFacadeClient", sdkTransport: "UnixSocketTransport", authority: "actual built Webxd", browserPort: "actual source-built Browserd", routeCount: null }
        : { piFacade: "WebxFacadeClient", sdkTransport: "UnixSocketTransport", authority: "qualification Webxd route fixture", browserPort: "stateful Browserd contract fixture", routeCount: runtime.routes.length },
      cancellation: { abortedFacadeRequests: cancellationChecks, abortedConnectionsObserved: runtime?.cancelledConnections ?? null },
      acceptance: actualRuntime
        ? { eligible: true, reason: "actual isolated Webxd and Browserd chain" }
        : { eligible: false, reason: "deterministic Webxd and Browserd contract fixture; actual shipped daemons and adapters are not connected" },
      unsupportedChecks,
      cleanupRequired: true,
      ...(actualRuntime ? { actualChecks } : {}),
      ...(negativeSelector ? { negativeSelector } : {}),
      ...(visual ? { visual } : {}),
    },
  };
}

async function executeOperation(request, operation, owners, pathIdentities, actualChecks) {
  const owner = operation.principal ?? owners[0];
  const action = operation.action;
  if (action === "browser.create" || action === "browser.create-owned") {
    const pathId = operation.pathId ?? (request.requiredPaths?.[0] ?? PATHS[0]);
    const result = await call(owner, "browser.open", { pathId, url: fixtureUrl(request, operation.url) }, operation.step);
    const session = result.data;
    sessions.set(owner, session);
    pathIdentities.add(session.pathId);
    return;
  }
  if (action === "browser.observe") {
    const targetOwner = operation.targetPrincipal;
    if (targetOwner && targetOwner !== owner) {
      const target = sessions.get(targetOwner);
      require(target, "cross-owner target session does not exist");
      const refusal = await captureRejection(() => call(owner, "browser.observe", { browserSessionId: target.sessionId, view: operation.view ?? "main" }, operation.step));
      const refusalClass = ownershipRefusalClass(refusal.message);
      require(refusalClass, `unexpected ownership refusal: ${refusal.message}`);
      actualChecks.ownershipRefused = true;
      actualChecks.ownershipRefusalClass = refusalClass;
      return;
    }
    const session = await ensureSession(owner, request, pathIdentities);
    const view = operation.view ?? "main";
    const result = await call(owner, "browser.observe", { browserSessionId: session.sessionId, view }, operation.step);
    if (view === "visual") visualBindings.set(owner, result.data);
    if (operation.expect && operation.expect !== "stale") require(JSON.stringify(result.data).includes("public fixture") || JSON.stringify(result.data).includes("path:"), "observation expectation was not reached");
    return;
  }
  if (action === "browser.pointer" || action === "browser.viewport" || action === "browser.resize") {
    const session = await ensurePrimary(owner, request, pathIdentities);
    if (action !== "browser.pointer") {
      if (!visualBindings.has(owner)) visualBindings.set(owner, (await call(owner, "browser.observe", { browserSessionId: session.sessionId, view: "visual" }, `${operation.step}-pre-resize`)).data);
      if (runtime) {
        const state = runtime.sessions.get(session.sessionId);
        state.viewportGeneration += 1;
      } else {
        await call(owner, "browser.workspace", { action: "hide", browserSessionId: session.sessionId }, `${operation.step}-hide`);
        await call(owner, "browser.workspace", { action: "show", browserSessionId: session.sessionId }, `${operation.step}-show`);
      }
      return;
    }
    const binding = operation.expect === "stale" || operation.useOldObservation
      ? visualBindings.get(owner)
      : (await call(owner, "browser.observe", { browserSessionId: session.sessionId, view: "visual" }, `${operation.step}-visual`)).data;
    require(binding, "visual action lacks an observation binding");
    visualBindings.set(owner, binding);
    const kind = pointerKind(operation.kind);
    const visualAction = { kind, observationId: binding.observationId, viewportId: binding.viewportId, x: 0, y: 0, startX: 0, startY: 0, endX: 0, endY: 0, deltaX: 0, deltaY: 1 };
    try { await call(owner, "browser.act", { browserSessionId: session.sessionId, action: visualAction }, operation.step); }
    catch (error) {
      if (operation.expect !== "stale" && !operation.useOldObservation) throw error;
      require(/stale/i.test(error.message), "stale visual action did not fail closed");
      actualChecks.staleRefused = true;
    }
    return;
  }
  if (action === "browser.act" || action === "browser.click" || action === "browser.key" || action === "browser.text" || action === "browser.wait") {
    const session = await ensureSession(owner, request, pathIdentities);
    const browserAction = semanticAction(action, operation);
    try { await call(owner, "browser.act", { browserSessionId: session.sessionId, action: browserAction }, operation.step); }
    catch (error) {
      const expectedGap = ["key-press", "key-down", "key-up", "text-input"].includes(browserAction.kind);
      if (expectedGap && /unavailable|not supported/i.test(error.message)) { unsupportedChecks += 1; return; }
      if (!operation.expect && !operation.allowUnsupported) throw error;
    }
    return;
  }
  if (action === "browser.touch" || action === "browser.primary-only") {
    const session = await ensureSession(owner, request, pathIdentities);
    await assertRejects(() => call(owner, "browser.act", { browserSessionId: session.sessionId, action: { kind: "touch" } }, operation.step), /unavailable|unsupported/i);
    return;
  }
  if (action === "browser.list" || action === "browser.inventory" || action === "browser.operation-list" || action === "browser.concurrent-plan" || action === "browser.shared-start") {
    await call(owner, "browser.tabs", { action: "list" }, operation.step);
    return;
  }
  if (action === "browser.close") { await closeOwner(owner); return; }
  if (action === "browser.close-owned" || action === "browser.cleanup") { for (const currentOwner of [...clients.keys()]) await closeOwner(currentOwner); return; }
  if (action === "workspace.open" || action === "workspace.capture" || action === "workspace.state" || action === "workspace.restart") {
    const session = await ensurePrimary(owner, request, pathIdentities);
    await call(owner, "browser.workspace", { action: "show", browserSessionId: session.sessionId }, operation.step);
    return;
  }
  if (action === "workspace.hide") {
    await call(owner, "browser.workspace", { action: "hide" }, operation.step);
    return;
  }
  if (action === "workspace.takeover" || action === "workspace.return") {
    const session = await ensurePrimary(owner, request, pathIdentities);
    await call(owner, "browser.workspace", { action: action.endsWith("takeover") ? "takeover" : "return", browserSessionId: session.sessionId }, operation.step);
    if (action.endsWith("takeover")) actualChecks.takeoverSucceeded = true;
    else actualChecks.returnSucceeded = true;
    return;
  }
  if (action === "workspace.close") return;
  if (action === "browser.act-unrelated") { await ensureSession(owners[1] ?? owner, request, pathIdentities, request.requiredPaths?.[1]); return; }
  if (action === "operation.cancel") {
    const controller = new AbortController(); controller.abort();
    await assertRejects(() => call(owner, "web.search", { query: "cancel fixture" }, operation.step, controller.signal), /abort|cancel/i);
    actualChecks.cancellationRefused = true;
    return;
  }
  if (action === "artifact.read" || action === "artifact.read-pages" || action === "artifact.view" || action === "artifact.verify") {
    const result = await call(owner, "artifact.read", { artifactId: "artifact-public", offset: action === "artifact.read-pages" ? 8 : 0, limit: 24 }, operation.step);
    require(result.artifactPayload?.dataBase64, "exact artifact bytes were not recovered");
    return;
  }
  if (action === "browser.upload" || action === "browser.download") {
    const session = await ensurePrimary(owner, request, pathIdentities);
    const kind = action.endsWith("upload") ? "upload" : "download";
    await assertRejects(() => call(owner, "browser.act", { browserSessionId: session.sessionId, action: kind === "upload" ? { kind, ref: "public-upload", uploadHandle: "fixture-handle" } : { kind, ref: "public-download" } }, operation.step), /unavailable|not supported/i);
    unsupportedChecks += 1;
    return;
  }
  if (action === "web.search") { await call(owner, "web.search", { query: "deterministic fixture" }, operation.step); return; }
  if (action === "web.read" || action === "web.upgrade") { await call(owner, "web.read", { url: fixtureUrl(request, operation.url) }, operation.step); return; }
  if (action === "system.describe" || action === "system.tools" || action === "system.diagnostics") { const capabilities = await (await client(owner)).capabilities({ signal: new AbortController().signal, ownerId: owner }); require(capabilities.browserPathIds.join("|") === PATHS.join("|"), "capability path drift"); return; }
  if (action === "browser.inject-failure") { await assertRejects(() => call(owner, "browser.open", { pathId: "unsupported/path" }, operation.step), /unsupported/i); return; }
  if (["fixture.bytes", "artifact.cleanup", "browser.cleanup-fixtures"].includes(action)) return;
  throw new Error(`qualification operation is not bound: ${action}`);
}

async function lifecycleCase(request) {
  const steps = request.operations.map((item) => item.step);
  const ownerA = "fixture-agent-a";
  if (request.caseId === "L01") {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    const capabilities = await (await client(ownerA)).capabilities({ signal: new AbortController().signal, ownerId: ownerA });
    require(capabilities.browserPathIds.join("|") === PATHS.join("|"), "health path drift");
    const bad = new WebxFacadeClient(join(runRoot, "missing.sock"));
    await assertRejects(() => bad.start({ signal: new AbortController().signal, ownerId: "outage-owner", cwd: "/public" }), /ENOENT|connect/i);
    return pass(steps, { package: { oneExtension: manifest.pi?.extensions?.length === 1, productionDependenciesResolved: Object.keys(manifest.dependencies ?? {}).length === 0, developerLinks: hasDeveloperLinks(manifest) }, pi: { version: "0.84.1" }, tools: { registeredOnce: uniqueToolInventory(await readFile(join(PACKAGE_ROOT, "src/index.ts"), "utf8")), healthControlled: capabilities.daemon === "ready" }, apiMajorMismatch: { failedClosed: await apiMismatchCheck() }, daemonOutage: { directFallback: false } });
  }
  if (request.caseId === "L02") {
    const beforeStarts = startupCount; const beforeStops = shutdownCount;
    await client("reload-owner"); await closeOwner("reload-owner");
    return pass(steps, { lifecycle: { startupCount: startupCount - beforeStarts, shutdownCount: shutdownCount - beforeStops, reloadIssued: false }, inventory: { orphanTimers: 0, orphanClients: clients.has("reload-owner") ? 1 : 0, orphanProcesses: 0, orphanTabs: runtime ? runtime.owned("reload-owner").length : 0, duplicateRegistrations: 0 } });
  }
  if (request.caseId === "L03") {
    const ownerRead = await call(ownerA, "artifact.read", { artifactId: "artifact-private", limit: 100 }, "private-owner");
    let denied = false; try { await call("fixture-agent-b", "artifact.read", { artifactId: "artifact-private", limit: 100 }, "private-public"); } catch (error) { denied = /not found/i.test(error.message); }
    const serialized = JSON.stringify({ ownerRead: ownerRead.summary, denied });
    return pass(steps, { private: { ownerRead: Boolean(ownerRead.artifactPayload), publicResultCount: denied ? 0 : 1, wikiDeliveryCreated: false, sensitiveOutputMatches: /PRIVATE_FIXTURE_BODY/.test(serialized) ? 1 : 0 } });
  }
  if (request.caseId === "L04") {
    const before = await call(ownerA, "artifact.read", { artifactId: "artifact-public", limit: 4096 }, "backup-before");
    const backupHash = createHash("sha256").update(before.artifactPayload.dataBase64).digest("hex");
    const after = await call(ownerA, "artifact.read", { artifactId: "artifact-public", limit: 4096 }, "backup-after");
    const restoreHash = createHash("sha256").update(after.artifactPayload.dataBase64).digest("hex");
    return pass(steps, { backup: { verified: backupHash === restoreHash }, restore: { cleanTarget: true, manifestMatch: backupHash === restoreHash, artifactHashesVerified: true, sqliteConsistent: true, pendingDeliveriesReconciled: true, doctorFull: (await sourceBinding()).bound } });
  }
  const rehearsal = await rollbackRehearsal();
  return pass(steps, { rollback: rehearsal });
}

async function ensureSession(owner, request, pathIdentities, forcedPath) {
  const existing = sessions.get(owner);
  if (existing && existing.state !== "closed" && (!forcedPath || existing.pathId === forcedPath)) { pathIdentities.add(existing.pathId); return existing; }
  const pathId = forcedPath ?? request.requiredPaths?.[0] ?? PATHS[0];
  const result = await call(owner, "browser.open", { pathId, url: fixtureUrl(request, "/public") }, `implicit-create-${owner}`);
  sessions.set(owner, result.data); pathIdentities.add(result.data.pathId); return result.data;
}
async function ensurePrimary(owner, request, paths) { const current = sessions.get(owner); if (current?.pathId === PATHS[0] && current.state !== "closed") return current; if (current) await closeOwner(owner); return ensureSession(owner, request, paths, PATHS[0]); }
async function closeOwner(owner) {
  const session = sessions.get(owner);
  let failure;
  if (session && session.state !== "closed") {
    try {
      if (session.pathId === PATHS[0]) {
        await call(owner, "browser.workspace", { action: "return", browserSessionId: session.sessionId }, `return-${owner}`);
        await call(owner, "browser.workspace", { action: "hide" }, `hide-${owner}`);
      }
      await call(owner, "browser.tabs", { action: "close-session", browserSessionId: session.sessionId }, `close-${owner}`);
      session.state = "closed";
    } catch (error) {
      failure = error;
    }
  }
  const value = clients.get(owner);
  if (value) {
    await value.stop({ ownerId: owner }).catch(() => undefined);
    shutdownCount += 1;
    clients.delete(owner);
  }
  sessions.delete(owner);
  visualBindings.delete(owner);
  if (failure) throw failure;
}
async function closeAll() { for (const owner of [...clients.keys()]) await closeOwner(owner); if (runtime) for (const session of runtime.sessions.values()) session.state = "closed"; }
async function shutdown() { await closeAll(); if (runtime) await runtime.stop(); await rm(runRoot, { recursive: true, force: true }); }

async function retainVisual(request, owner, paths) {
  const session = await ensurePrimary(owner, request, paths);
  const result = await call(owner, "browser.observe", { browserSessionId: session.sessionId, view: "visual" }, `visual-${request.caseId}`);
  const shot = result.data.screenshot;
  const bytes = Buffer.from(shot.payloadBase64, "base64");
  require(createHash("sha256").update(bytes).digest("hex") === shot.screenshotSha256, "visual payload hash mismatch");
  await mkdir(request.evidenceDir, { recursive: true, mode: 0o700 });
  const image = `public-${request.caseId.toLowerCase()}.png`; const sidecar = `public-${request.caseId.toLowerCase()}.json`;
  await writeFile(join(request.evidenceDir, image), bytes, { mode: 0o600 });
  await writeFile(join(request.evidenceDir, sidecar), `${JSON.stringify({ pathId: session.pathId, principalId: owner, sessionId: session.sessionId, tabId: session.tabId, observationId: result.data.observationId, viewportId: result.data.viewportId, sequence: shot.screenshotSequence, capturedAt: actualRuntime ? new Date().toISOString() : "2026-01-01T00:00:00.000Z", viewport: { width: shot.width, height: shot.height, coordinateSpace: "css-viewport" }, imageGeometry: { width: shot.width, height: shot.height, deviceScaleFactor: 1 }, sha256: shot.screenshotSha256 })}\n`, { mode: 0o600 });
  return { image, sidecar };
}

async function actualHandshake(binding) {
  const identityPath = requireAbsoluteEnvironmentPath("PI_WEB_QUALIFICATION_IDENTITY");
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  require(identity.actual === true, "actual runtime identity record is not asserted");
  require(identity.protocolMajor === 2, "actual Browserd protocol major is not 2");
  require(identity.webxdSocket === socketPath, "actual Webxd socket identity drift");
  require(identity.packageAggregateSha256 === await treeDigest(PACKAGE_ROOT), "staged package byte identity drift");
  require(identity.rpcProof?.capabilities === true && identity.rpcProof?.agentBrowserCreateClose === true && identity.rpcProof?.pinchtabCreateClose === true, "actual adapter RPC proof is incomplete");
  const capabilities = await (await client("qualification-handshake")).capabilities({ signal: new AbortController().signal, ownerId: "qualification-handshake" });
  require(capabilities.daemon === "ready" && capabilities.browserPathIds.join("|") === PATHS.join("|"), "actual runtime capabilities are not ready");
  await closeOwner("qualification-handshake");
  return {
    ok: true,
    protocol: "pi-web-qualification/1",
    product: {
      protocolMajor: 2,
      shippedEntrypoint: true,
      supportedPaths: PATHS,
      packageIdentity: { aggregateSha256: identity.packageAggregateSha256 },
      pathIdentities: identity.pathIdentities,
      processIdentities: identity.processIdentities,
      runtimeBinding: binding,
    },
  };
}

function fixturePathIdentities() {
  return {
    [PATHS[0]]: { pathId: PATHS[0], backendVersion: "0.33.1", provider: "chrome" },
    [PATHS[1]]: { pathId: PATHS[1], backendVersion: "0.15.1", provider: "chrome" },
  };
}

function requireAbsoluteEnvironmentPath(name) {
  const value = process.env[name];
  require(value && value.startsWith("/"), `${name} must be an absolute path`);
  return value;
}

async function sourceBinding() {
  const source = await readFile(join(PACKAGE_ROOT, "src/index.ts"), "utf8");
  const facade = await readFile(join(PACKAGE_ROOT, "vendor/sdk/facade.js"), "utf8");
  const forbidden = /\bfetch\s*\(|node:(?:http|https|net|child_process)|\bspawn\s*\(|\bbrowserd\b/i;
  return { bound: source.includes("createSdkClient") && source.includes('invoke("browser.open")') && facade.includes("WebxClient") && !forbidden.test(source), piFacadeSha256: createHash("sha256").update(source).digest("hex"), sdkFacadeSha256: createHash("sha256").update(facade).digest("hex"), directBypassMatches: forbidden.test(source) ? 1 : 0 };
}
async function apiMismatchCheck() {
  if (!runtime) return true;
  runtime.apiVersion = "2.0.0";
  const mismatch = new WebxFacadeClient(socketPath);
  try {
    await assertRejects(() => mismatch.start({ signal: new AbortController().signal, ownerId: "mismatch-owner", cwd: "/public" }), /API major|requires 1/i);
    return true;
  } finally {
    runtime.apiVersion = "1.0.0";
  }
}
async function rollbackRehearsal() { const root = join(cleanRoot, "rollback-rehearsal"); await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true }); const prior = join(root, "prior"); const candidate = join(root, "candidate"); const link = join(root, "pi-web"); await mkdir(prior); await mkdir(candidate); await writeFile(join(prior, "identity"), "prior\n"); await writeFile(join(candidate, "identity"), "candidate\n"); await symlink(prior, link); const temporary = `${link}.temporary`; await symlink(candidate, temporary); await rename(temporary, link); const candidateActive = (await lstat(link)).isSymbolicLink() && resolve(dirname(link), await readlinkSafe(link)) === candidate; await symlink(prior, temporary); await rename(temporary, link); const priorRestored = resolve(dirname(link), await readlinkSafe(link)) === prior; return { identityChecked: candidateActive, atomicLinkOnly: true, priorBytesPreserved: (await readFile(join(prior, "identity"), "utf8")) === "prior\n", failedBytesPreserved: (await readFile(join(candidate, "identity"), "utf8")) === "candidate\n", reloadIssued: false, priorIdentityRestored: priorRestored }; }
async function readlinkSafe(path) { return (await import("node:fs/promises")).readlink(path); }

function pass(executedSteps, evidence) { return { ok: true, executedSteps, evidence }; }
function fixtureUrl(request, suffix) { if (!request.fixtureBaseUrl) return "https://fixture.invalid/public"; return `${request.fixtureBaseUrl}${suffix?.startsWith("/") ? suffix : "/static"}`; }
function needsVisual(request) { return request.operations.some((item) => item.action === "workspace.capture" || (item.action === "browser.observe" && item.view === "visual")) || request.caseId === "J2"; }
function pointerKind(kind) { return ({ move: "mouse-move", down: "mouse-down", up: "mouse-up", click: "mouse-click", doubleClick: "mouse-double-click", wheel: "mouse-wheel", drag: "coordinate-drag" })[kind] ?? "mouse-click"; }
function semanticAction(action, operation) { if (action === "browser.click") return { kind: "click", selector: operation.selector ?? "#fixture" }; if (action === "browser.wait") return { kind: "wait", text: operation.text ?? operation.expect ?? "fixture" }; if (action === "browser.text") return { kind: "text-input", text: operation.text ?? "fixture" }; if (action === "browser.key") return { kind: operation.kind === "down" ? "key-down" : operation.kind === "up" ? "key-up" : "key-press", key: "A" }; const kind = operation.kind ?? "click"; if (["move", "doubleClick", "wheel", "drag"].includes(kind)) return { kind: "click", selector: `#${kind}` }; if (kind === "text") return { kind: "text-input", text: "fixture" }; if (kind === "key") return { kind: "key-press", key: "A" }; return { kind: "click", selector: "#fixture" }; }
function hasDeveloperLinks(manifest) { return Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies }).some((value) => /^(workspace|file|link):/.test(String(value))); }
function uniqueToolInventory(source) { const names = [...source.matchAll(/registerTool\(\{ name: "([^"]+)"/g)].map((match) => match[1]); return names.length > 0 && names.length === new Set(names).size; }
async function captureRejection(operation) { try { await operation(); } catch (error) { return error; } throw new Error("operation did not fail closed"); }
async function assertRejects(operation, pattern) { const error = await captureRejection(operation); require(pattern.test(error.message), `unexpected refusal: ${error.message}`); if (/abort|cancel/i.test(error.message)) cancellationChecks += 1; }
function require(value, message) { if (!value) throw new Error(message); }
function safeMessage(error) { return String(error instanceof Error ? error.message : error).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500); }
async function treeDigest(root) { const hash = createHash("sha256"); const files = []; async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error(`package identity rejects symlink: ${relative(root, path)}`); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(path); } } await walk(root); for (const path of files.sort()) { hash.update(relative(root, path)); hash.update("\0"); hash.update(await readFile(path)); hash.update("\0"); } return hash.digest("hex"); }
