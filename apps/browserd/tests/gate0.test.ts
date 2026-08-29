import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { BrowserProtocolError } from "@webx/browser-protocol";
import { BrowserRuntime } from "@webx/browser-runtime";
import { prepareDescriptor, readDescriptor } from "../src/descriptor.js";
import { BrowserdServer } from "../src/server.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
const servers: BrowserdServer[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await childExit(child); }
  await Promise.allSettled(servers.splice(0).map(async (server) => await server.stop()));
  await Promise.allSettled(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "browserd-gate0-")); directories.push(value); return value; }
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
interface ChildRecord { state: "ready" | "failed"; code?: string; descriptor?: { runtimeInstanceId: string; socketPath: string } }
async function childRecord(child: ChildProcess): Promise<ChildRecord> {
  if (child.stdout === null) throw new Error("child stdout unavailable");
  return await new Promise<ChildRecord>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("child startup timeout")), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end)) as ChildRecord); } catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (!buffer.includes("\n")) { clearTimeout(timer); reject(new Error(`child exited before result: ${code}`)); } });
  });
}
async function childExit(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
function spawnServer(runtimeDirectory: string): ChildProcess {
  const childFile = fileURLToPath(new URL("./startup-race-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", childFile, runtimeDirectory], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

describe("Gate 0 kernel ownership and cleanup-final shutdown", () => {
  it("releases kernel ownership on process death and admits exactly one of three immediate successors", async () => {
    const runtimeDirectory = await directory();
    const first = spawnServer(runtimeDirectory);
    assert.equal((await childRecord(first)).state, "ready");
    first.kill("SIGKILL");
    await childExit(first);
    children.splice(children.indexOf(first), 1);

    const successors = [spawnServer(runtimeDirectory), spawnServer(runtimeDirectory), spawnServer(runtimeDirectory)];
    const results = await Promise.all(successors.map(async (child) => await childRecord(child)));
    assert.equal(results.filter((result) => result.state === "ready").length, 1);
    assert.equal(results.filter((result) => result.state === "failed" && result.code === "OPERATION_CONFLICT").length, 2);
    const descriptor = await readDescriptor(join(runtimeDirectory, "browserd.json"));
    assert.equal(descriptor.runtimeInstanceId, results.find((result) => result.state === "ready")?.descriptor?.runtimeInstanceId);
    const entries = await readdir(runtimeDirectory);
    assert.equal(entries.filter((name) => name.endsWith(".sock")).length, 1);
    assert.equal(entries.filter((name) => name.includes(".tmp")).length, 0);
  });

  it("fails closed on an unsupported ownership platform fixture", async () => {
    const runtimeDirectory = await directory();
    await assert.rejects(() => prepareDescriptor(runtimeDirectory, { ownershipPlatformForTest: "darwin" }), (error) => error instanceof BrowserProtocolError && error.code === "CAPABILITY_UNAVAILABLE");
    assert.equal((await readdir(runtimeDirectory)).filter((name) => name.endsWith(".sock") || name.endsWith(".json") || name.includes(".tmp")).length, 0);
  });

  it("removes the endpoint despite runtime cleanup failure and allows retry plus a new server object", async () => {
    class FailOnceRuntime extends BrowserRuntime {
      closeCalls = 0;
      override async close(): Promise<void> { if (++this.closeCalls === 1) throw new Error("injected runtime cleanup failure"); }
    }
    const runtimeDirectory = await directory();
    const runtime = new FailOnceRuntime();
    const server = new BrowserdServer({ runtimeDirectory, runtime });
    servers.push(server);
    const descriptor = await server.start();
    await assert.rejects(() => server.stop(), /shutdown cleanup failed/i);
    await assert.rejects(() => stat(join(runtimeDirectory, "browserd.json")));
    await assert.rejects(() => stat(descriptor.socketPath));
    await server.stop();
    assert.equal(runtime.closeCalls, 2);
    await assert.rejects(() => server.start(), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");

    const replacement = new BrowserdServer({ runtimeDirectory, runtime: new BrowserRuntime() });
    servers.push(replacement);
    await replacement.start();
    assert.equal((await stat(replacement.descriptor.socketPath)).isSocket(), true);
  });

  it("shares concurrent stop and removes descriptor, socket, and ownership once", async () => {
    const gate = deferred();
    class BlockingRuntime extends BrowserRuntime {
      closeCalls = 0;
      override async close(): Promise<void> { this.closeCalls++; await gate.promise; }
    }
    const runtime = new BlockingRuntime();
    const runtimeDirectory = await directory();
    const server = new BrowserdServer({ runtimeDirectory, runtime });
    servers.push(server);
    const descriptor = await server.start();
    const first = server.stop();
    const second = server.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.closeCalls, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(runtime.closeCalls, 1);
    await assert.rejects(() => stat(join(runtimeDirectory, "browserd.json")));
    await assert.rejects(() => stat(descriptor.socketPath));
    assert.equal((await readdir(runtimeDirectory)).filter((name) => name.endsWith(".sock") || name.includes(".tmp")).length, 0);
  });
});
