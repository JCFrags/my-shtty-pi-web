import { resolve, sep } from "node:path";
import type { BrowserdServerOptions } from "./server.js";

/** Parse only fixed, bounded installed-service environment variables. */
export function installedBrowserdOptions(environment: NodeJS.ProcessEnv): BrowserdServerOptions {
  const xdgRuntimeDirectory = environment.XDG_RUNTIME_DIR;
  if (xdgRuntimeDirectory === undefined || resolve(xdgRuntimeDirectory) !== xdgRuntimeDirectory) throw new Error("XDG_RUNTIME_DIR must be an absolute normalized path for browserd");

  const egressProxy = parseEgressProxy(environment.BROWSERD_EGRESS_PROXY);
  const runtimeDirectory = parseRuntimePath(environment.BROWSERD_RUNTIME_DIR ?? `${xdgRuntimeDirectory}/pi-browserd`, "BROWSERD_RUNTIME_DIR", xdgRuntimeDirectory);
  const profileRoot = parseRuntimePath(environment.BROWSERD_PROFILE_ROOT ?? `${xdgRuntimeDirectory}/pi-web-agentcursor/profiles`, "BROWSERD_PROFILE_ROOT", xdgRuntimeDirectory);
  const screenshotObservationTtlMs = parseInteger(environment.BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS, "BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS", 60_000, 10_000, 120_000);
  const domObservationTtlMs = parseInteger(environment.BROWSERD_DOM_OBSERVATION_TTL_MS, "BROWSERD_DOM_OBSERVATION_TTL_MS", 60_000, 10_000, 120_000);
  const idleIntervalMs = parseInteger(environment.BROWSERD_FRAME_IDLE_INTERVAL_MS, "BROWSERD_FRAME_IDLE_INTERVAL_MS", 2_000, 500, 10_000);
  const selectedIntervalMs = parseInteger(environment.BROWSERD_FRAME_SELECTED_INTERVAL_MS, "BROWSERD_FRAME_SELECTED_INTERVAL_MS", 500, 100, 2_000);
  const burstIntervalMs = parseInteger(environment.BROWSERD_FRAME_BURST_INTERVAL_MS, "BROWSERD_FRAME_BURST_INTERVAL_MS", 100, 50, 1_000);
  if (!(idleIntervalMs >= selectedIntervalMs && selectedIntervalMs >= burstIntervalMs)) throw new Error("browserd frame intervals must satisfy idle >= selected >= burst");
  const maxSessionsGlobal = parseInteger(environment.BROWSERD_MAX_SESSIONS_GLOBAL, "BROWSERD_MAX_SESSIONS_GLOBAL", 16, 1, 16);
  const executable = parseBrowserExecutable(environment.BROWSERD_CHROME_BIN);

  return {
    runtimeDirectory,
    screenshotObservationTtlMs,
    domObservationTtlMs,
    maxSessionsGlobal,
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
