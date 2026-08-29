export type BrowserBackendSelection = "legacy" | "agentcursor";

export function browserBackendSelection(value: string | undefined): BrowserBackendSelection {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "agentcursor") return "agentcursor";
  throw new Error("WEBX_BROWSER_BACKEND must be legacy or agentcursor");
}
