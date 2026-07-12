import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { store } from "./session";

export interface FontOption {
  label: string;
  path: string;
}

const FONT_DIRS = [
  path.join(os.homedir(), "Library/Fonts"),
  "/Library/Fonts",
  "/System/Library/Fonts",
];

let options: FontOption[] | null = null;

export function fontOptions(): FontOption[] {
  if (options) return options;
  const seen = new Set<string>();
  const found: FontOption[] = [];
  for (const dir of FONT_DIRS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (ext !== ".ttf" && ext !== ".otf") continue;
      const label = path.basename(entry, path.extname(entry));
      if (seen.has(label)) continue;
      seen.add(label);
      found.push({ label, path: path.join(dir, entry) });
    }
  }
  options = found.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

export interface FontRow {
  label: string;
  path: string | null;
}

export function fontRows(query: string): FontRow[] {
  const q = query.trim().toLowerCase();
  const rows: FontRow[] = [];
  if (!q || "default".includes(q)) rows.push({ label: "default", path: null });
  for (const font of fontOptions()) {
    if (!q || font.label.toLowerCase().includes(q)) rows.push(font);
  }
  return rows;
}

let register: ((path: string) => Promise<number>) | null = null;

export function initFonts(registerFont: (path: string) => Promise<number>): void {
  register = registerFont;
  if (store.fontPath) void applyFont(store.fontPath);
}

export async function applyFont(fontPath: string | null): Promise<void> {
  if (!fontPath || !register) {
    store.setFont(null, 0);
    return;
  }
  try {
    store.setFont(fontPath, await register(fontPath));
  } catch {
    store.setFont(null, 0);
  }
}
