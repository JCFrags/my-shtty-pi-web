import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { dataDir, logMessagesContaining } from "./db/client";

export const attachmentsDir = path.join(dataDir, "attachments");

let nextId = 0;
async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

export async function persistAttachment(tmpPath: string): Promise<string | null> {
  if (!(await waitForFile(tmpPath, 5000))) return null;
  mkdirSync(attachmentsDir, { recursive: true });
  const name = `${Date.now()}-${nextId++}${path.extname(tmpPath) || ".png"}`;
  const durable = path.join(attachmentsDir, name);
  try {
    copyFileSync(tmpPath, durable, constants.COPYFILE_FICLONE);
  } catch {
    return null;
  }
  return durable;
}

const SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function sweepAttachments(): void {
  let names: string[];
  try {
    names = readdirSync(attachmentsDir);
  } catch {
    return;
  }
  if (names.length === 0) return;
  const referenced = new Set<string>();
  for (const message of logMessagesContaining("/attachments/")) {
    for (const name of names) {
      if (message.includes(name)) referenced.add(name);
    }
  }
  for (const name of names) {
    if (referenced.has(name)) continue;
    const file = path.join(attachmentsDir, name);
    try {
      if (Date.now() - statSync(file).mtimeMs > SWEEP_GRACE_MS) {
        rmSync(file, { force: true });
      }
    } catch {
      continue;
    }
  }
}
