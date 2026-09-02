import { resolve, sep } from "node:path";
import type { BrowserdServerOptions } from "./server.js";

const MIB = 1024 * 1024;
const RESOURCE_VARIABLES = new Set([
  "PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB", "PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB",
  "PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB", "PI_WEB_RESOURCE_PROFILE_SOFT_MIB",
  "PI_WEB_RESOURCE_PROFILE_HARD_MIB", "PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS",
  "PI_WEB_RESOURCE_DRAIN_TIMEOUT_MS", "PI_WEB_RESOURCE_EMERGENCY_TIMEOUT_MS",
]);

/** Parse only fixed, bounded installed-service environment variables. */
export function installedBrowserdOptions(environment: NodeJS.ProcessEnv): BrowserdServerOptions {
  for (const name of Object.keys(environment)) if (name.startsWith("PI_WEB_RESOURCE_") && !RESOURCE_VARIABLES.has(name)) throw new Error("Unknown browser resource configuration variable");
  const xdgRuntimeDirectory = environment.XDG_RUNTIME_DIR;
  if (xdgRuntimeDirectory === undefined || resolve(xdgRuntimeDirectory) !== xdgRuntimeDirectory) throw new Error("XDG_RUNTIME_DIR must be an absolute normalized path for browserd");

  const egressProxy = parseEgressProxy(environment.BROWSERD_EGRESS_PROXY);
  const runtimeDirectory = parseRuntimePath(environment.BROWSERD_RUNTIME_DIR ?? `${xdgRuntimeDirectory}/pi-browserd`, "BROWSERD_RUNTIME_DIR", xdgRuntimeDirectory);
  const profileRoot = parseRuntimePath(environment.BROWSERD_PROFILE_ROOT ?? `${xdgRuntimeDirectory}/pi-web-agentcursor/profiles`, "BROWSERD_PROFILE_ROOT", xdgRuntimeDirectory);
  const qualificationDiagnostics = runtimeDirectory === `${xdgRuntimeDirectory}/pi-web/qualification/browserd`
    && profileRoot === `${xdgRuntimeDirectory}/pi-web/qualification/profiles`;
  const screenshotObservationTtlMs = parseInteger(environment.BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS, "BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS", 60_000, 10_000, 120_000);
  const domObservationTtlMs = parseInteger(environment.BROWSERD_DOM_OBSERVATION_TTL_MS, "BROWSERD_DOM_OBSERVATION_TTL_MS", 60_000, 10_000, 120_000);
  const idleIntervalMs = parseInteger(environment.BROWSERD_FRAME_IDLE_INTERVAL_MS, "BROWSERD_FRAME_IDLE_INTERVAL_MS", 2_000, 500, 10_000);
  const selectedIntervalMs = parseInteger(environment.BROWSERD_FRAME_SELECTED_INTERVAL_MS, "BROWSERD_FRAME_SELECTED_INTERVAL_MS", 500, 100, 2_000);
  const burstIntervalMs = parseInteger(environment.BROWSERD_FRAME_BURST_INTERVAL_MS, "BROWSERD_FRAME_BURST_INTERVAL_MS", 100, 50, 1_000);
  if (!(idleIntervalMs >= selectedIntervalMs && selectedIntervalMs >= burstIntervalMs)) throw new Error("browserd frame intervals must satisfy idle >= selected >= burst");
  const maxSessionsGlobal = parseInteger(environment.BROWSERD_MAX_SESSIONS_GLOBAL, "BROWSERD_MAX_SESSIONS_GLOBAL", 16, 1, 16);
  const executable = parseBrowserExecutable(environment.BROWSERD_CHROME_BIN);
  const perSessionSoftPssMiB = parseInteger(environment.PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB, "PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB", 1024, 128, 8192);
  const perSessionHardPssMiB = parseInteger(environment.PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB, "PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB", 1280, 256, 16_384);
  const globalChromePssMiB = parseInteger(environment.PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB, "PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB", 4096, 512, 32_768);
  const profileSoftMiB = parseInteger(environment.PI_WEB_RESOURCE_PROFILE_SOFT_MIB, "PI_WEB_RESOURCE_PROFILE_SOFT_MIB", 512, 64, 4096);
  const profileHardMiB = parseInteger(environment.PI_WEB_RESOURCE_PROFILE_HARD_MIB, "PI_WEB_RESOURCE_PROFILE_HARD_MIB", 1024, 128, 8192);
  const samplingIntervalMs = parseInteger(environment.PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS, "PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS", 5000, 1000, 60_000);
  const drainTimeoutMs = parseInteger(environment.PI_WEB_RESOURCE_DRAIN_TIMEOUT_MS, "PI_WEB_RESOURCE_DRAIN_TIMEOUT_MS", 30_000, 1000, 120_000);
  const emergencyTimeoutMs = parseInteger(environment.PI_WEB_RESOURCE_EMERGENCY_TIMEOUT_MS, "PI_WEB_RESOURCE_EMERGENCY_TIMEOUT_MS", 15_000, 1000, 60_000);
  if (perSessionSoftPssMiB >= perSessionHardPssMiB) throw new Error("browserd per-session PSS limits must satisfy soft < hard");
  if (profileSoftMiB >= profileHardMiB) throw new Error("browserd profile limits must satisfy soft < hard");
  if (globalChromePssMiB < perSessionHardPssMiB) throw new Error("browserd global Chrome PSS limit must not be below the per-session hard limit");
  if (emergencyTimeoutMs > drainTimeoutMs) throw new Error("browserd emergency timeout must not exceed the drain timeout");

  return {
    runtimeDirectory,
    screenshotObservationTtlMs,
    domObservationTtlMs,
    maxSessionsGlobal,
    qualificationDiagnostics,
    resourceLimits: {
      perSessionSoftPssBytes: perSessionSoftPssMiB * MIB,
      perSessionHardPssBytes: perSessionHardPssMiB * MIB,
      globalChromePssBytes: globalChromePssMiB * MIB,
      profileSoftBytes: profileSoftMiB * MIB,
      profileHardBytes: profileHardMiB * MIB,
      samplingIntervalMs,
      drainTimeoutMs,
      emergencyTimeoutMs,
    },
    frameScheduler: { idleIntervalMs, selectedIntervalMs, burstIntervalMs },
    chrome: {
      profileRoot,
      ...(executable === undefined ? {} : { executable }),
      ...(egressProxy === undefined ? {} : { egressProxy }),
    },
  };
}

function parseInteger(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function parseRuntimePath(value: string, name: string, xdgRuntimeDirectory: string): string {
  const normalized = resolve(value);
  if (normalized !== value || (normalized !== xdgRuntimeDirectory && !normalized.startsWith(`${xdgRuntimeDirectory}${sep}`))) throw new Error(`${name} must be an absolute normalized path inside XDG_RUNTIME_DIR`);
  return normalized;
}

function parseBrowserExecutable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value !== "/usr/bin/google-chrome-stable" && value !== "/usr/bin/google-chrome" && value !== "/usr/bin/chromium-browser" && value !== "/usr/bin/chromium") throw new Error("BROWSERD_CHROME_BIN must be a reviewed Chrome or Chromium executable");
  return value;
}

function parseEgressProxy(value: string | undefined): { host: "127.0.0.1" | "::1"; port: number } | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("BROWSERD_EGRESS_PROXY must be a plain loopback HTTP proxy URL"); }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error("BROWSERD_EGRESS_PROXY must be a plain loopback HTTP proxy URL");
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("BROWSERD_EGRESS_PROXY port is invalid");
  return { host: parsed.hostname === "[::1]" ? "::1" : "127.0.0.1", port };
}
