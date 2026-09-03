import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiBrowserClient } from "./client.js";
import type { BrowserAction, ToolContext } from "./client.js";

function context(ctx: ExtensionContext, signal?: AbortSignal): ToolContext {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    signal,
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

const openParameters = Type.Object({
  url: Type.Optional(Type.String({ maxLength: 8192, description: "Optional URL or local HTML path" })),
  new_tab: Type.Optional(Type.Boolean({ description: "Open the URL in a new tab when reusing the companion" })),
  focus: Type.Optional(Type.Boolean({ description: "Focus the companion pane; defaults to true" })),
}, { additionalProperties: false });

const tabsParameters = Type.Object({
  action: StringEnum(["list", "activate", "open", "close"] as const),
  tab_id: Type.Optional(Type.Integer({ minimum: 1 })),
  url: Type.Optional(Type.String({ maxLength: 8192 })),
}, { additionalProperties: false });

const observeParameters = Type.Object({
  max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  include_text: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const actParameters = Type.Object({
  action: StringEnum(["click", "type", "press_key", "scroll", "navigate", "get_url", "wait_for"] as const),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  text: Type.Optional(Type.String({ maxLength: 32768 })),
  replace: Type.Optional(Type.Boolean()),
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  dx: Type.Optional(Type.Number({ minimum: -20000, maximum: 20000 })),
  dy: Type.Optional(Type.Number({ minimum: -20000, maximum: 20000 })),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  condition: Type.Optional(StringEnum(["exists", "visible", "text"] as const)),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
}, { additionalProperties: false });

const controlParameters = Type.Object({
  action: StringEnum(["status", "pause", "resume"] as const),
}, { additionalProperties: false });

function browserAction(params: {
  action: "click" | "type" | "press_key" | "scroll" | "navigate" | "get_url" | "wait_for";
  ref?: string;
  text?: string;
  replace?: boolean;
  key?: string;
  dx?: number;
  dy?: number;
  url?: string;
  condition?: "exists" | "visible" | "text";
  timeout_ms?: number;
}): BrowserAction {
  if (params.action === "click") {
    if (!params.ref) throw new Error("click requires ref from browser_observe");
    return { action: "click", ref: params.ref };
  }
  if (params.action === "type") {
    if (!params.ref || params.text === undefined) throw new Error("type requires ref and text");
    return { action: "type", ref: params.ref, text: params.text, replace: params.replace };
  }
  if (params.action === "press_key") {
    if (!params.key) throw new Error("press_key requires key");
    return { action: "press_key", key: params.key };
  }
  if (params.action === "scroll") {
    if (params.dy === undefined) throw new Error("scroll requires dy");
    return { action: "scroll", dy: params.dy, dx: params.dx };
  }
  if (params.action === "navigate") {
    if (!params.url) throw new Error("navigate requires url");
    return { action: "navigate", url: params.url };
  }
  if (params.action === "get_url") return { action: "get_url" };
  if (!params.ref && !params.text) throw new Error("wait_for requires ref or text");
  return {
    action: "wait_for",
    ref: params.ref,
    text: params.text,
    condition: params.condition,
    timeoutMs: params.timeout_ms,
  };
}

export default function terminalBrowserExtension(pi: ExtensionAPI): void {
  const client = new PiBrowserClient();

  pi.registerTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open or reuse the companion terminal-browser owned by this Pi pane. Returns bounded tab state and never requires a browser key.",
    promptSnippet: "Open or reuse this Pi pane's companion browser",
    promptGuidelines: ["Use browser_open before browser_observe. Reuse the returned companion instead of opening another browser."],
    parameters: openParameters,
    async execute(_id, params, signal, _update, ctx) {
      return result(await client.open(context(ctx, signal), {
        url: params.url,
        newTab: params.new_tab,
        focus: params.focus,
      }));
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List, activate, open, or close tabs in this Pi pane's companion browser. Results are limited to 32 tabs.",
    parameters: tabsParameters,
    async execute(_id, params, signal, _update, ctx) {
      if ((params.action === "activate" || params.action === "close") && params.tab_id === undefined) {
        throw new Error(`${params.action} requires tab_id`);
      }
      return result(await client.tabs(context(ctx, signal), {
        action: params.action,
        tabId: params.tab_id,
        url: params.url,
      }));
    },
  });

  pi.registerTool({
    name: "browser_observe",
    label: "Browser Observe",
    description: "Read a bounded accessibility observation from the active companion tab. Element refs remain internal to the current page observation.",
    promptSnippet: "Observe the active companion browser tab before acting",
    promptGuidelines: ["Use browser_observe after browser_open and after each page-changing browser_act call. Then use one browser_act action."],
    parameters: observeParameters,
    async execute(_id, params, signal, _update, ctx) {
      return result(await client.observe(context(ctx, signal), {
        maxElements: params.max_elements,
        includeText: params.include_text,
      }));
    },
  });

  pi.registerTool({
    name: "browser_act",
    label: "Browser Act",
    description: "Perform one native action in this Pi pane's companion browser: click, type, press_key, scroll, navigate, get_url, or wait_for. Observation and control identifiers are managed internally.",
    promptSnippet: "Perform one native companion-browser action",
    promptGuidelines: ["Use browser_act for exactly one action per call, then use browser_observe again when the page may have changed."],
    parameters: actParameters,
    async execute(_id, params, signal, _update, ctx) {
      return result(await client.act(context(ctx, signal), browserAction(params)));
    },
  });

  pi.registerTool({
    name: "browser_control",
    label: "Browser Control",
    description: "Read, pause, or resume browser-wide agent control for this Pi pane's companion. Resume refreshes the internal observation automatically.",
    parameters: controlParameters,
    async execute(_id, params, signal, _update, ctx) {
      return result(await client.control(context(ctx, signal), params.action));
    },
  });
}
