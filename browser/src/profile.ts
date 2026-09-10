import fs from "node:fs";
import path from "node:path";

import { app } from "electron";
import { APP_DIR_NAME, INSTALLATION } from "pixel-store";

export interface ProfileClaim {
  release(): void;
}

export function claimProfile(): ProfileClaim {
  const appData = INSTALLATION?.paths.appData ?? process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
  const dir = path.join(appData, APP_DIR_NAME);
  const lock = path.join(dir, "terminal-browser.lock");
  fs.mkdirSync(dir, { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw new Error("browser profile is occupied or its ownership is uncertain; inspect the existing process and lock before an explicit recovery. No alternate profile was opened.");
  }
  const identity = fs.fstatSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = fs.lstatSync(lock);
      if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lock);
    } catch {}
    try { fs.closeSync(descriptor); } catch {}
  };
  try {
    fs.writeFileSync(descriptor, String(process.pid));
    app.setPath("userData", dir);
  } catch (error) {
    release();
    throw error;
  }
  app.on("will-quit", release);
  return { release };
}
