import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import { createPiWebxExtension } from "../src/index.js";
import { MAX_MODEL_CHARS, presentResult } from "../src/output.js";
import {
  BrowserActSchema,
  BrowserDebugSchema,
  BrowserObserveSchema,
  BrowserOpenSchema,
  BrowserTabsSchema,
  WebContentSchema,
  WebReadBatchSchema,
  WebReadSchema,
  WebSearchSchema,
} from "../src/schemas.js";
import type { WebxCapabilities, WebxRequestOptions, WebxResult, WebxSdk } from "../src/sdk.js";

const readyCapabilities: WebxCapabilities = {
  apiVersion: "2.0.0",
  daemon: "ready",
  groups: { search: true, read: true, browser: true, browserDebug: true },
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

function harness(sdk: MockSdk, trusted = true, audit: { record(input: unknown): Promise<void> } = { record: async () => undefined }) {
  const tools: Array<Record<string, unknown>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => Promise<void>>();
  let active = ["read", "bash", "other_extension_tool"];
  const status: unknown[][] = [];
  const notifications: unknown[][] = [];
  const selectionPrompts: unknown[][] = [];
  const inputPrompts: unknown[][] = [];
  const selections: string[] = [];
  const inputs: Array<string | undefined> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { tools.push(tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    registerShortcut(name: string, shortcut: { handler: (ctx: unknown) => Promise<void> }) { shortcuts.set(name, shortcut); },
    on(name: string, handler: (event?: unknown, ctx?: unknown) => Promise<void>) { events.set(name, handler); },
    getActiveTools() { return active; },
    setActiveTools(value: string[]) { active = value; },
  };
  createPiWebxExtension(() => sdk, audit)(pi as never);
  const controller = new AbortController();
  const ctx = {
    cwd: "/trusted/project",
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "owner-session" },
    ui: {
      setStatus: (...args: unknown[]) => status.push(args),
      notify: (...args: unknown[]) => notifications.push(args),
      select: async (...args: unknown[]) => {
        selectionPrompts.push(args);
        return selections.shift() ?? "Allow once";
      },
      input: async (...args: unknown[]) => {
        inputPrompts.push(args);
        return inputs.shift();
      },
    },
  };
  const execute = async (name: string, input: unknown, signal: AbortSignal = controller.signal) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    return (tool.execute as Function)(`call-${name}`, input, signal, undefined, ctx);
  };
  return {
    tools, commands, shortcuts, events, ctx, execute,
    get active() { return active; },
    status, notifications, selectionPrompts, inputPrompts, selections, inputs,
  };
}

test("registers one stable inventory and preserves unrelated active tools", async () => {
  const sdk = new MockSdk();
  const fx = harness(sdk);
  assert.deepEqual(fx.tools.map((tool) => tool.name), [
    "web_search", "web_read", "web_read_batch", "web_content",
    "browser_open", "browser_tabs", "browser_observe", "browser_act", "browser_debug",
  ]);
  assert.deepEqual([...fx.commands.keys()], ["web"]);
  assert.deepEqual([...fx.shortcuts.keys()], ["ctrl+alt+g"]);
  await fx.events.get("session_start")?.({}, fx.ctx);
  assert.equal(sdk.starts, 1);
  assert.ok(fx.active.includes("other_extension_tool"));
  assert.ok(fx.active.includes("web_search"));
  assert.ok(fx.active.includes("browser_open"));
  const searchTool = fx.tools.find((tool) => tool.name === "web_search");
  assert.match(String(searchTool?.promptSnippet), /Discover ranked URLs or retrieve short separate source extracts/);
  assert.ok(Array.isArray(searchTool?.promptGuidelines));
  const searchCall = (searchTool?.renderCall as Function)(
    { query: "NIST password guidance 2026", output: "extracts", domains: ["nist.gov", "csrc.nist.gov"] },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    { lastComponent: undefined },
  ) as { render(width: number): string[] };
  const visibleSearchCall = searchCall.render(200).join("\n");
  assert.match(visibleSearchCall, /web_search "NIST password guidance 2026"/);
  assert.match(visibleSearchCall, /\[extracts; domains: nist\.gov, csrc\.nist\.gov\]/);
  for (const tool of fx.tools) {
    assert.ok(String(tool.description ?? "").length >= 80, `${String(tool.name)} needs a useful model-facing description`);
    if (tool.promptGuidelines !== undefined) {
      assert.ok((tool.promptGuidelines as string[]).every((line) => line.includes(String(tool.name))), `${String(tool.name)} guidelines must name the tool`);
    }
  }
  const prompt = await (fx.events.get("before_agent_start") as Function)({ systemPrompt: "base" }, fx.ctx);
  assert.match(prompt.systemPrompt, /WebX is Pi's primary internet interface/);
  assert.match(prompt.systemPrompt, /Do not replace WebX with curl/);
  assert.match(prompt.systemPrompt, /web_search needs only a complete query/);
  assert.match(prompt.systemPrompt, /Do not invent a continuation offset/);
  assert.match(prompt.systemPrompt, /does not expose uploads or downloads/);

  assert.ok(fx.active.includes("browser_open"));
  assert.ok(!fx.active.includes("browser_debug"));
  await fx.commands.get("web")?.handler("debug", fx.ctx);
  assert.ok(fx.active.includes("browser_debug"));

  await fx.commands.get("web")?.handler("off", fx.ctx);
  assert.ok(!fx.active.includes("web_search"));
  assert.ok(fx.active.includes("other_extension_tool"));
  await fx.events.get("session_shutdown")?.();
  assert.equal(sdk.stops, 1);
});

test("one /web settings command routes modes and browser workspace actions", async () => {
  const sdk = new MockSdk();
  const fx = harness(sdk);
  await fx.events.get("session_start")?.({}, fx.ctx);

  fx.selections.push("Set capability mode", "read");
  await fx.commands.get("web")?.handler("", fx.ctx);
  assert.equal(fx.selectionPrompts.length, 2);
  assert.ok(fx.active.includes("web_search"));
  assert.ok(!fx.active.includes("browser_open"));

  await fx.commands.get("web")?.handler("workspace attach session-1 tab-1", fx.ctx);
  assert.deepEqual(sdk.calls.at(-1)?.input, { action: "attach", browserSessionId: "session-1", tabId: "tab-1" });

  fx.selections.push("Take over browser session");
  fx.inputs.push("session-2");
  await fx.commands.get("web")?.handler("settings", fx.ctx);
  assert.deepEqual(sdk.calls.at(-1)?.input, { action: "takeover", browserSessionId: "session-2" });
  assert.equal(fx.inputPrompts.length, 1);

  const callCount = sdk.calls.length;
  await fx.commands.get("web")?.handler("workspace profile personal", fx.ctx);
  assert.equal(sdk.calls.length, callCount);
  assert.match(String(fx.notifications.at(-1)?.[0]), /Usage: \/web workspace/);

  await fx.shortcuts.get("ctrl+alt+g")?.handler(fx.ctx);
  assert.deepEqual(sdk.calls.at(-1)?.input, { action: "show" });
  await fx.events.get("session_shutdown")?.();
});

test("strict schemas reject unknown, excessive, and incomplete inputs", () => {
  assert.equal(Value.Check(WebSearchSchema, { query: "ok" }), true);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", output: "links" }), true);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", output: "extracts" }), true);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", output: "deep" }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", operation: "links" }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", effort: "fast" }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", freshness: "day" }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", unexpected: true }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", limit: 20 }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", crawlPages: 1 }), false);
  assert.equal(Value.Check(WebSearchSchema, { query: "ok", domains: ["https://example.com/path"] }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "not-a-url" }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", refresh: true }), true);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", refresh: "yes" }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", save: { path: "notes/page.md" } }), true);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", save: { path: "../page.md" } }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", save: { path: "/tmp/page.md" } }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", save: { path: "page.txt" } }), false);
  assert.equal(Value.Check(WebReadSchema, { url: "https://example.test", save: { path: "page.md", overwrite: "yes" } }), false);
  const directItem = { url: "https://one.test", query: "topic", view: "outline", fields: ["id"], itemOffset: 2, itemLimit: 3, maxChars: 4_000, contentOffset: 10, refresh: true };
  assert.equal(Value.Check(WebReadBatchSchema, { items: [directItem, { url: "https://two.test" }] }), true);
  assert.equal(Value.Check(WebReadBatchSchema, { items: [] }), false);
  assert.equal(Value.Check(WebReadBatchSchema, { items: Array.from({ length: 6 }, (_, index) => ({ url: `https://${index}.test` })) }), false);
  for (const rejected of [{ maxPages: 2 }, { maxDepth: 1 }, { sameDomain: false }, { save: { path: "x.md" } }, { unexpected: true }]) {
    assert.equal(Value.Check(WebReadBatchSchema, { items: [{ url: "https://one.test", ...rejected }] }), false);
  }
  const contentId = `cnt_${"x".repeat(32)}`;
  assert.equal(Value.Check(WebContentSchema, { contentId, offset: 10, limit: 100 }), true);
  assert.equal(Value.Check(WebContentSchema, { contentId, findText: "needle", limit: 100 }), true);
  assert.equal(Value.Check(WebContentSchema, { contentId, query: "topic", limit: 100 }), true);
  assert.equal(Value.Check(WebContentSchema, { contentId, offset: 10, query: "topic" }), false);
  assert.equal(Value.Check(WebContentSchema, { contentId, limit: 30_001 }), false);
  assert.equal(Value.Check(BrowserOpenSchema, { pathId: "agent-browser/chrome" }), true);
  assert.equal(Value.Check(BrowserOpenSchema, { newTab: true }), false);
  assert.equal(Value.Check(BrowserTabsSchema, { action: "discard-tab" }), false);
  assert.equal(Value.Check(BrowserTabsSchema, { action: "restore-tab" }), false);
  assert.equal(Value.Check(BrowserTabsSchema, { action: "close-tab", browserSessionId: "s" }), false);
  assert.equal(Value.Check(BrowserTabsSchema, { action: "close-session", browserSessionId: "s" }), true);
  assert.equal(Value.Check(BrowserObserveSchema, { browserSessionId: "s", view: "hybrid" }), false);
  assert.equal(Value.Check(BrowserObserveSchema, { view: "main" }), false);
  assert.equal(Value.Check(BrowserDebugSchema, { browserSessionId: "s", operation: "cookies" }), false);
  assert.equal(Value.Check(BrowserDebugSchema, { browserSessionId: "s", operation: "console" }), true);
  assert.equal(Value.Check(BrowserOpenSchema, { pathId: "pinchtab/chrome" }), true);
  for (const pathId of ["agent-browser", "rustwright", "other"]) {
    assert.equal(Value.Check(BrowserOpenSchema, { pathId }), false, `legacy or unknown path must fail: ${pathId}`);
  }
  assert.equal(Value.Check(BrowserActSchema, {
    browserSessionId: "s", action: { kind: "mouse-click", observationId: "o", viewportId: "v", x: 1, y: 2, extra: true },
  }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "reload" } }), false);
  assert.equal(Value.Check(BrowserActSchema, { browserSessionId: "s", action: { kind: "tab-new" } }), false);
  assert.equal(Value.Check(BrowserActSchema, { browserSessionId: "s", action: { kind: "reload" }, feedback: "delta" }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "mouse-click", x: 1, y: 2 } }), false);
  assert.equal(Value.Check(BrowserActSchema, { browserSessionId: "s", action: { kind: "click", selector: "button" } }), false);
  assert.equal(Value.Check(BrowserActSchema, { browserSessionId: "s", action: { kind: "click", ref: "e1" } }), true);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "upload", ref: "e1", uploadHandle: "handle-1" } }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "upload", ref: "e1", uploadHandleIds: ["handle-1"] } }), false);
  assert.equal(Value.Check(BrowserActSchema, { action: { kind: "download", ref: "e1" } }), false);
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

test("web_read_batch sends web.readBatch to the SDK when read capability is healthy", async () => {
  const sdk = new MockSdk();
  const fx = harness(sdk);
  await fx.events.get("session_start")?.({}, fx.ctx);
  await fx.execute("web_read_batch", { items: [{ url: "https://one.test" }, { url: "https://two.test" }] });
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0]?.operation, "web.readBatch");
  await fx.events.get("session_shutdown")?.();
});

test("real search and read calls send structured and agent-visible evidence to the audit boundary", async () => {
  const sdk = new MockSdk();
  sdk.result = { summary: "search", data: { output: "links", hits: [], metadata: { searches: 1, fallbackUsed: false, partial: false, pagesRead: 0, readAttempts: 0 } }, trust: "untrusted-external" };
  const records: unknown[] = [];
  const fx = harness(sdk, true, { record: async (input) => { records.push(input); } });
  await fx.events.get("session_start")?.({}, fx.ctx);
  await fx.execute("web_search", { query: "evidence" });
  assert.equal(records.length, 1);
  const record = records[0] as { operation: string; input: { query: string }; result: { summary: string }; presentation: { content: unknown[] } };
  assert.equal(record.operation, "web.search");
  assert.equal(record.input.query, "evidence");
  assert.equal(record.result.summary, "search");
  assert.ok(Array.isArray(record.presentation.content));

  sdk.result = { summary: "saved", data: { saved: true, path: "/home/user/.local/share/pi-web/exports/page.md", relativePath: "page.md", bytes: 100, characters: 98, sha256: "b".repeat(64), complete: true, source: { requestedUrl: "https://example.test", finalUrl: "https://example.test", title: "Page" } }, trust: "local" };
  await fx.execute("web_read", { url: "https://example.test", save: { path: "page.md" } });
  const saveRecord = records[1] as { operation: string; result: { data: unknown }; presentation: { content: unknown[] } };
  assert.equal(saveRecord.operation, "web.read");
  assert.match(JSON.stringify(saveRecord.result.data), /page\.md/);
  assert.doesNotMatch(JSON.stringify(saveRecord), /complete public content|untrustedContent/);
  await fx.events.get("session_shutdown")?.();
});

test("approval UI offers only allow-once or deny and returns the SDK decision", async () => {
  const sdk = new MockSdk();
  sdk.result = {
    summary: "approval required",
    approval: {
      id: "approval-1", operation: "sensitive interaction", target: "public fixture", capability: "browser.write",
      budget: "one action", credentialRef: "fixture-ref", reason: "test", duration: "one operation",
    },
  };
  const fx = harness(sdk);
  await fx.events.get("session_start")?.({}, fx.ctx);
  const result = await fx.execute("browser_act", { browserSessionId: "session-1", action: { kind: "navigate", url: "https://example.test" } });
  assert.deepEqual(sdk.decisions, [{ approvalId: "approval-1", decision: "allow-once" }]);
  assert.match(result.content[0].text, /approved/);
  await fx.events.get("session_shutdown")?.();
});

test("API mismatch, daemon outage, and untrusted projects fail closed", async () => {
  for (const capabilitiesValue of [
    { ...readyCapabilities, apiVersion: "1.0.0" },
    { ...readyCapabilities, daemon: "unavailable" as const },
  ]) {
    const sdk = new MockSdk();
    sdk.capabilitiesValue = capabilitiesValue;
    const fx = harness(sdk);
    await fx.events.get("session_start")?.({}, fx.ctx);
    assert.equal(fx.active.some((name) => name.startsWith("web_") || name.startsWith("browser_")), false);
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

test("optional capability failures preserve each healthy search and read tool", async () => {
  const cases: Array<{ groups: WebxCapabilities["groups"]; present: string[]; absent: string[] }> = [
    { groups: { search: true, read: true, browser: false, browserDebug: false }, present: ["web_search", "web_read"], absent: ["browser_open"] },
    { groups: { search: true, read: false, browser: false, browserDebug: false }, present: ["web_search"], absent: ["web_read", "browser_open"] },
    { groups: { search: false, read: true, browser: false, browserDebug: false }, present: ["web_read"], absent: ["web_search", "browser_open"] },
  ];
  for (const item of cases) {
    const sdk = new MockSdk();
    sdk.capabilitiesValue = { ...readyCapabilities, groups: item.groups, browserPathIds: [] };
    const fx = harness(sdk);
    await fx.events.get("session_start")?.({}, fx.ctx);
    for (const name of item.present) assert.ok(fx.active.includes(name), `${name} should remain active`);
    for (const name of item.absent) assert.ok(!fx.active.includes(name), `${name} should be inactive`);
    if (item.groups.search) await fx.execute("web_search", { query: "healthy search" });
    else await assert.rejects(fx.execute("web_search", { query: "unhealthy search" }), /backend is unhealthy/);
    if (item.groups.read) await fx.execute("web_read", { url: "https://example.test" });
    else await assert.rejects(fx.execute("web_read", { url: "https://example.test" }), /backend is unhealthy/);
    await fx.events.get("session_shutdown")?.();
  }
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

test("output compaction and visual transfer have deterministic bounds", () => {
  let value: unknown = "leaf";
  for (let index = 0; index < 20; index += 1) value = { value };
  const result = presentResult({ summary: "ok", data: value });
  assert.doesNotMatch(JSON.stringify(result.details), /leaf/);
  assert.match(JSON.stringify(result.content), /depth limit/);

  const continued = presentResult({ summary: "read", data: {
    title: "Bounded page", url: "https://example.test/page", untrustedContent: "partial",
    truncated: true,
    metadata: { source: "trafilatura" },
  } });
  assert.match(JSON.stringify(continued.content), /Content truncated/);
  assert.doesNotMatch(JSON.stringify(continued.content), /artifactId|pageId|saved=|recallable=/);

  const visibleId = `cnt_${"z".repeat(32)}`;
  const hostileTitle = "hostile-title-".repeat(10_000);
  const titled = presentResult({ summary: "read", title: hostileTitle, data: {
    title: hostileTitle, url: "https://example.test/long", untrustedContent: "body", truncated: true,
    metadata: { contentId: visibleId, reader: { contentId: visibleId, returnedCharacters: 4, totalCharacters: 40_000, nextStoredOffset: 4 } },
  } });
  const titledText = titled.content[0]?.type === "text" ? titled.content[0].text : "";
  assert.ok(titledText.length <= MAX_MODEL_CHARS);
  assert.match(titledText, new RegExp(visibleId));

  const paged = presentResult({ summary: "read", data: {
    title: "API rows", url: "https://example.test/api", untrustedContent: "[]", truncated: false,
    metadata: { reader: { returnedItems: 5, matchedItems: 10, nextItemOffset: 5, returnedCharacters: 2, totalCharacters: 2, complete: true } },
  } });
  assert.match(JSON.stringify(paged.content), /Returned 5 of 10 items; continue with itemOffset=5/);
  assert.match(JSON.stringify(paged.content), /Returned 2 characters; extracted total 2; complete/);

  const saved = presentResult({ summary: "saved", trust: "local", data: { saved: true, path: "/home/user/.local/share/pi-web/exports/notes/page.md", relativePath: "notes/page.md", bytes: 123, characters: 120, sha256: "a".repeat(64), complete: true, source: { requestedUrl: "https://example.test", finalUrl: "https://example.test/final", title: "Page" } } });
  assert.match(JSON.stringify(saved.content), /Saved Markdown/);
  assert.match(JSON.stringify(saved.content), /Complete: yes/);
  assert.doesNotMatch(JSON.stringify(saved.content), /untrustedContent/);

  const extracts = presentResult({ summary: "search", data: { query: "feature", output: "extracts", hits: [{ title: "Source", url: "https://example.test/source", snippet: "Focused supporting passage." }], metadata: { searches: 1, fallbackUsed: false, partial: true, pagesRead: 1, readAttempts: 2 } } });
  assert.match(JSON.stringify(extracts.content), /extracts; 1 search\(es\); 1 successful page read\(s\) from 2 attempt\(s\)/);
  assert.match(JSON.stringify(extracts.content), /Partial result/);
  assert.match(JSON.stringify(extracts.content), /Extract: Focused supporting passage/);

  const completePage = "main-content-".repeat(5_000);
  const complete = presentResult({ summary: "read", data: { title: "Full page", url: "https://example.test/full", untrustedContent: completePage, truncated: false } });
  const completeText = complete.content[0]?.type === "text" ? complete.content[0].text : "";
  assert.ok(completeText.length <= MAX_MODEL_CHARS);
  assert.match(completeText, /truncated by Pi WebX facade/);

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
