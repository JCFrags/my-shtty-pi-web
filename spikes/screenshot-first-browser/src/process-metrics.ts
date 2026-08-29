import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

interface ProcSample {
  pid: number;
  ppid: number;
  ticks: number;
  rssKiB: number;
}

export interface ProcessResourceMeasurement {
  durationMs: number;
  processCount: number;
  cpuPercentOfOneCore: number;
  rssMiB: number;
}

export async function measureProcessResources(rootPids: number[], durationMs = 2_000): Promise<ProcessResourceMeasurement> {
  const first = await readProcesses();
  const includedFirst = descendants(first, rootPids);
  const started = performance.now();
  await sleep(durationMs);
  const second = await readProcesses();
  const actualDuration = performance.now() - started;
  const includedSecond = descendants(second, rootPids);
  let deltaTicks = 0;
  let rssKiB = 0;
  for (const pid of includedSecond) {
    const after = second.get(pid);
    if (!after) continue;
    rssKiB += after.rssKiB;
    const before = first.get(pid);
    if (before && includedFirst.has(pid)) deltaTicks += Math.max(0, after.ticks - before.ticks);
  }
  const clockTicksPerSecond = 100; // Linux USER_HZ on Fedora x86_64.
  return {
    durationMs: actualDuration,
    processCount: includedSecond.size,
    cpuPercentOfOneCore: (deltaTicks / clockTicksPerSecond) / (actualDuration / 1_000) * 100,
    rssMiB: rssKiB / 1024,
  };
}

async function readProcesses(): Promise<Map<number, ProcSample>> {
  const result = new Map<number, ProcSample>();
  const entries = await readdir("/proc", { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name);
    try {
      const [statText, statusText] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
      ]);
      const endName = statText.lastIndexOf(")");
      const fields = statText.slice(endName + 2).split(" ");
      const ppid = Number(fields[1]);
      const userTicks = Number(fields[11]);
      const systemTicks = Number(fields[12]);
      const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
      result.set(pid, { pid, ppid, ticks: userTicks + systemTicks, rssKiB: Number(rssMatch?.[1] ?? 0) });
    } catch {
      // Processes can exit while /proc is read.
    }
  }));
  return result;
}

function descendants(processes: Map<number, ProcSample>, roots: number[]): Set<number> {
  const result = new Set<number>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (result.has(process.ppid) && !result.has(process.pid)) {
        result.add(process.pid);
        changed = true;
      }
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
