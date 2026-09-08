import type { WebxCapabilities } from "./sdk.js";

export type WebMode = "off" | "read";

export const TOOL_NAMES = [
  "web_search",
  "web_read",
  "web_read_batch",
  "web_content",
] as const;


export function availableTools(mode: WebMode, capabilities: WebxCapabilities | undefined): string[] {
  if (!capabilities || capabilities.daemon !== "ready" || mode === "off") return [];
  const tools: string[] = [];
  if (capabilities.groups.search) tools.push("web_search");
  if (capabilities.groups.read) tools.push("web_read", "web_read_batch", "web_content");
  return tools;
}
