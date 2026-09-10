import fs from "node:fs";
import path from "node:path";

export function installedVersion(): string | null {
  const root = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function upgradeCommand(): Promise<number> {
  throw new Error("upstream auto-upgrade is disabled for this integration. Use the bundled scripts/install.sh stage, activate, status and rollback commands with a reviewed complete integration archive.");
}
