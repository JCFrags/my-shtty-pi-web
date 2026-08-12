#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PROTOCOL = "pi-web-qualification/1";
const PATHS = ["agent-browser/chrome", "pinchtab/chrome"];
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const { createFixtureServer } = await import(`file://${args.sourceRoot}/components/browser/packages/test-fixtures/src/server.mjs`);
const cases = actualCases();
let bridge;
let fixture;
let manifest;
let cleanupComplete = false;
const fixtureSockets = new Set();

async function main() {
try {
  await rm(args.output, { recursive: true, force: true });
  await mkdir(join(args.output, "evidence"), { recursive: true, mode: 0o700 });
  fixture = createFixtureServer({ uploadRoot: join(args.output, "fixture-uploads") });
  fixture.on("connection", (socket) => {
    fixtureSockets.add(socket);
    socket.once("close", () => fixtureSockets.delete(socket));
  });
  await new Promise((resolvePromise, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolvePromise); });
  const fixtureBaseUrl = `http://127.0.0.1:${fixture.address().port}`;
  bridge = new Bridge(args.entrypoint);
  manifest = { schema: PROTOCOL, profile: args.profile, runId: randomUUID(), startedAt: new Date().toISOString(), requiredPaths: PATHS, cases: [], ok: false };
  const handshake = await bridge.request({ type: "handshake", protocol: PROTOCOL, cleanRoot: args.output, evidenceRoot: join(args.output, "evidence"), packageRoot: args.packageRoot }, 30_000);
  assert.equal(handshake.ok, true);
  assert.equal(handshake.product?.shippedEntrypoint, true);
  assert.equal(handshake.product?.protocolMajor, 2);
  assert.deepEqual(handshake.product?.supportedPaths, PATHS);
  manifest.product = safe(handshake.product);
  for (const definition of cases) {
    const record = { id: definition.id, title: definition.title, ok: false, startedAt: new Date().toISOString(), timeoutMs: definition.timeoutMs };
    try {
      const evidenceDir = join(args.output, "evidence", definition.id);
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      const result = await bridge.request({ type: "case", protocol: PROTOCOL, caseId: definition.id, fixtureBaseUrl, evidenceDir, principals: definition.principals ?? ["fixture-agent-a"], requiredPaths: definition.paths, operations: definition.operations, seededNegativeSelector: definition.seededNegativeSelector }, definition.timeoutMs);
      assert.equal(result.ok, true);
      assert.deepEqual(result.executedSteps, definition.operations.map((item) => item.step));
      for (const pathId of definition.paths) assert.ok(result.evidence?.pathIdentities?.includes(pathId), `${definition.id} lacks ${pathId}`);
      assert.equal(result.evidence?.acceptance?.eligible, true, `${definition.id} is not actual acceptance evidence`);
      if (definition.visual) record.visual = await visualEvidence(evidenceDir, result.evidence);
      if (definition.validate) definition.validate(result.evidence);
      record.evidence = safe(result.evidence);
      record.ok = true;
    } catch (error) {
      record.error = safeError(error);
    }
    record.finishedAt = new Date().toISOString();
    manifest.cases.push(record);
    await checkpoint();
    if (!record.ok) throw new Error(`actual profile stopped at first failing case ${definition.id}: ${record.error.message}`);
  }
  const cleanup = await bridge.request({ type: "cleanup", protocol: PROTOCOL, scope: "qualification-owned" }, 20_000);
  assert.equal(cleanup.ok, true);
  for (const key of ["remainingHosts", "remainingSessions", "remainingTabs", "remainingProcesses", "remainingTimers"]) assert.equal(cleanup.evidence?.[key] ?? 0, 0, `cleanup left ${key}`);
  manifest.cleanup = safe(cleanup.evidence);
  cleanupComplete = true;
  manifest.ok = true;
  manifest.finishedAt = new Date().toISOString();
  await checkpoint();
  console.log(JSON.stringify({ ok: true, profile: args.profile, cases: cases.map((item) => item.id), manifest: join(args.output, "actual-manifest.json") }));
} finally {
  await teardown();
}
}

function actualCases() {
  const op = (step, action, extra = {}) => ({ step, action, ...extra });
  if (args.profile === "smoke") return [{ id: "A00", title: "actual both-path smoke", timeoutMs: 60_000, paths: PATHS, operations: [op("primary-open", "browser.create", { pathId: PATHS[0], url: "/static" }), op("primary-observe", "browser.observe"), op("primary-close", "browser.close"), op("fallback-open", "browser.create", { pathId: PATHS[1], url: "/spa" }), op("fallback-observe", "browser.observe"), op("fallback-close", "browser.close")] }];
  return [
    { id: "J1", title: "actual semantic inspect journey", timeoutMs: 90_000, paths: [PATHS[0]], visual: true, operations: [op("open", "browser.create", { pathId: PATHS[0], url: "/static" }), op("observe", "browser.observe"), op("wait", "browser.wait", { text: "Pi Web main-content fixture" }), op("visual", "browser.observe", { view: "visual" }), op("return", "workspace.return"), op("hide", "workspace.hide"), op("close", "browser.close")] },
    { id: "J2", title: "actual visual binding and stale journey", timeoutMs: 90_000, paths: [PATHS[0]], visual: true, validate: (evidence) => assert.equal(evidence.actualChecks?.staleRefused, true), operations: [op("open", "browser.create", { pathId: PATHS[0], url: "/visual-controls" }), op("workspace", "workspace.open"), op("visual", "browser.observe", { view: "visual" }), op("bound", "browser.pointer", { kind: "click" }), op("invalidate", "browser.resize"), op("stale", "browser.pointer", { useOldObservation: true, expect: "stale" }), op("close", "browser.close")] },
    { id: "J3", title: "actual PinchTab action and refusal journey", timeoutMs: 90_000, paths: [PATHS[1]], operations: [op("open", "browser.create", { pathId: PATHS[1], url: "/spa" }), op("click", "browser.click", { selector: "#root" }), op("observe", "browser.observe"), op("refuse", "browser.primary-only", { expect: "unsupported" }), op("close", "browser.close")] },
    { id: "J4", title: "actual owner isolation and cancellation journey", timeoutMs: 90_000, principals: ["fixture-agent-a", "fixture-agent-b"], paths: PATHS, validate: (evidence) => { assert.equal(evidence.actualChecks?.ownershipRefused, true); assert.equal(evidence.actualChecks?.cancellationRefused, true); }, operations: [op("create-a", "browser.create", { principal: "fixture-agent-a", pathId: PATHS[0] }), op("create-b", "browser.create", { principal: "fixture-agent-b", pathId: PATHS[1] }), op("deny-cross", "browser.observe", { principal: "fixture-agent-b", targetPrincipal: "fixture-agent-a", expect: "not-found" }), op("cancel", "operation.cancel"), op("close", "browser.close-owned")] },
    { id: "J5", title: "actual takeover return cleanup journey", timeoutMs: 90_000, principals: ["fixture-agent-a", "fixture-agent-b"], paths: PATHS, visual: true, validate: (evidence) => { assert.equal(evidence.actualChecks?.takeoverSucceeded, true); assert.equal(evidence.actualChecks?.returnSucceeded, true); }, operations: [op("create-a", "browser.create", { pathId: PATHS[0], url: "/workspace-states" }), op("workspace", "workspace.open"), op("takeover", "workspace.takeover"), op("other", "browser.act-unrelated"), op("return", "workspace.return"), op("capture", "workspace.capture"), op("close", "browser.close-owned")] },
  ];
}

async function visualEvidence(directory, evidence) {
  const image = join(directory, evidence.visual.image);
  const sidecar = join(directory, evidence.visual.sidecar);
  const bytes = await readFile(image);
  const record = JSON.parse(await readFile(sidecar, "utf8"));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(record.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(record.capturedAt, "2026-01-01T00:00:00.000Z", "actual screenshot timestamp is canned");
  return { image: basename(image), sidecar: basename(sidecar), sha256: record.sha256, capturedAt: record.capturedAt };
}

async function checkpoint() { await writeFile(join(args.output, "actual-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); }

async function teardown() {
  if (bridge && !cleanupComplete) {
    try { await bridge.request({ type: "cleanup", protocol: PROTOCOL, scope: "qualification-owned" }, 5_000); } catch {}
  }
  await Promise.race([bridge?.stop() ?? Promise.resolve(), sleep(5_000)]);
  if (!fixture) return;
  fixture.closeIdleConnections?.();
  fixture.closeAllConnections?.();
  for (const socket of fixtureSockets) socket.destroy();
  await Promise.race([
    new Promise((resolvePromise) => fixture.close(() => resolvePromise())),
    sleep(2_000),
  ]);
}

class Bridge {
  constructor(entrypoint) { this.child = spawn(entrypoint, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_WEB_QUALIFICATION: "1" }, detached: true }); this.pending = new Map(); this.buffer = ""; this.stderr = ""; this.child.stdout.on("data", (chunk) => this.consume(chunk)); this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16384); }); this.child.once("exit", () => { for (const item of this.pending.values()) item.reject(new Error(`bridge exited: ${this.stderr}`)); this.pending.clear(); }); }
  consume(chunk) { this.buffer += chunk; for (;;) { const end = this.buffer.indexOf("\n"); if (end < 0) return; const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); let message; try { message = JSON.parse(line); } catch { continue; } const item = this.pending.get(message.id); if (!item) continue; clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } }
  request(payload, timeoutMs) { const id = randomUUID(); return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`hard timeout after ${timeoutMs} ms`)); }, timeoutMs); this.pending.set(id, { resolve: resolvePromise, reject, timer }); this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`); }); }
  async stop() { if (this.child.exitCode !== null) return; this.child.stdin.end(); await Promise.race([new Promise((resolvePromise) => this.child.once("exit", resolvePromise)), sleep(3000)]); if (this.child.exitCode === null) { try { process.kill(-this.child.pid, "SIGTERM"); } catch {} await sleep(1000); } if (this.child.exitCode === null) try { process.kill(-this.child.pid, "SIGKILL"); } catch {} }
}
function parseArgs(values) { const result = { profile: "bounded" }; for (let i = 0; i < values.length; i++) { if (values[i] === "--entrypoint") result.entrypoint = values[++i]; else if (values[i] === "--package") result.packageRoot = resolve(values[++i]); else if (values[i] === "--source-root") result.sourceRoot = resolve(values[++i]); else if (values[i] === "--output") result.output = resolve(values[++i]); else if (values[i] === "--profile") result.profile = values[++i]; else throw new Error(`unknown argument: ${values[i]}`); } assert.ok(result.entrypoint && result.packageRoot && result.sourceRoot && result.output); assert.equal(result.packageRoot, PACKAGE_ROOT); assert.ok(["smoke", "bounded"].includes(result.profile)); return result; }
function safe(value) { return JSON.parse(JSON.stringify(value, (key, child) => /cookie|authorization|token|password|private.?key|profile.?path|local.?path/i.test(key) ? "[REDACTED]" : child)); }
function safeError(error) { return { name: error?.name ?? "Error", message: String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500) }; }

await main();
