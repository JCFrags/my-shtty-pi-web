import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchMode } from "./launch-mode.js";

export function cliCommand(args: string[]): [string, string[]] {
  const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../..");
  if (launchMode === "source") {
    return [process.execPath, [join(root, "cli/dist/main.js"), ...args]];
  }
  const launcher = join(root, "bin/terminal-browser");
  if (realpathSync(launcher) !== launcher) throw new Error("Bundle launcher must stay inside its artifact root.");
  return [launcher, args];
}
