import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

/** Chromium profiles are single-process: concurrent instances sharing one
 * userData dir corrupt and deadlock the LevelDB stores (IndexedDB, Local
 * Storage — youtube's icons hang on a wedged IndexedDB, for example). Each
 * instance claims the first profile dir whose lock holder is gone; the first
 * instance keeps the original dir so logins survive. */
export function claimProfile() {
  const appData = process.env.PIXEL_BROWSER_APPDATA ?? app.getPath("appData");
  for (let i = 0; i < 32; i++) {
    const dir = path.join(appData, i === 0 ? "Pixel Browser" : `Pixel Browser ${i + 1}`);
    const lock = path.join(dir, "pixel.lock");
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      } catch {
        const holder = Number(fs.readFileSync(lock, "utf8"));
        if (holder && holder !== process.pid && alive(holder)) continue;
        fs.writeFileSync(lock, String(process.pid));
      }
      app.setPath("userData", dir);
      app.on("will-quit", () => {
        try {
          if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock);
        } catch {}
      });
      return;
    } catch {}
  }
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "pixel-browser-")));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
