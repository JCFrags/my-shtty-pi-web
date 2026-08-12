#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const values = process.argv.slice(2);
if (values.includes("--help") || values.length === 0) {
  console.log("Usage: run-pinchtab-conformance.mjs --entrypoint PATH [--entrypoint-arg ARG]... --output DIR\nRuns the fixed shipped-entrypoint smoke profile. It includes the exact pinchtab/chrome SPA vertical, explicit unsupported result, no-fallback proof, cancellation, cleanup, and exact identity checks.");
  process.exit(values.length === 0 ? 2 : 0);
}
const child = spawn(process.execPath, [resolve(root, "scripts/complete-browser-check.mjs"), ...values, "--profile", "smoke"], { stdio: "inherit" });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
