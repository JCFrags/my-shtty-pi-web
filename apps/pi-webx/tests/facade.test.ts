import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import { createPiWebxExtension } from "../src/index.js";
import { MAX_MODEL_CHARS, presentResult } from "../src/output.js";
import {
  ArtifactReadSchema,
  BrowserActSchema,
  BrowserOpenSchema,
  WebRecallForgetSchema,
  WebSearchSchema,
} from "../src/schemas.js";
import type { WebxCapabilities, WebxRequestOptions, WebxResult, WebxSdk } from "../src/sdk.js";

const readyCapabilities: WebxCapabilities = {
  apiVersion: "1.0.0",
  daemon: "ready",
  groups: { web: true, browser: true, browserDebug: true, artifacts: true },
  browserPathIds: ["agent-browser/chrome", "pinchtab/chrome"],
};

class MockSdk implements WebxSdk {
  starts = 0;
  stops = 0;
  calls: Array<{ operation: string; input: unknown; options: WebxRequestOptions }> = [];
  decisions: Array<{ approvalId: string; decision: "allow-once" | "deny" }> = [];
  capabilitiesValue: WebxCapabilities = readyCapabilities;
  result: WebxResult = { summary: "mock result", trust: "untrusted-external" };

  async start(): Promise<void> { this.starts += 1; }
  async capabilities(): Promise<WebxCapabilities> { return this.capabilitiesValue; }
  async request(operation: string, input: unknown, options: WebxRequestOptions): Promise<WebxResult> {
    this.calls.push({ operation, input, options });
    return this.result;
  }
  async decideApproval(approvalId: string, decision: "allow-once" | "deny"): Promise<WebxResult> {
    this.decisions.push({ approvalId, decision });
    return { summary: decision === "allow-once" ? "approved" : "denied", trust: "local" };
  }
  async stop(): Promise<void> { this.stops += 1; }
}

function harness(sdk: MockSdk, trusted = true) {
  const tools: Array<Record<string, unknown>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => Promise<void>>();
  let active = ["read", "bash", "other_extension_tool"];
  const status: unknown[][] = [];
  const notifications: unknown[][] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { tools.push(tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    registerShortcut(name: string, shortcut: { handler: (ctx: unknown) => Promise<void> }) { shortcuts.set(name, shortcut); },
    on(name: string, handler: (event?: unknown, ctx?: unknown) => Promise<void>) { events.set(name, handler); },
    getActiveTools() { return active; },
    setActiveTools(value: string[]) { active = value; },
  };
  createPiWebxExtension(() => sdk)(pi as never);
  const controller = new AbortController();
  const ctx = {
    cwd: "/trusted/project",
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "owner-session" },
    ui: {
      setStatus: (...args: unknown[]) => status.push(args),
      notify: (...args: unknown[]) => notifications.push(args),
      select: async () => "Allow once",
    },
  };
  const execute = async (name: string, input: unknown, signal: AbortSignal = controller.signal) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    return (tool.execute as Function)(`call-${name}`, input, signal, undefined, ctx);
  };
  return { tools, commands, shortcuts, events, ctx, execute, get active() { return active; }, status, notifications };
}

test("registers one stable inventory and preserves unrelated active tools", async () => {
  const sdk = new MockSdk();
  const fx = harness(sdk);
  assert.deepEqual(fx.tools.map((tool) => tool.name), [
    "web_upgrade", "web_search", "web_research", "web_recall", "web_recall_get", "web_recall_forget", "web_read",
    "browser_open", "browser_tabs", "browser_observe", "browser_act", "browser_debug", "artifact_read",
  ]);
  assert.deepEqual([...fx.commands.keys()], ["web", "browser"]);
  assert.deepEqual([...fx.shortcuts.keys()], ["ctrl+alt+g"]);
  await fx.events.get("session_start")?.({}, fx.ctx);
  assert.equal(sdk.starts, 1);
  assert.ok(fx.active.includes("other_extension_tool"));
  assert.ok(fx.active.includes("web_search"));
  assert.ok(fx.active.includes("browser_open"));

  await fx.execute("web_upgrade", { mode: "browser" });
  assert.ok(fx.active.includes("browser_open"));
  assert.ok(!fx.active.includes("browser_debug"));
  await fx.execute("web_upgrade", { mode: "debug" });
  assert.ok(fx.active.includes("browser_debug"));

  await fx.commands.get("web")?.handler("off", fx.ctx);
  assert.ok(!fx.active.includes("web_search"));
  assert.ok(fx.active.includes("other_extension_tool"));
  await assert.rejects(fx.execute("web_upgrade", { mode: "browser" }), /explicitly disabled/);
  await fx.events.get("session_shutdown")?.();
  assert.equal(sdk.stops, 1);
});

test("strict schemas reject unknown, excessive, and incomplete inputs", () => {
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", unexpected: true }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", limit: 21 }), false);
  assert.equal(Value.Check(ArtifactReadSchema, { artifactId: "a", limit: 4_194_305 }), false);
  assert.equal(Value.Check(ArtifactReadSchema, { artifactId: "a", mode: "raw", limit: 65_537 }), false);
  assert.equal(Value.Check(BrowserOpenSchema, { pathId: "agent-browser/chrome" }), true);
  assert.equal(Value.Check(BrowserOpenSchema, { pathId: "pinchtab/chrome" }), true);
  for (const pathId of ["agent-browser", "rustwright", "other"]) {
    assert.equal(Value.Check(BrowserOpenSchema, { pathId }), false, `legacy or unknown path must fail: ${pathId}`);
  }
  assert.equal(Value.Check(BrowserActSchema, {
    action: { kind: "mouse-click", observationId: "o", viewportId: "v", x: 1, y: 2, extra: true },
  }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "mouse-click", x: 1, y: 2 } }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "upload", ref: "e1", uploadHandle: "handle-1" } }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "upload", ref: "e1", uploadHandleIds: ["handle-1"] } }), false);
  assert.equal(Value.Check(WebRecallForgetSchema, { versionId: "v", extra: true }), false);
});

test("tool calls use only the SDK seam with owner, idempotency, cancellation, and bounded untrusted output", async () => {
  const sdk = new MockSdk();
  sdk.result = {
    title: "External title",
    url: "https://example.test/",
    summary: "x".repeat(100_000),
    data: { nested: "y".repeat(100_000) },
    artifacts: [{ id: "sha256:abc", kind: "markdown" }],
  };
  const fx = harness(sdk);
  await fx.events.get("session_start")?.({}, fx.ctx);
  const caller = new AbortController();
  const result = await fx.execute("web_search", { query: "evidence" }, caller.signal);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0]?.operation, "web.search");
  assert.equal(sdk.calls[0]?.options.ownerId, "owner-session");
  assert.match(sdk.calls[0]?.options.idempotencyKey ?? "", /^call-web_search:/);
  assert.match(result.content[0].text, /^\[UNTRUSTED EXTERNAL CONTENT\]/);
  assert.ok(result.content[0].text.length <= MAX_MODEL_CHARS);
  assert.ok(JSON.stringify(result.details).length < 25_000);
  caller.abort();
  assert.equal(sdk.calls[0]?.options.signal.aborted, true);
  await fx.events.get("session_shutdown")?.();
});

test("approval UI offers only allow-once or deny and returns the SDK decision", async () => {
  const sdk = new MockSdk();
  sdk.result = {
    summary: "approval required",
    approval: {
      id: "approval-1", operation: "download", target: "public fixture", capability: "browser.download",
      budget: "one file", credentialRef: "fixture-ref", reason: "test", duration: "one operation",
    },
  };
  const fx = harness(sdk);
  await fx.events.get("session_start")?.({}, fx.ctx);
  const result = await fx.execute("browser_act", { action: { kind: "download", ref: "e1" } });
  assert.deepEqual(sdk.decisions, [{ approvalId: "approval-1", decision: "allow-once" }]);
  assert.match(result.content[0].text, /approved/);
  await fx.events.get("session_shutdown")?.();
});

test("API mismatch, daemon outage, wrong paths, and untrusted projects fail closed", async () => {
  for (const capabilitiesValue of [
    { ...readyCapabilities, apiVersion: "2.0.0" },
    { ...readyCapabilities, daemon: "unavailable" as const },
    { ...readyCapabilities, browserPathIds: ["agent-browser", "pinchtab/chrome"] as [string, string] },
    { ...readyCapabilities, browserPathIds: ["rustwright", "pinchtab/chrome"] as [string, string] },
    { ...readyCapabilities, browserPathIds: ["agent-browser/chrome", "other"] as [string, string] },
  ]) {
    const sdk = new MockSdk();
    sdk.capabilitiesValue = capabilitiesValue;
    const fx = harness(sdk);
    await fx.events.get("session_start")?.({}, fx.ctx);
    assert.equal(fx.active.some((name) => name.startsWith("web_") || name.startsWith("browser_") || name === "artifact_read"), false);
    await assert.rejects(fx.execute("web_search", { query: "x" }));
    assert.equal(sdk.calls.length, 0);
    await fx.events.get("session_shutdown")?.();
  }

  const sdk = new MockSdk();
  const untrusted = harness(sdk, false);
  await untrusted.events.get("session_start")?.({}, untrusted.ctx);
  assert.equal(sdk.starts, 0);
  await assert.rejects(untrusted.execute("web_search", { query: "x" }), /not trusted/);
});

test("startup and shutdown are clean across reload-style extension replacement", async () => {
  const firstSdk = new MockSdk();
  const first = harness(firstSdk);
  await first.events.get("session_start")?.({ reason: "startup" }, first.ctx);
  await first.events.get("session_shutdown")?.({ reason: "reload" });
  const secondSdk = new MockSdk();
  const second = harness(secondSdk);
  await second.events.get("session_start")?.({ reason: "reload" }, second.ctx);
  await second.events.get("session_shutdown")?.({ reason: "quit" });
  assert.deepEqual([firstSdk.starts, firstSdk.stops, secondSdk.starts, secondSdk.stops], [1, 1, 1, 1]);
});

test("output compaction and artifact recovery have deterministic bounds", () => {
  let value: unknown = "leaf";
  for (let index = 0; index < 20; index += 1) value = { value };
  const result = presentResult({ summary: "ok", data: value });
  assert.doesNotMatch(JSON.stringify(result.details), /leaf/);
  assert.match(JSON.stringify(result.content), /depth limit/);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
  const image = presentResult({
    summary: "image", artifactPayload: {
      artifactId: "shot", mediaType: "image/png", dataBase64: png.toString("base64"),
      size: png.length, complete: true, mode: "image",
    },
  });
  assert.equal(image.content.some((item) => item.type === "image"), true);
  assert.doesNotMatch(JSON.stringify(image.details), new RegExp(png.toString("base64")));

  const raw = presentResult({
    summary: "raw", artifactPayload: {
      artifactId: "shot", mediaType: "image/png", dataBase64: png.toString("base64"),
      size: png.length, complete: false, mode: "raw", offset: 0, nextOffset: null, eof: true,
    },
  });
  assert.equal(raw.content.some((item) => item.type === "image"), false);
  assert.equal((raw.details as { artifact: { dataBase64: string } }).artifact.dataBase64, png.toString("base64"));
});

test("source has no direct provider, Browserd, network, or subprocess bypass", async () => {
  const source = await Promise.all([
    "../src/index.ts", "../src/sdk.ts", "../src/output.ts", "../src/modes.ts", "../src/schemas.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const joined = source.join("\n");
  assert.doesNotMatch(joined, /\bfetch\s*\(|node:(?:http|https|net|child_process)|\bpi\.exec\s*\(|\bexecSync\s*\(|\bspawn\s*\(|\bbrowserd\b/i);
  assert.doesNotMatch(joined, /searxng|google|duckduckgo|playwright|camoufox/i);
});
