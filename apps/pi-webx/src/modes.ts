import type { WebxCapabilities } from "./sdk.js";

export type WebMode = "off" | "read" | "browser" | "debug";

export const TOOL_NAMES = [
  "web_search",
  "web_read",
  "web_content",
  "browser_open",
  "browser_tabs",
  "browser_observe",
  "browser_act",
  "browser_debug",
] as const;

const rank: Record<WebMode, number> = { off: 0, read: 1, browser: 2, debug: 3 };

export function availableTools(mode: WebMode, capabilities: WebxCapabilities | undefined): string[] {
  if (!capabilities || capabilities.daemon !== "ready" || mode === "off") return [];
  const tools: string[] = [];
  if (capabilities.groups.search) tools.push("web_search");
  if (capabilities.groups.read) tools.push("web_read", "web_content");
  if (rank[mode] >= rank.browser && capabilities.groups.browser) {
    tools.push("browser_open", "browser_tabs", "browser_observe", "browser_act");
  }
  if (mode === "debug" && capabilities.groups.browserDebug) tools.push("browser_debug");
  return tools;
}
