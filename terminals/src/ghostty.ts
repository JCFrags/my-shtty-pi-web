import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Backend,
  Direction,
  Pane,
  callerTty,
  setPaneWorkingDirectory,
  shellQuote,
  sleep,
} from "./shared";

const LIST_SCRIPT = `
on run argv
  set out to ""
  set sep to tab
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          set out to out & (id of w) & sep & (id of tb) & sep & (id of term) & sep & (working directory of term) & sep & (name of term) & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`;

const FIND_BY_CWD_SCRIPT = `
on run argv
  set wanted to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (working directory of term) is wanted then return (id of term) as text
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
`;

const SEND_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  set payload to item 2 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) is targetId then
            input text payload to term
            focus term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const FOCUS_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            focus term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const FOCUS_ID_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) as text is targetId then
            focus term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const RESIZE_SCRIPT = `
on run argv
  set needle to item 1 of argv
  set resizeAction to item 2 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            set r to perform action resizeAction on term
            return r as text
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const FIND_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then return (id of term) as text
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
`;

const CLOSE_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  delay 0.3
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) as text is targetId then
            close term
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run
`;

const ZOOM_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            perform action "toggle_split_zoom" on term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const splitScript = (direction: Direction) => `
on run argv
  set targetId to item 1 of argv
  set cmdText to item 2 of argv
  set startDir to item 3 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) as text is targetId then
            split term direction ${direction} with configuration {initial working directory:startDir, initial input:cmdText & linefeed}
            return
          end if
        end repeat
      end repeat
    end repeat
    error "this pane went away before we could split it"
  end tell
end run
`;

function osascript(script: string, args: string[]): string {
  try {
    return execFileSync("osascript", ["-", ...args], {
      encoding: "utf8",
      input: script,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const signal = (error as { signal?: string }).signal;
    if (signal === "SIGTERM") {
      throw new Error(
        "controlling Ghostty timed out — this environment may lack macOS automation permission for Ghostty",
      );
    }
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) throw new Error(`controlling Ghostty failed: ${stderr}`);
    throw error;
  }
}

interface Surface {
  window: string;
  tab: string;
  pane: string;
  cwd: string;
  title: string;
}

function listSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  for (const line of osascript(LIST_SCRIPT, []).split("\n")) {
    if (!line.trim()) continue;
    const [window, tab, pane, cwd, ...title] = line.split("\t");
    surfaces.push({ window, tab, pane, cwd, title: title.join("\t") });
  }
  return surfaces;
}

const MARKER_ATTEMPTS = 6;

function markerDirectory(): string {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-pane-"));
  } catch {
    return path.join(os.tmpdir(), `terminal-browser-pane-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  }
}

async function selfPane(): Promise<{ id: string; cwd: string; surfaces: Surface[] }> {
  const tty = callerTty();
  if (!tty) throw new Error("no terminal tty found for this process");
  const surfaces = listSurfaces();
  const marker = markerDirectory();
  let restoreTo = process.cwd();
  try {
    for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
      setPaneWorkingDirectory(tty, marker);
      if (attempt > 0) await sleep(120);
      const id = osascript(FIND_BY_CWD_SCRIPT, [marker]).trim();
      if (id) {
        restoreTo = surfaces.find((surface) => surface.pane === id)?.cwd || restoreTo;
        return { id, cwd: restoreTo, surfaces };
      }
    }
    throw new Error(
      `could not find this pane in Ghostty — we marked ${tty} and no Ghostty pane reported it back, so ${tty} is not a Ghostty pane (a shell inside tmux or a remote session looks like this)`,
    );
  } finally {
    setPaneWorkingDirectory(tty, restoreTo);
    fs.rmSync(marker, { recursive: true, force: true });
  }
}

export const ghostty: Backend = {
  app: "ghostty",
  async panes() {
    const { id, surfaces } = await selfPane();
    return surfaces.map((surface) => ({
      window: surface.window,
      tab: surface.tab,
      pane: surface.pane,
      title: surface.title,
      self: surface.pane === id,
    }));
  },
  async listAll(): Promise<Omit<Pane, "self">[]> {
    return listSurfaces().map((surface) => ({
      window: surface.window,
      tab: surface.tab,
      pane: surface.pane,
      title: surface.title,
    }));
  },
  async sendText(paneId, text) {
    return osascript(SEND_SCRIPT, [paneId, text]).trim() === "ok";
  },
  async split(direction, command) {
    const { id, cwd } = await selfPane();
    osascript(splitScript(direction), [id, shellQuote(command), cwd]);
  },
  async focusPane(titleNeedle) {
    return osascript(FOCUS_SCRIPT, [titleNeedle]).trim() === "ok";
  },
  async focusSelf() {
    const { id } = await selfPane();
    return osascript(FOCUS_ID_SCRIPT, [id]).trim() === "ok";
  },
  async resizePane(titleNeedle, grow, points) {
    const amount = Math.round(Math.abs(points));
    if (amount < 3) return true;
    const opposite: Record<Direction, Direction> = {
      left: "right",
      right: "left",
      up: "down",
      down: "up",
    };
    const direction = points >= 0 ? grow : opposite[grow];
    // the pane sets its title marker shortly after launch; retry the lookup
    for (let attempt = 0; attempt < 8; attempt++) {
      const out = osascript(RESIZE_SCRIPT, [
        titleNeedle,
        `resize_split:${direction},${amount}`,
      ]).trim();
      if (out === "true") return true;
      if (out === "false") return false;
      await sleep(250);
    }
    return false;
  },
  async closePane(titleNeedle) {
    let id: string;
    try {
      id = osascript(FIND_SCRIPT, [titleNeedle]).trim();
    } catch {
      return false;
    }
    if (!id) return false;
    const closer = spawn("osascript", ["-", id], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    closer.stdin.end(CLOSE_SCRIPT);
    closer.unref();
    return true;
  },
  async zoomPane(titleNeedle) {
    try {
      return osascript(ZOOM_SCRIPT, [titleNeedle]).trim() === "ok";
    } catch {
      return false;
    }
  },
};
