#!/usr/bin/env node
import { createConnection } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export async function probeWebx(socketPath, ownerId = `pi-web-doctor-${process.pid}`, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("WebX doctor timeout must be positive and finite");
  const socket = createConnection({ path: socketPath });
  const deadline = setTimeout(() => socket.destroy(new Error(`WebX doctor probe timed out after ${timeoutMs} ms`)), timeoutMs);
  let buffer = "";
  let waiting;
  let bufferedFailure;
  const nextLine = () => new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    drain();
  });
  const drain = () => {
    if (!waiting) return;
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      if (bufferedFailure) {
        const failure = bufferedFailure;
        bufferedFailure = undefined;
        const receiver = waiting;
        waiting = undefined;
        receiver.reject(failure);
      }
      return;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const receiver = waiting;
    waiting = undefined;
    receiver.resolve(line);
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) socket.destroy(new Error("WebX doctor response exceeded its bound"));
    drain();
  });
  socket.on("error", (error) => {
    bufferedFailure = error;
    drain();
  });
  socket.on("close", () => {
    bufferedFailure ??= new Error("WebX closed the doctor connection");
    drain();
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ bind: { ownerId } })}\n`);
    const binding = parseObject(await nextLine(), "binding");
    if (typeof binding.bindingId !== "string" || typeof binding.bindingSecret !== "string") throw new Error("WebX returned an invalid doctor binding");
    socket.write(`${JSON.stringify({
      binding: { bindingId: binding.bindingId, bindingSecret: binding.bindingSecret },
      request: { method: "GET", path: "/v1/capabilities", maxResponseBytes: MAX_RESPONSE_BYTES },
    })}\n`);
    const response = parseObject(await nextLine(), "capability response");
    if (response.status !== 200) throw new Error(`WebX capability probe returned status ${String(response.status)}`);
    return parseObject(response.body, "capability catalog");
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

export function doctorReport(catalog) {
  const capabilities = Array.isArray(catalog.capabilities) ? catalog.capabilities : [];
  const check = (id, required) => {
    const capability = capabilities.find((item) => item?.id === id);
    const ok = capability?.enabled === true && capability?.healthy === true;
    return {
      name: id,
      required,
      ok,
      detail: ok ? "healthy" : typeof capability?.reason === "string" ? capability.reason : "not enabled or unhealthy",
    };
  };
  const checks = [
    { name: "webxd", required: true, ok: true, detail: `API ${String(catalog.apiVersion ?? "unknown")}` },
    check("search", true),
    check("read", true),
    check("browser", false),
  ];
  return { ok: checks.filter((item) => item.required).every((item) => item.ok), apiVersion: catalog.apiVersion, checks };
}

export async function runDoctor(socketPath, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  try {
    return doctorReport(await probeWebx(socketPath, undefined, timeoutMs));
  } catch (error) {
    return {
      ok: false,
      checks: [{ name: "webxd", required: true, ok: false, detail: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function parseObject(value, name) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`WebX returned an invalid ${name}`);
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((item) => item !== "--json")) {
    console.error("usage: pi-web doctor [--json]");
    process.exitCode = 2;
    return;
  }
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) throw new Error("XDG_RUNTIME_DIR is required");
  const report = await runDoctor(process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`${check.ok ? "ok" : check.required ? "FAIL" : "optional"}\t${check.name}\t${check.detail}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
