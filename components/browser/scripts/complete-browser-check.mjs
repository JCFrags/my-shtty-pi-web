#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createFixtureServer } from "../packages/test-fixtures/src/server.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRIMARY = "agent-browser/chrome";
const FALLBACK = "pinchtab/chrome";
const BRIDGE_PROTOCOL = "pi-web-qualification/1";
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: complete-browser-check.mjs --entrypoint PATH [--entrypoint-arg ARG]... --output DIR [--profile complete|smoke]\n\nThe entrypoint is the shipped package qualification bridge. It reads newline-delimited JSON requests from stdin and writes one JSON response per line to stdout. Each response uses the request id. A handshake must return protocol ${BRIDGE_PROTOCOL} and exactly ${PRIMARY} and ${FALLBACK}. Case requests contain the fixed operation plan and deterministic fixture URL. The bridge must return executed step records and non-private evidence. No direct adapter result is accepted as integrated evidence.`);
  process.exit(0);
}
if (!args.entrypoint) throw new Error("--entrypoint is required; direct adapter tests are not final integration evidence");
if (!args.output) throw new Error("--output is required");

let output;
let cleanRoot;
let evidenceRoot;
let fixture;
let fixtureBaseUrl;
let bridge;
let manifest;

async function main() {
output = resolve(args.output);
cleanRoot = join(output, "clean-state");
evidenceRoot = join(output, "evidence");
await rm(output, { recursive: true, force: true });
await Promise.all([mkdir(cleanRoot, { recursive: true, mode: 0o700 }), mkdir(evidenceRoot, { recursive: true, mode: 0o700 })]);
fixture = createFixtureServer({ uploadRoot: join(cleanRoot, "fixture-uploads") });
await listen(fixture);
fixtureBaseUrl = `http://127.0.0.1:${fixture.address().port}`;
bridge = new QualificationBridge(args.entrypoint, args.entrypointArgs, { timeoutMs: args.timeoutMs });
manifest = {
  schema: BRIDGE_PROTOCOL,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  profile: args.profile,
  fixture: { baseUrl: fixtureBaseUrl, sourceSha256: await treeDigest([join(ROOT, "fixtures"), join(ROOT, "packages/test-fixtures")]) },
  entrypoint: { executable: basename(args.entrypoint), argumentCount: args.entrypointArgs.length },
  requiredPaths: [PRIMARY, FALLBACK],
  cases: [],
  cleanup: {},
  visualReviewRequired: true,
  ok: false,
};

try {
  const handshake = await bridge.request({ type: "handshake", protocol: BRIDGE_PROTOCOL, cleanRoot, evidenceRoot });
  validateHandshake(handshake);
  manifest.product = sanitizeEvidence(handshake.product);
  const selected = args.profile === "smoke" ? CASES.filter((item) => item.smoke) : CASES;
  for (const definition of selected) await runCase(definition);
  manifest.ok = manifest.cases.every((item) => item.ok);
} finally {
  const cleanupStart = Date.now();
  try {
    const response = await bridge.request({ type: "cleanup", protocol: BRIDGE_PROTOCOL, scope: "qualification-owned" }, 10_000);
    manifest.cleanup = sanitizeEvidence(response.evidence || response);
  } catch (error) {
    manifest.cleanup = { ok: false, error: safeError(error) };
    manifest.ok = false;
  }
  await bridge.stop();
  await new Promise((resolve) => fixture.close(resolve));
  manifest.cleanup.elapsedMs = Date.now() - cleanupStart;
  manifest.finishedAt = new Date().toISOString();
  manifest.cleanStateInventory = await inventory(cleanRoot);
  if (manifest.cleanup.ok !== true || manifest.cleanStateInventory.some((path) => !path.startsWith("evidence-retained/"))) manifest.ok = false;
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: manifest.ok, manifest: join(output, "manifest.json"), passed: manifest.cases.filter((item) => item.ok).length, total: manifest.cases.length }));
  if (!manifest.ok) process.exitCode = 1;
}
}

async function runCase(definition) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const caseEvidenceDir = join(evidenceRoot, definition.id);
  await mkdir(caseEvidenceDir, { recursive: true, mode: 0o700 });
  const record = { id: definition.id, title: definition.title, startedAt, timeoutMs: definition.timeoutMs, ok: false };
  try {
    const response = await bridge.request({
      type: "case",
      protocol: BRIDGE_PROTOCOL,
      caseId: definition.id,
      fixtureBaseUrl,
      evidenceDir: caseEvidenceDir,
      principals: definition.principals || ["fixture-agent-a"],
      requiredPaths: definition.paths || [],
      operations: definition.operations,
      seededNegativeSelector: definition.seededNegativeSelector || undefined,
    }, definition.timeoutMs);
    assert.equal(response.ok, true, `${definition.id} did not pass`);
    assert.deepEqual(response.executedSteps, definition.operations.map((operation) => operation.step), `${definition.id} did not execute the fixed plan`);
    validateIdentities(response.evidence, definition.paths || []);
    if (definition.seededNegativeSelector) {
      assert.equal(response.evidence?.negativeSelector?.selector, definition.seededNegativeSelector);
      assert.equal(response.evidence?.negativeSelector?.dispatched, false);
      assert.match(String(response.evidence?.negativeSelector?.code), /invalid|not.found|selector/i);
    }
    if (definition.visual) record.visual = await validateVisualEvidence(caseEvidenceDir, response.evidence);
    record.evidence = sanitizeEvidence(response.evidence);
    record.ok = true;
  } catch (error) {
    record.error = safeError(error);
  }
  record.elapsedMs = performance.now() - started;
  record.finishedAt = new Date().toISOString();
  manifest.cases.push(record);
}

function validateHandshake(response) {
  assert.equal(response.ok, true);
  assert.equal(response.protocol, BRIDGE_PROTOCOL);
  assert.deepEqual(response.product?.supportedPaths, [PRIMARY, FALLBACK]);
  assert.equal(response.product?.protocolMajor, 2);
  for (const pathId of [PRIMARY, FALLBACK]) {
    const identity = response.product?.pathIdentities?.[pathId];
    assert.equal(identity?.pathId, pathId);
    assert.equal(typeof identity?.backendVersion, "string");
    assert.equal(identity?.provider, "chrome");
  }
}

function validateIdentities(evidence, paths) {
  assert.ok(evidence && typeof evidence === "object", "case evidence is required");
  const found = new Set(evidence.pathIdentities || (evidence.pathId ? [evidence.pathId] : []));
  for (const path of paths) assert.ok(found.has(path), `missing exact path identity ${path}`);
  const serialized = JSON.stringify(evidence);
  for (const unsupported of ["lightpanda", "rustwright", "camoufox", "ghost-chrome"]) assert.equal(serialized.toLowerCase().includes(unsupported), false, `unsupported path leaked into evidence: ${unsupported}`);
}

async function validateVisualEvidence(directory, evidence) {
  const imageName = evidence?.visual?.image;
  const sidecarName = evidence?.visual?.sidecar;
  assert.match(String(imageName), /^[a-z0-9][a-z0-9._-]*\.png$/i);
  assert.match(String(sidecarName), /^[a-z0-9][a-z0-9._-]*\.json$/i);
  const image = await readFile(join(directory, imageName));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const sidecar = JSON.parse(await readFile(join(directory, sidecarName), "utf8"));
  assert.equal(sidecar.sha256, createHash("sha256").update(image).digest("hex"));
  for (const field of ["pathId", "principalId", "sessionId", "tabId", "observationId", "viewportId", "sequence", "capturedAt", "viewport", "imageGeometry"]) assert.ok(sidecar[field] !== undefined, `visual sidecar lacks ${field}`);
  assert.ok([PRIMARY, FALLBACK].includes(sidecar.pathId));
  return { image: `${basename(directory)}/${imageName}`, sidecar: `${basename(directory)}/${sidecarName}`, sha256: sidecar.sha256, review: "pending-fresh-model-review" };
}

class QualificationBridge {
  constructor(executable, executableArgs, { timeoutMs }) {
    this.child = spawn(executable, executableArgs, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_WEB_QUALIFICATION: "1" } });
    this.pending = new Map();
    this.stderr = "";
    this.buffer = "";
    this.defaultTimeoutMs = timeoutMs;
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384); });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.once("exit", (code, signal) => {
      for (const item of this.pending.values()) item.reject(new Error(`entrypoint exited (${code ?? signal}): ${redact(this.stderr)}`));
      this.pending.clear();
    });
  }
  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const item = this.pending.get(message.id);
      if (!item) continue;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(String(message.error.message || message.error)));
      else item.resolve(message.result);
    }
  }
  request(payload, timeoutMs = this.defaultTimeoutMs) {
    const id = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`entrypoint timeout after ${timeoutMs} ms for ${payload.type}:${payload.caseId || ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }
  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolvePromise) => this.child.once("exit", resolvePromise)),
      sleep(2_000).then(() => this.child.kill("SIGTERM")),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

const op = (step, action, extra = {}) => ({ step, action, ...extra });
const CASES = [
  { id: "G01", title: "shipped surface and exact capabilities", smoke: true, timeoutMs: 20_000, paths: [PRIMARY, FALLBACK], operations: [op("describe", "system.describe"), op("tools", "system.tools"), op("diagnose", "system.diagnostics")] },
  { id: "G02", title: "primary create observe and close", smoke: true, timeoutMs: 45_000, paths: [PRIMARY], operations: [op("create", "browser.create", { pathId: PRIMARY, url: "/static" }), op("observe", "browser.observe", { view: "main" }), op("close", "browser.close")] },
  { id: "G03", title: "fallback create SPA action and close", smoke: true, timeoutMs: 45_000, paths: [FALLBACK], operations: [op("create", "browser.create", { pathId: FALLBACK, url: "/spa" }), op("wait", "browser.wait", { text: "48 connected clients" }), op("click", "browser.click", { selector: "#add" }), op("observe", "browser.observe", { expect: "49 connected clients" }), op("close", "browser.close")] },
  { id: "G04", title: "fallback unsupported action never changes path", smoke: true, timeoutMs: 15_000, paths: [FALLBACK], operations: [op("create", "browser.create", { pathId: FALLBACK }), op("unsupported", "browser.touch", { expect: "unsupported" }), op("inventory", "browser.list"), op("close", "browser.close")] },
  { id: "G05", title: "current model-facing visual observation", timeoutMs: 20_000, paths: [PRIMARY], visual: true, operations: [op("create", "browser.create", { pathId: PRIMARY, url: "/visual-controls" }), op("visual", "browser.observe", { view: "visual", viewport: [800, 600] }), op("close", "browser.close")] },
  { id: "G06", title: "bound coordinate and stale refusal", smoke: true, timeoutMs: 25_000, paths: [PRIMARY], operations: [op("create", "browser.create", { pathId: PRIMARY, url: "/visual-controls" }), op("visual", "browser.observe", { view: "visual" }), op("bound-click", "browser.pointer", { kind: "click" }), op("invalidate", "browser.resize", { width: 600, height: 800 }), op("stale-click", "browser.pointer", { useOldObservation: true, expect: "stale" }), op("close", "browser.close")] },
  { id: "G07", title: "complete primary mouse controls", timeoutMs: 60_000, paths: [PRIMARY], operations: ["move", "down", "up", "click", "doubleClick", "wheel", "drag"].map((kind) => op(kind, "browser.pointer", { kind })).concat(op("close", "browser.close")) },
  { id: "G08", title: "keyboard text and honest touch", timeoutMs: 45_000, paths: [PRIMARY], operations: [op("key-down", "browser.key", { kind: "down" }), op("key-up", "browser.key", { kind: "up" }), op("text", "browser.text", { text: "fixture" }), op("touch", "browser.touch", { allowUnsupported: true }), op("close", "browser.close")] },
  { id: "G09", title: "viewport geometry and scale", timeoutMs: 30_000, paths: [PRIMARY], operations: [op("landscape", "browser.viewport", { width: 800, height: 600, scale: 1 }), op("portrait", "browser.viewport", { width: 600, height: 800, scale: 2 }), op("old-refusal", "browser.pointer", { expect: "stale" }), op("close", "browser.close")] },
  { id: "G10", title: "three-principal ownership isolation", timeoutMs: 60_000, principals: ["fixture-agent-a", "fixture-agent-b", "fixture-agent-c"], paths: [PRIMARY, FALLBACK], operations: [op("create-a", "browser.create", { principal: "fixture-agent-a", pathId: PRIMARY }), op("create-b", "browser.create", { principal: "fixture-agent-b", pathId: FALLBACK }), op("deny-cross", "browser.observe", { principal: "fixture-agent-c", targetPrincipal: "fixture-agent-a", expect: "not-found" }), op("artifact-deny", "artifact.read", { principal: "fixture-agent-b", targetPrincipal: "fixture-agent-a", expect: "not-found" }), op("cleanup", "browser.close-owned")] },
  { id: "G11", title: "same-host serialization and cross-host concurrency", timeoutMs: 45_000, paths: [PRIMARY, FALLBACK], operations: [op("queue", "browser.concurrent-plan"), op("verify-order", "browser.operation-list"), op("close", "browser.close-owned")] },
  { id: "G12", title: "workspace takeover return and queue", timeoutMs: 45_000, paths: [PRIMARY, FALLBACK], visual: true, operations: [op("workspace", "workspace.open"), op("takeover", "workspace.takeover"), op("queue", "browser.act"), op("other-agent", "browser.act-unrelated"), op("return", "workspace.return"), op("capture", "workspace.capture"), op("close", "workspace.close")] },
  { id: "G13", title: "bounded cancellation matrix", smoke: true, timeoutMs: 40_000, paths: [PRIMARY], operations: ["before-connect", "during-action", "queued", "observe", "upload", "download"].map((phase) => op(phase, "operation.cancel", { phase, settlementMs: 2000 })).concat(op("inventory", "browser.inventory")) },
  { id: "G14", title: "shared startup waiter cancellation", timeoutMs: 20_000, paths: [PRIMARY], operations: [op("two-waiters", "browser.shared-start"), op("cancel-one", "operation.cancel"), op("generation", "browser.inventory"), op("close", "browser.close-owned")] },
  { id: "G15", title: "owned upload download and viewer", timeoutMs: 45_000, paths: [PRIMARY], operations: [op("upload", "browser.upload", { url: "/transfers" }), op("download", "browser.download"), op("hash", "artifact.verify"), op("viewer", "artifact.view"), op("close", "browser.close")] },
  { id: "G16", title: "viewer exact recovery and owner refusal", timeoutMs: 45_000, paths: [PRIMARY], operations: [op("png", "artifact.view"), op("text", "artifact.view"), op("pdf", "artifact.view"), op("pages", "artifact.read-pages"), op("cross-owner", "artifact.read", { expect: "not-found" })] },
  { id: "G17", title: "workspace identity and responsive status", timeoutMs: 30_000, paths: [PRIMARY, FALLBACK], visual: true, operations: [op("open", "workspace.open", { url: "/workspace-states" }), op("wide", "workspace.capture", { viewport: [1440, 900] }), op("narrow", "workspace.capture", { viewport: [1024, 768] }), op("close", "workspace.close")] },
  { id: "G18", title: "workspace failure and disconnected stream", timeoutMs: 20_000, paths: [PRIMARY], visual: true, operations: [op("failure", "workspace.state", { state: "failed" }), op("disconnect", "workspace.state", { state: "disconnected" }), op("capture", "workspace.capture"), op("close", "workspace.close")] },
  { id: "G19", title: "protected cleanup matrix", timeoutMs: 30_000, paths: [PRIMARY], operations: [op("seed", "browser.cleanup-fixtures"), op("cleanup", "browser.cleanup"), op("verify", "browser.inventory"), op("close", "browser.close-owned")] },
  { id: "G20", title: "safe diagnostics and fallback refusal", timeoutMs: 20_000, paths: [PRIMARY, FALLBACK], operations: [op("diagnostics", "system.diagnostics"), op("primary-failure", "browser.inject-failure"), op("verify-no-fallback", "browser.inventory")] },
  { id: "G21", title: "restart recovery", timeoutMs: 60_000, paths: [PRIMARY, FALLBACK], operations: [op("seed", "browser.create-owned"), op("restart", "workspace.restart"), op("verify", "browser.inventory"), op("cleanup", "browser.close-owned")] },
  { id: "N01", title: "seeded negative selector", smoke: true, timeoutMs: 15_000, paths: [PRIMARY], seededNegativeSelector: "[data-pi-web-seeded-negative='missing']", operations: [op("create", "browser.create", { pathId: PRIMARY, url: "/static" }), op("negative-selector", "browser.click", { selector: "[data-pi-web-seeded-negative='missing']", expect: "selector-error" }), op("close", "browser.close")] },
  { id: "J1", title: "search read and inspect journey", timeoutMs: 120_000, paths: [PRIMARY], visual: true, operations: [op("search", "web.search"), op("read", "web.read", { url: "/docs.md" }), op("open", "browser.create", { pathId: PRIMARY }), op("observe", "browser.observe"), op("visual", "browser.observe", { view: "visual" }), op("artifact", "artifact.read"), op("close", "browser.close")] },
  { id: "J2", title: "visual CUA canvas journey", timeoutMs: 120_000, paths: [PRIMARY], visual: true, operations: [op("open", "browser.create", { pathId: PRIMARY, url: "/visual-controls" }), op("visual", "browser.observe"), ...["move", "click", "doubleClick", "wheel", "drag", "text", "key"].map((kind) => op(kind, "browser.act", { kind })), op("stale", "browser.act", { expect: "stale" }), op("fresh", "browser.observe"), op("close", "browser.close")] },
  { id: "J3", title: "fallback capability refusal journey", timeoutMs: 120_000, paths: [FALLBACK], operations: [op("open", "browser.create", { pathId: FALLBACK, url: "/spa" }), op("wait", "browser.wait"), op("click", "browser.click"), op("verify", "browser.observe"), op("unsupported", "browser.primary-only", { expect: "unsupported" }), op("list", "browser.list"), op("diagnostics", "system.diagnostics"), op("close", "browser.close")] },
  { id: "J4", title: "transfer artifact viewer journey", timeoutMs: 120_000, paths: [PRIMARY], operations: [op("create-bytes", "fixture.bytes"), op("upload", "browser.upload"), op("download", "browser.download"), op("viewer", "artifact.view"), op("pages", "artifact.read-pages"), op("verify", "artifact.verify"), op("cleanup", "artifact.cleanup")] },
  { id: "J5", title: "multi-agent takeover cancellation recovery cleanup journey", timeoutMs: 120_000, principals: ["fixture-agent-a", "fixture-agent-b"], paths: [PRIMARY, FALLBACK], visual: true, operations: [op("create-a", "browser.create", { pathId: PRIMARY }), op("create-b", "browser.create", { pathId: FALLBACK }), op("workspace", "workspace.open"), op("takeover", "workspace.takeover"), op("queue", "browser.act"), op("continue-b", "browser.act-unrelated"), op("cancel", "operation.cancel"), op("return", "workspace.return"), op("restart", "workspace.restart"), op("cleanup", "browser.cleanup"), op("capture", "workspace.capture"), op("close", "browser.close-owned")] },
];

function parseArgs(values) {
  const result = { entrypointArgs: [], profile: "complete", timeoutMs: 120_000, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--entrypoint") result.entrypoint = values[++index];
    else if (value === "--entrypoint-arg") result.entrypointArgs.push(values[++index]);
    else if (value === "--output") result.output = values[++index];
    else if (value === "--profile") result.profile = values[++index];
    else if (value === "--timeout-ms") result.timeoutMs = Number(values[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!new Set(["complete", "smoke"]).has(result.profile)) throw new Error("--profile must be complete or smoke");
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 300_000) throw new Error("--timeout-ms must be from 1000 through 300000");
  return result;
}

async function listen(server) { await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); }); }
async function inventory(root) {
  const paths = [];
  async function walk(directory, prefix = "") {
    let entries;
    try { entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative); else paths.push(relative);
    }
  }
  await walk(root);
  return paths;
}
async function treeDigest(roots) {
  const hash = createHash("sha256");
  for (const root of roots) {
    const files = [];
    async function walk(directory) {
      const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true });
      for (const entry of entries) entry.isDirectory() ? await walk(join(directory, entry.name)) : files.push(join(directory, entry.name));
    }
    await walk(root);
    for (const file of files.sort()) { hash.update(file.slice(ROOT.length)); hash.update(await readFile(file)); }
  }
  return hash.digest("hex");
}
function sanitizeEvidence(value) {
  const text = redact(JSON.stringify(value ?? {}));
  const parsed = JSON.parse(text);
  const forbidden = /(?:cookie|authorization|token|password|privateKey|localPath|profilePath)/i;
  function scan(item) {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) { if (forbidden.test(key)) item[key] = "[REDACTED]"; else scan(child); }
  }
  scan(parsed);
  return parsed;
}
function redact(text) { return String(text).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\b(?:token|password|cookie|authorization)\s*[=:]\s*[^\s,}]+/gi, "$1=[REDACTED]"); }
function safeError(error) { return { name: error instanceof Error ? error.name : "Error", message: redact(error instanceof Error ? error.message : String(error)) }; }

await main();
