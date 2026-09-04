import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const OLD_BROWSER_TOOLS = new Set([
  "browser_open",
  "browser_tabs",
  "browser_observe",
  "browser_act",
  "browser_debug",
]);

export const DEFAULT_WEB_RESEARCH_EXTENSION = path.join(
  os.homedir(),
  ".local/share/pi-terminal-browser/pi-web-search-read/extension.mjs",
);

/** Load Pi Web's research tools while retiring its previous browser provider. */
export async function loadWebResearch(
  pi: ExtensionAPI,
  extensionPath = process.env.PI_WEB_SEARCH_READ_EXTENSION ?? DEFAULT_WEB_RESEARCH_EXTENSION,
): Promise<boolean> {
  if (!fs.existsSync(extensionPath)) return false;

  const filtered = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: { name: string }) => {
          if (!OLD_BROWSER_TOOLS.has(tool.name)) target.registerTool(tool as never);
        };
      }
      if (property === "setActiveTools") {
        return (names: string[]) => {
          const requested = names.filter((name) => !OLD_BROWSER_TOOLS.has(name));
          const currentBrowser = target.getActiveTools().filter((name) => OLD_BROWSER_TOOLS.has(name));
          target.setActiveTools([...new Set([...requested, ...currentBrowser])]);
        };
      }
      if (property === "on") {
        return (event: string, handler: unknown) => {
          if (event !== "before_agent_start") (target.on as Function)(event, handler);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  const loaded = await import(pathToFileURL(extensionPath).href) as { default?: ExtensionFactory };
  if (typeof loaded.default !== "function") throw new Error("Pi Web research extension has no default export");
  await loaded.default(filtered);
  return true;
}
