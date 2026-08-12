#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBrowserRunner, deepFind, resetDirectory, startFixtureServer } from "./lib/agent-browser.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = resolve(process.env.PI_WEB_BENCH_ROOT || join(tmpdir(), `pi-web-bench-${process.pid}`));
const iterations = Math.max(1, Number(process.env.PI_WEB_BENCH_ITERATIONS || 5));
const namespace = process.env.AGENT_BROWSER_NAMESPACE || `pi-web-bench-${process.pid}`;
const reportPath = resolve(process.env.PI_WEB_BENCH_REPORT || join(work, "report.json"));
await resetDirectory(work);
await mkdir(join(work, "screenshots"), { recursive: true });
const fixture = await startFixtureServer(root);
const report = { generatedAt: new Date().toISOString(), iterations, machine: process.platform, engines: {}, ok: false };

try {
  report.engines.lightpanda = await benchmarkEngine("lightpanda");
  report.engines.chromium = await benchmarkEngine("chrome");
  report.ok = true;
} catch (error) {
  report.error = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, command: error?.record };
  process.exitCode = 1;
} finally {
  await fixture.stop();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

async function benchmarkEngine(engine) {
  const session = `${engine}-${process.pid}`;
  const runner = new AgentBrowserRunner({
    namespace,
    session,
    engine,
    profile: engine === "chrome" ? join(work, "profile") : undefined,
    downloadPath: join(work, "downloads", engine),
  });
  const samples = { coldOpen: [], warmAction: [], mainObservation: [], interactiveSnapshot: [], screenshot: [] };
  try {
    samples.coldOpen.push(runner.run(["open", `${fixture.baseUrl}/spa`]).elapsedMs);
    runner.run(["wait", "750"]);
    for (let index = 0; index < iterations; index += 1) {
      samples.warmAction.push(runner.run(["click", "#add"]).elapsedMs);
      samples.mainObservation.push(runner.run(["read"]).elapsedMs);
      const snapshot = runner.run(["snapshot", "-i"]);
      samples.interactiveSnapshot.push({ elapsedMs: snapshot.elapsedMs, bytes: Buffer.byteLength(snapshot.stdout || JSON.stringify(snapshot.json || {})) });
      if (engine === "chrome") {
        const path = join(work, "screenshots", `${engine}-${index}.jpg`);
        samples.screenshot.push(runner.run(["screenshot", path, "--screenshot-format", "jpeg", "--screenshot-quality", "75"]).elapsedMs);
      }
      runner.run(["reload"]);
      runner.run(["wait", "750"]);
    }
    const sessionInfo = runner.run(["session", "info"], { allowFailure: true });
    const daemonPid = deepFind(sessionInfo.json, (value, key) => /pid/i.test(key) && Number.isInteger(value));
    return {
      engine: engine === "chrome" ? "chromium" : engine,
      samples,
      summary: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summarize(values)])),
      daemonPid: daemonPid || null,
      daemonRssKiB: daemonPid ? rss(daemonPid) : null,
    };
  } finally {
    runner.close();
  }
}

function summarize(values) {
  const numbers = values.map((value) => typeof value === "number" ? value : value.elapsedMs).sort((a, b) => a - b);
  if (!numbers.length) return null;
  return {
    count: numbers.length,
    minMs: numbers[0],
    medianMs: percentile(numbers, 0.5),
    p95Ms: percentile(numbers, 0.95),
    maxMs: numbers.at(-1),
    meanMs: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    meanBytes: values.every((value) => typeof value === "object") ? values.reduce((sum, value) => sum + value.bytes, 0) / values.length : undefined,
  };
}
function percentile(sorted, fraction) { return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
function rss(pid) {
  try {
    const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
    return Number(String(result.stdout).trim()) || null;
  } catch {
    return null;
  }
}
