import { readdir } from "node:fs/promises";

const IGNORE = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".data",
  ".cache",
  ".next",
  ".DS_Store",
]);

const MAX_ENTRIES = 8000;

let entries: string[] | null = null;
let walking = false;

export function fileEntries(): string[] | null {
  return entries;
}

export function refreshFiles(onDone: () => void) {
  if (walking) return;
  walking = true;
  void walk()
    .then((list) => {
      entries = list;
    })
    .finally(() => {
      walking = false;
      onDone();
    });
}

async function walk(): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = ["."];
  while (queue.length > 0 && out.length < MAX_ENTRIES) {
    const dir = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirents) {
      if (IGNORE.has(entry.name)) continue;
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        queue.push(rel);
      } else {
        out.push(rel);
      }
      if (out.length >= MAX_ENTRIES) break;
    }
  }
  return out;
}
