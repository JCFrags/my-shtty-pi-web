import fs from "node:fs";
import path from "node:path";

import { app } from "electron";
import { APP_DIR_NAME, INSTALLATION } from "pixel-store";

export function claimProfile() {
  const appData = INSTALLATION?.paths.appData ?? process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
  const dir = path.join(appData, APP_DIR_NAME);
  const lock = path.join(dir, "terminal-browser.lock");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("browser profile is occupied or its ownership is uncertain; inspect the existing process and lock before an explicit recovery. No alternate profile was opened.");
  }
  app.setPath("userData", dir);
  app.on("will-quit", () => {
    try {
      if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock);
    } catch {}
  });
}
