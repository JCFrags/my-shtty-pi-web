import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { launchArguments, NodeWorkspaceLauncher } from "../src/workspace-launcher.js";

test("builds only fixed bounded Tauri single-instance arguments", () => {
  assert.deepEqual(launchArguments({ action: "show" }), ["--raise"]);
  assert.deepEqual(launchArguments({ action: "hide" }), ["--hide"]);
  assert.deepEqual(launchArguments({ action: "return" }), ["--return-control"]);
  assert.deepEqual(launchArguments({ action: "attach", browserSessionId: "session:one", tabId: "tab:one" }), [
    "--raise", "--select-session=session:one", "--select-tab=tab:one",
  ]);
  assert.deepEqual(launchArguments({ action: "takeover", browserSessionId: "session:one", tabId: "tab:one" }), [
    "--raise", "--select-session=session:one", "--select-tab=tab:one", "--take-control",
  ]);
  assert.throws(() => launchArguments({ action: "attach", browserSessionId: "/tmp/socket" }), /valid browser session ID/);
  assert.throws(() => launchArguments({ action: "takeover" }), /valid browser session ID/);
  assert.throws(() => launchArguments({ action: "attach", browserSessionId: "session:one", tabId: "--shell=rm" }), /tab ID is invalid/);
  assert.throws(() => launchArguments({ action: "return", browserSessionId: "session:one" }), /does not accept a browser target/);
});

test("validates the executable then spawns it directly without a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-launcher-"));
  try {
    const executable = join(root, "pi-browser-workspace");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const calls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
    const fakeSpawn = ((resolved: string, args: readonly string[], options: unknown) => {
      calls.push({ executable: resolved, args, options });
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => undefined;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    }) as never;
    const launcher = new NodeWorkspaceLauncher({ PI_WEB_WORKSPACE_BIN: executable }, root, fakeSpawn);
    await launcher.launch({ action: "attach", browserSessionId: "session:one", tabId: "tab:one" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, executable);
    assert.deepEqual(calls[0]?.args, ["--raise", "--select-session=session:one", "--select-tab=tab:one"]);
    assert.deepEqual(calls[0]?.options, { shell: false, detached: true, stdio: "ignore" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-absolute and writable executable paths before spawning", async () => {
  let spawns = 0;
  const fakeSpawn = (() => { spawns += 1; throw new Error("must not spawn"); }) as never;
  await assert.rejects(new NodeWorkspaceLauncher({ PI_WEB_WORKSPACE_BIN: "relative/tool" }, "/unused", fakeSpawn).launch({ action: "show" }), /path is invalid/);

  const root = await mkdtemp(join(tmpdir(), "pi-workspace-launcher-"));
  try {
    const executable = join(root, "unsafe-workspace");
    await writeFile(executable, "unsafe\n", { mode: 0o700 });
    await chmod(executable, 0o722);
    await assert.rejects(new NodeWorkspaceLauncher({ PI_WEB_WORKSPACE_BIN: executable }, root, fakeSpawn).launch({ action: "show" }), /unavailable or unsafe/);
    assert.equal(spawns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
