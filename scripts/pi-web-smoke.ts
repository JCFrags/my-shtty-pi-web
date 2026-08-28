#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import process from "node:process";
import { WebxFacadeClient } from "../packages/sdk/src/facade.js";
import { presentResult } from "../apps/pi-webx/src/output.js";

const MAX_EVIDENCE_BYTES = 262_144;
const MAX_VISIBLE_CHARS = 40_000;
const REQUEST_MS = 45_000;
const TOTAL_MS = 180_000;
const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const candidateArg = process.argv[process.argv.indexOf("--candidate") + 1];
if (!candidateArg || candidateArg.startsWith("--")) throw new Error("usage: pi-web-smoke --candidate PATH [--live]");
const candidate = resolve(candidateArg);
const candidateManifest = JSON.parse(await readFile(join(candidate, "candidate-manifest.json"), "utf8")) as { commit: string; candidateTreeSha256: string };
const runId = `m7-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${process.pid}-${randomBytes(4).toString("hex")}`;
const runtimeBase = process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === "function" ? process.getuid() : 0}`;
const stateBase = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local/state");
const runtime = join(runtimeBase, "pi-web-candidate", runId);
const state = join(stateBase, "pi-web", "m7-runs", runId);
const socket = join(runtime, "webxd.sock");
const cache = join(runtime, "cache");
const content = join(runtime, "content");
const children: ChildProcess[] = [];
const checks: Array<Record<string, unknown>> = [];
const journal: Array<Record<string, unknown>> = [];
let fixtureRequests = 0;
let fixtureNonLoopback = 0;
let fixture: ReturnType<typeof createServer> | undefined;
const resourceSnapshot: Array<Record<string, unknown>> = [];
const started = Date.now();
const totalDeadline = setTimeout(() => {
  journal.push({ event: "total-timeout", elapsedMs: Date.now() - started });
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}, TOTAL_MS);
totalDeadline.unref();

function record(name: string, ok: boolean, details: Record<string, unknown> = {}) {
  checks.push({ name, ok, ...details });
  if (!ok) throw new Error(`${name} failed`);
}
function deadlineSignal() { return AbortSignal.timeout(REQUEST_MS); }
function options(ownerId: string, key: string) { return { ownerId, cwd: candidate, idempotencyKey: `${runId}-${key}`, signal: deadlineSignal() }; }
async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}
async function waitFor(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`candidate process exited with ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* retry */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`candidate service did not become ready: ${url}`);
}
function launch(command: string, commandArgs: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, commandArgs, { cwd: candidate, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk) => { stderrBytes += chunk.length; });
  child.on("exit", () => journal.push({ event: "exit", pid: child.pid, stderrBytes }));
  children.push(child);
  journal.push({ event: "start", command: command.split("/").pop(), pid: child.pid });
  return child;
}
async function stopChildren() {
  for (const child of children.reverse()) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.map(async (child) => { if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((done) => setTimeout(done, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }));
}
async function directoryMeasure(path: string) {
  let files = 0; let bytes = 0;
  async function walk(root: string) { for (const name of await readdir(root).catch(() => [])) { const item = join(root, name); const info = await stat(item); if (info.isDirectory()) await walk(item); else { files += 1; bytes += info.size; } } }
  await walk(path); return { files, bytes };
}
async function resources() {
  const result: Array<Record<string, unknown>> = [];
  for (const child of children) {
    if (!child.pid) continue;
    const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
    const rss = Number(status.match(/^VmRSS:\s+(\d+)/mu)?.[1] ?? 0) * 1024;
    const cgroup = (await readFile(`/proc/${child.pid}/cgroup`, "utf8").catch(() => "")).split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    const values: Record<string, unknown> = { pid: child.pid, rssBytes: rss };
    if (cgroup) for (const [name, key] of [["memory.current", "memoryCurrent"], ["memory.peak", "memoryPeak"], ["pids.current", "tasksCurrent"]] as const) {
      const value = await readFile(join("/sys/fs/cgroup", cgroup, name), "utf8").catch(() => "");
      if (/^\d+\s*$/u.test(value)) values[key] = Number(value.trim());
    }
    result.push(values);
  }
  return result;
}
function visibleCharacters(result: unknown): number {
  const count = presentResult(result as never).content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0);
  assert(count <= MAX_VISIBLE_CHARS, `Pi-visible output exceeded ${MAX_VISIBLE_CHARS} characters`);
  return count;
}

async function deterministic() {
  const fixturePort = await freePort();
  const readerPort = await freePort();
  const origin = `http://fixture.invalid:${fixturePort}`;
  fixture = createServer((request, response) => {
    fixtureRequests += 1;
    if (request.socket.localAddress !== "127.0.0.1" && request.socket.localAddress !== "::ffff:127.0.0.1") fixtureNonLoopback += 1;
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${fixturePort}`);
    const send = (status: number, type: string, body: string | Buffer) => { response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) }); response.end(body); };
    if (url.pathname === "/health") return send(200, "application/json", JSON.stringify({ ok: true }));
    if (url.pathname === "/search") return send(200, "application/json", JSON.stringify({ results: [{ url: `${origin}/static`, title: "Deterministic WebX fixture", content: "stable fixture article seed", score: 1 }] }));
    if (url.pathname === "/static") return send(200, "text/html; charset=utf-8", "<!doctype html><title>Fixture article</title><main><h1>Stable article</h1><p>The deterministic candidate reader boundary is healthy. Focus token ALPHA-OMEGA.</p></main>");
    if (url.pathname === "/api") return send(200, "application/json", JSON.stringify([{ id: 1, name: "alpha", secret: "not-selected" }, { id: 2, name: "beta", secret: "not-selected" }]));
    if (url.pathname === "/document.pdf") return send(200, "application/pdf", Buffer.from("%PDF-1.4\nsmall deterministic invalid document\n"));
    if (url.pathname === "/slow") return setTimeout(() => send(200, "text/plain", "late response"), 15_000);
    return send(404, "text/plain", "missing");
  });
  fixture.listen(fixturePort, "127.0.0.1"); await once(fixture, "listening");
  const common = { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cache, WEBXD_SOCKET: socket, WEBX_CACHE_DIR: cache, WEBX_CONTENT_DIR: content };
  const readerBin = join(candidate, ".venv/bin/pi-web-reader");
  const reader = launch(readerBin, [], { ...common, PI_WEB_READER_PORT: String(readerPort), PI_WEB_READER_HOST: "127.0.0.1", PI_WEB_TEST_LOOPBACK_ORIGIN: origin, PI_WEB_DOCLING_URL: "http://127.0.0.1:1/", PI_WEB_HTTP_TIMEOUT_SECONDS: "5" });
  await waitFor(`http://127.0.0.1:${readerPort}/health`, reader);
  launch(process.execPath, [join(candidate, "apps/webxd/dist/apps/webxd/src/main.js")], { ...common, WEBX_SEARX_URL: `http://127.0.0.1:${fixturePort}`, WEBX_READER_URL: `http://127.0.0.1:${readerPort}`, WEBX_CRAWL_URL: "http://127.0.0.1:1/", BROWSERD_SOCKET: join(runtime, "absent-browser.sock") });
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await stat(socket); break; } catch { await new Promise((done) => setTimeout(done, 100)); } }
  const owner = `m7-${process.pid}`; const client = new WebxFacadeClient(socket);
  await client.start({ ownerId: owner, cwd: candidate, signal: deadlineSignal() });
  try {
    const capabilities = await client.capabilities({ ownerId: owner, signal: deadlineSignal() });
    record("optional workers absent while core is healthy", capabilities.groups.search && capabilities.groups.read && !capabilities.groups.browser, { groups: capabilities.groups });
    const search = await client.request("web.search", { query: "stable fixture", domains: ["fixture.invalid"] }, options(owner, "search-1"));
    record("search through candidate facade", Array.isArray((search.data as { hits?: unknown[] }).hits) && (search.data as { hits: unknown[] }).hits.length === 1, { structuredSdkBytes: Buffer.byteLength(JSON.stringify(search)), piVisibleCharacters: visibleCharacters(search) });
    const read = await client.request("web.read", { url: `${origin}/static`, maxChars: 80 }, options(owner, "read-1"));
    const readData = read.data as { untrustedContent: string; metadata: { contentId: string; reader: { nextContentOffset: number | null } } };
    record("bounded static read with content ID", readData.untrustedContent.includes("deterministic") && typeof readData.metadata.contentId === "string", { structuredSdkBytes: Buffer.byteLength(JSON.stringify(read)), piVisibleCharacters: visibleCharacters(read) });
    const continuationOffset = readData.metadata.reader.nextContentOffset;
    assert.equal(typeof continuationOffset, "number");
    const continued = await client.request("web.read", { url: `${origin}/static`, contentOffset: continuationOffset, maxChars: 500 }, options(owner, "read-continuation"));
    record("reader continuation uses the reported offset", JSON.stringify(continued).includes("ALPHA-OMEGA"), { structuredSdkBytes: Buffer.byteLength(JSON.stringify(continued)), piVisibleCharacters: visibleCharacters(continued), contentOffset: continuationOffset });
    const exact = await client.request("web.content", { contentId: readData.metadata.contentId, offset: 0, limit: 30_000 }, options(owner, "content-exact"));
    const focused = await client.request("web.content", { contentId: readData.metadata.contentId, query: "ALPHA-OMEGA" }, options(owner, "content-focus"));
    record("exact and focused stored content", JSON.stringify(exact).includes("ALPHA-OMEGA") && JSON.stringify(focused).includes("ALPHA-OMEGA"));
    const structured = await client.request("web.read", { url: `${origin}/api`, fields: ["id", "name"], itemLimit: 1 }, options(owner, "structured"));
    record("structured rows remain complete", JSON.stringify(structured).includes('"id":1') && !JSON.stringify(structured).includes("not-selected"));
    const batch = await client.request("web.readBatch", { items: [{ url: `${origin}/static`, maxChars: 200 }, { url: `${origin}/api`, fields: ["id", "name"], itemLimit: 2 }] }, options(owner, "batch"));
    record("web_read_batch uses bounded concurrency", (batch.data as { metadata: { maxConcurrency: number } }).metadata.maxConcurrency <= 3, { structuredSdkBytes: Buffer.byteLength(JSON.stringify(batch)), piVisibleCharacters: visibleCharacters(batch), itemCount: 2, maxConcurrency: (batch.data as { metadata: { maxConcurrency: number } }).metadata.maxConcurrency });
    const timeoutStarted = Date.now();
    await assert.rejects(client.request("web.read", { url: `${origin}/slow`, maxChars: 100 }, options(owner, "timeout")));
    record("reader timeout is bounded", Date.now() - timeoutStarted < 10_000, { elapsedMs: Date.now() - timeoutStarted, configuredSeconds: 5 });
    await assert.rejects(client.request("browser.open", { url: `${origin}/static` }, options(owner, "browser-fail")));
    await assert.rejects(client.request("web.read", { url: `${origin}/static`, maxPages: 2 }, options(owner, "crawl-fail")));
    await assert.rejects(client.request("web.read", { url: `${origin}/document.pdf` }, options(owner, "document-fail")));
    const laterSearch = await client.request("web.search", { query: "stable fixture" }, options(owner, "search-2"));
    const laterRead = await client.request("web.read", { url: `${origin}/static`, maxChars: 500 }, options(owner, "read-2"));
    record("optional failures do not disable later core work", JSON.stringify(laterSearch).includes("fixture.invalid") && JSON.stringify(laterRead).includes("healthy"));
    record("fixture traffic stayed on loopback", fixtureRequests > 0 && fixtureNonLoopback === 0, { fixtureRequests, nonLoopbackRequests: fixtureNonLoopback });
  } finally { await client.stop({ ownerId: owner }).catch(() => undefined); }
}

async function liveCore() {
  const deterministicOk = checks.every((check) => check.ok === true);
  record("deterministic gate before live mode", deterministicOk);
  const readerPort = await freePort();
  const common = { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cache, WEBXD_SOCKET: socket, WEBX_CACHE_DIR: cache, WEBX_CONTENT_DIR: content };
  const reader = launch(join(candidate, ".venv/bin/pi-web-reader"), [], { ...common, PI_WEB_READER_PORT: String(readerPort), PI_WEB_READER_HOST: "127.0.0.1", PI_WEB_HTTP_TIMEOUT_SECONDS: "45" });
  await waitFor(`http://127.0.0.1:${readerPort}/health`, reader);
  launch(process.execPath, [join(candidate, "apps/webxd/dist/apps/webxd/src/main.js")], { ...common, WEBX_SEARX_URL: process.env.WEBX_LIVE_SEARX_URL ?? "http://127.0.0.1:8888", WEBX_READER_URL: `http://127.0.0.1:${readerPort}`, BROWSERD_SOCKET: join(runtime, "absent-browser.sock") });
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await stat(socket); break; } catch { await new Promise((done) => setTimeout(done, 100)); } }
  const owner = `m7-live-${process.pid}`; const client = new WebxFacadeClient(socket); await client.start({ ownerId: owner, cwd: candidate, signal: deadlineSignal() });
  try {
    const search = await client.request("web.search", { query: "IANA reserved domains", domains: ["iana.org"] }, options(owner, "live-search"));
    const page = await client.request("web.read", { url: "https://example.com", maxChars: 2_000 }, options(owner, "live-read"));
    const rows = await client.request("web.read", { url: "https://jsonplaceholder.typicode.com/todos", fields: ["id", "title", "completed"], itemLimit: 2, maxChars: 4_000 }, options(owner, "live-rows"));
    record("finite live core targets", JSON.stringify(search).includes("iana.org") && JSON.stringify(page).toLowerCase().includes("example domain") && JSON.stringify(rows).includes('"id"'), { excerpts: ["iana.org", "Example Domain", "structured rows present"] });
  } finally { await client.stop({ ownerId: owner }).catch(() => undefined); }
}

let failure: string | undefined;
let storageBefore: Record<string, { files: number; bytes: number }> = {};
try {
  await mkdir(runtime, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 });
  storageBefore = { cache: await directoryMeasure(cache), content: await directoryMeasure(content), audit: await directoryMeasure(join(stateBase, "pi-web/audit/events")) };
  await deterministic();
  resourceSnapshot.push(...await resources());
  await stopChildren(); if (fixture?.listening) { const activeFixture = fixture; await new Promise<void>((done) => activeFixture.close(() => done())); } fixture = undefined;
  await rm(runtime, { recursive: true, force: true }); await mkdir(runtime, { recursive: true, mode: 0o700 });
  if (live) { await liveCore(); resourceSnapshot.push(...await resources()); }
  record("total smoke timeout", Date.now() - started <= TOTAL_MS, { elapsedMs: Date.now() - started });
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  await stopChildren(); if (fixture?.listening) { const activeFixture = fixture; await new Promise<void>((done) => activeFixture.close(() => done())); }
  clearTimeout(totalDeadline);
  const storageAfter = { cache: await directoryMeasure(cache), content: await directoryMeasure(content), audit: await directoryMeasure(join(stateBase, "pi-web/audit/events")) };
  const storage = Object.fromEntries(Object.entries(storageAfter).map(([name, after]) => [name, { before: storageBefore[name] ?? { files: 0, bytes: 0 }, after, deltaFiles: after.files - (storageBefore[name]?.files ?? 0), deltaBytes: after.bytes - (storageBefore[name]?.bytes ?? 0) }]));
  const evidence = { schemaVersion: 1, runId, candidateCommit: candidateManifest.commit, candidateTreeSha256: candidateManifest.candidateTreeSha256, mode: live ? "live" : "deterministic", ok: failure === undefined, failure, elapsedMs: Date.now() - started, limits: { requestMs: REQUEST_MS, totalMs: TOTAL_MS, evidenceBytes: MAX_EVIDENCE_BYTES, piVisibleCharacters: MAX_VISIBLE_CHARS, batchConcurrency: 3 }, checks, resources: resourceSnapshot, storage, auditEvidence: "Metadata-only counts and byte deltas. No response or audit bodies are present.", journal };
  const encoded = JSON.stringify(evidence, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) failure ??= "evidence exceeded 262144 bytes"; else await writeFile(join(state, "evidence.json"), encoded, { mode: 0o600 });
  await rm(runtime, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: failure === undefined, runId, evidence: join(state, "evidence.json"), failure }));
}
if (failure) process.exitCode = 1;
