#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { storagePolicyReport } from "../packages/policy/storage.mjs";

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

export function doctorReport(catalog, profile = undefined) {
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
    check("browser", profile?.resolvedProfiles?.includes("browser") === true),
  ];
  if (profile !== undefined) checks.push(...profileDoctorChecks(profile));
  return { ok: checks.filter((item) => item.required).every((item) => item.ok), apiVersion: catalog.apiVersion, policy: storagePolicyReport(), checks };
}

function commandAvailable(command, pathValue = process.env.PATH ?? "") {
  return pathValue.split(":").some((directory) => directory && existsSync(`${directory}/${command}`));
}

const VALIDATED_MODEL_ASSET_SETS = new Map(); // Populate only after an acceptance run validates the exact asset set.

export function documentAssetReadiness(directory = process.env.DOCLING_ARTIFACTS_PATH ?? `${process.env.XDG_CACHE_HOME ?? `${process.env.HOME}/.cache`}/pi-web/document-models`) {
  const unavailable = (detail) => ({ manifestValidated: false, office: false, scannedPdf: false, detail });
  try {
    const manifestPath = `${directory}/model-assets.json`;
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65_536) return unavailable("model asset manifest is absent or unsafe");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 256) return unavailable("model asset manifest is invalid");
    const capabilities = manifest.capabilities;
    if (!Array.isArray(capabilities) || capabilities.some((item) => item !== "office" && item !== "scanned-pdf")) return unavailable("model asset capabilities are invalid");
    const approved = VALIDATED_MODEL_ASSET_SETS.get(manifest.assetSetId);
    if (!approved || JSON.stringify(approved.capabilities) !== JSON.stringify(capabilities) || JSON.stringify(approved.files) !== JSON.stringify(manifest.files)) return unavailable("model asset set has no validated acceptance record in this release");
    for (const item of manifest.files) {
      if (typeof item?.path !== "string" || !item.path || item.path.startsWith("/") || item.path.split("/").includes("..") || !/^[0-9a-f]{64}$/u.test(item.sha256)) return unavailable("model asset declaration is invalid");
      const path = `${directory}/${item.path}`;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return unavailable("model asset is missing or unsafe");
      if (approved.digests[item.path] !== item.sha256) return unavailable("model asset digest mismatch");
    }
    return { manifestValidated: true, office: capabilities.includes("office"), scannedPdf: capabilities.includes("scanned-pdf"), detail: `validated ${manifest.files.length} declared model asset file(s)` };
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "model asset manifest is absent" : error instanceof Error ? error.message : String(error));
  }
}

export function profileDoctorChecks(profile, root = process.env.PI_WEB_INSTALL_ROOT) {
  const resolved = Array.isArray(profile?.resolvedProfiles) ? profile.resolvedProfiles : [];
  const limits = profile?.resourceLimits;
  const valid = profile?.schemaVersion === 1 && resolved.includes("web-core");
  const checks = [{ name: "installed-profile", required: true, ok: valid, detail: valid ? resolved.join(", ") : "profile manifest is invalid" }];
  const reader = limits?.["pi-web-reader.service"];
  const search = limits?.["pi-web-searxng.service"];
  const limitsOk = reader?.MemoryMax === "2G" && reader?.TasksMax === 512 && search?.MemoryMax === "2G" && search?.TasksMax === 512;
  checks.push({ name: "core-resource-limits", required: true, ok: limitsOk, detail: limitsOk ? "reader and SearXNG: MemoryMax=2G, TasksMax=512" : "reviewed core limits are missing" });
  if (resolved.includes("documents")) {
    const documentLimits = limits?.["pi-web-docling.service"];
    const bounded = documentLimits?.MemoryMax === "4G" && documentLimits?.TasksMax === 128
      && documentLimits?.Concurrency === 1 && documentLimits?.QueueSize === 2
      && documentLimits?.TimeoutSeconds === 120 && documentLimits?.MaxInputBytes === 268_435_456
      && documentLimits?.MaxTempBytes === 536_870_912 && documentLimits?.MaxOutputBytes === 16_777_216;
    checks.push({ name: "pdftotext", required: true, ok: commandAvailable("pdftotext"), detail: commandAvailable("pdftotext") ? "available for text PDF extraction" : "pdftotext is missing" });
    checks.push({ name: "document-resource-limits", required: true, ok: bounded, detail: bounded ? "concurrency=1, queue=2, timeout=120s, memory=4G, tasks=128, temp=512MiB, input=256MiB, output=16MiB" : "reviewed document limits are missing" });
    const assets = documentAssetReadiness();
    checks.push({ name: "office-model-assets", required: false, ok: assets.office, detail: assets.office ? assets.detail : `Office unavailable: ${assets.detail}` });
    checks.push({ name: "scanned-pdf-model-assets", required: false, ok: assets.scannedPdf, detail: assets.scannedPdf ? assets.detail : `scanned PDF unavailable: ${assets.detail}` });
  }
  if (root) {
    const requiredPaths = ["apps/webxd/dist/apps/webxd/src/main.js", ".venv/bin/pi-web-reader"];
    if (resolved.includes("documents")) requiredPaths.push(".venv/bin/pi-web-docling");
    if (resolved.includes("render")) requiredPaths.push(".venv/bin/pi-web-crawl", ".playwright-browsers");
    if (resolved.includes("browser")) requiredPaths.push("bin/pi-browserd", "bin/pi-browser-workspace", ".agent-browser/node_modules/.bin/agent-browser");
    const missing = requiredPaths.filter((path) => !existsSync(`${root}/${path}`));
    checks.push({ name: "profile-dependencies", required: true, ok: missing.length === 0, detail: missing.length === 0 ? "installed artifacts are present" : `missing: ${missing.join(", ")}` });
  }
  return checks;
}

export async function runDoctor(socketPath, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, profile = undefined) {
  try {
    return doctorReport(await probeWebx(socketPath, undefined, timeoutMs), profile);
  } catch (error) {
    return {
      ok: false,
      policy: storagePolicyReport(),
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
  const profilePath = process.env.PI_WEB_PROFILE_MANIFEST ?? `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/pi-web/installed-profile.json`;
  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    if (process.env.PI_WEB_PROFILE_MANIFEST) throw new Error("cannot read installed profile", { cause: error });
  }
  const report = await runDoctor(process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`, DEFAULT_PROBE_TIMEOUT_MS, profile);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`${check.ok ? "ok" : check.required ? "FAIL" : "optional"}\t${check.name}\t${check.detail}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
