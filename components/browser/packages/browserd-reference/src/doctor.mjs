#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const checks = [];
async function command(name, args = ["--version"], required = true) {
  try { const { stdout, stderr } = await execFileAsync(name, args, { timeout: 10_000 }); checks.push({ name, ok: true, detail: (stdout || stderr).trim().split("\n")[0] }); }
  catch (error) { checks.push({ name, ok: !required, required, detail: error.code === "ENOENT" ? "not installed" : error.message }); }
}
async function file(name, path, required = false) {
  try { await access(path, constants.R_OK); checks.push({ name, ok: true, detail: path }); }
  catch { checks.push({ name, ok: !required, required, detail: `not found: ${path}` }); }
}
await command("node", ["--version"]); await command("agent-browser", ["--version"]); await command("chromium-browser", ["--version"]); await command("lightpanda", ["version"], false); await command("podman", ["--version"], false); await command("cargo", ["--version"], false); await command("pnpm", ["--version"], false);
if (process.env.XDG_RUNTIME_DIR) await file("runtime-dir", process.env.XDG_RUNTIME_DIR, true);
const result = { ok: checks.every((check) => check.ok), protocolVersion: "1.0.0", checks };
console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
