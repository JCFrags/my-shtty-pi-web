// @ts-check
import { isAbsolute } from "node:path";

const PRODUCT_EXECUTABLES = Object.freeze({
  "google-chrome-stable": "/usr/bin/google-chrome-stable",
  chromium: "/usr/bin/chromium-browser",
});

export const DEFAULT_INSTALLED_CONFIG = deepFreeze({
  schemaVersion: 1,
  backend: "legacy",
  release: { pointer: "current" },
  browser: {
    product: "auto",
    screenshotObservationTtlMs: 60_000,
    domObservationTtlMs: 60_000,
    frames: { idleIntervalMs: 2_000, selectedIntervalMs: 500, burstIntervalMs: 100 },
  },
  proxy: { host: "127.0.0.1", port: 8_877 },
  resources: {
    maxBrowserSessions: 2,
    perSessionSoftPssMiB: 1_024,
    perSessionHardPssMiB: 1_280,
    globalChromePssMiB: 4_096,
    profileSoftMiB: 512,
    profileHardMiB: 1_024,
    samplingIntervalMs: 5_000,
    drainTimeoutMs: 30_000,
    emergencyTimeoutMs: 15_000,
  },
  workspace: { executable: "release", diagnosticMode: false },
  logLevel: "info",
  services: { startTimeoutSec: 30, stopTimeoutSec: 30 },
});

/**
 * Parse the complete installed configuration. Every object is closed: an
 * unknown field is an error rather than an ignored future command channel.
 * @param {unknown} input
 */
export function parseInstalledConfig(input) {
  const root = object(input, "configuration", ["schemaVersion", "backend", "release", "browser", "proxy", "resources", "workspace", "logLevel", "services"]);
  exactInteger(root.schemaVersion, "schemaVersion", 1, 1);
  const backend = enumeration(root.backend, "backend", ["legacy", "agentcursor"]);

  const release = object(root.release, "release", ["pointer"]);
  const pointer = enumeration(release.pointer, "release.pointer", ["current"]);

  const browser = object(root.browser, "browser", ["product", "screenshotObservationTtlMs", "domObservationTtlMs", "frames"]);
  const product = enumeration(browser.product, "browser.product", ["auto", "google-chrome-stable", "chromium"]);
  const screenshotObservationTtlMs = exactInteger(browser.screenshotObservationTtlMs, "browser.screenshotObservationTtlMs", 10_000, 120_000);
  const domObservationTtlMs = exactInteger(browser.domObservationTtlMs, "browser.domObservationTtlMs", 10_000, 120_000);
  const frames = object(browser.frames, "browser.frames", ["idleIntervalMs", "selectedIntervalMs", "burstIntervalMs"]);
  const idleIntervalMs = exactInteger(frames.idleIntervalMs, "browser.frames.idleIntervalMs", 500, 10_000);
  const selectedIntervalMs = exactInteger(frames.selectedIntervalMs, "browser.frames.selectedIntervalMs", 100, 2_000);
  const burstIntervalMs = exactInteger(frames.burstIntervalMs, "browser.frames.burstIntervalMs", 50, 1_000);
  if (!(idleIntervalMs >= selectedIntervalMs && selectedIntervalMs >= burstIntervalMs)) throw new Error("browser frame intervals must satisfy idle >= selected >= burst");

  const proxy = object(root.proxy, "proxy", ["host", "port"]);
  if (proxy.host !== "127.0.0.1") throw new Error("proxy.host must be the reviewed 127.0.0.1 loopback listener");
  const proxyPort = exactInteger(proxy.port, "proxy.port", 1_024, 65_535);

  const resources = object(root.resources, "resources", ["maxBrowserSessions", "perSessionSoftPssMiB", "perSessionHardPssMiB", "globalChromePssMiB", "profileSoftMiB", "profileHardMiB", "samplingIntervalMs", "drainTimeoutMs", "emergencyTimeoutMs"]);
  const maxBrowserSessions = exactInteger(resources.maxBrowserSessions, "resources.maxBrowserSessions", 1, 16);
  const perSessionSoftPssMiB = exactInteger(resources.perSessionSoftPssMiB, "resources.perSessionSoftPssMiB", 512, 8_192);
  const perSessionHardPssMiB = exactInteger(resources.perSessionHardPssMiB, "resources.perSessionHardPssMiB", 768, 12_288);
  if (perSessionSoftPssMiB >= perSessionHardPssMiB) throw new Error("per-session soft PSS must be lower than hard PSS");
  const globalChromePssMiB = exactInteger(resources.globalChromePssMiB, "resources.globalChromePssMiB", perSessionHardPssMiB, 32_768);
  if (globalChromePssMiB < perSessionHardPssMiB * 2) throw new Error("global Chrome PSS must allow at least two hard-bound sessions");
  const profileSoftMiB = exactInteger(resources.profileSoftMiB, "resources.profileSoftMiB", 128, 8_192);
  const profileHardMiB = exactInteger(resources.profileHardMiB, "resources.profileHardMiB", 256, 16_384);
  if (profileSoftMiB >= profileHardMiB) throw new Error("profile soft bytes must be lower than hard bytes");
  const samplingIntervalMs = exactInteger(resources.samplingIntervalMs, "resources.samplingIntervalMs", 1_000, 60_000);
  const drainTimeoutMs = exactInteger(resources.drainTimeoutMs, "resources.drainTimeoutMs", 5_000, 120_000);
  const emergencyTimeoutMs = exactInteger(resources.emergencyTimeoutMs, "resources.emergencyTimeoutMs", 5_000, 120_000);

  const workspace = object(root.workspace, "workspace", ["executable", "diagnosticMode"]);
  const workspaceExecutable = enumeration(workspace.executable, "workspace.executable", ["release"]);
  if (typeof workspace.diagnosticMode !== "boolean") throw new Error("workspace.diagnosticMode must be boolean");

  const logLevel = enumeration(root.logLevel, "logLevel", ["error", "warn", "info", "debug"]);
  const services = object(root.services, "services", ["startTimeoutSec", "stopTimeoutSec"]);
  const startTimeoutSec = exactInteger(services.startTimeoutSec, "services.startTimeoutSec", 5, 120);
  const stopTimeoutSec = exactInteger(services.stopTimeoutSec, "services.stopTimeoutSec", 5, 120);

  return deepFreeze({
    schemaVersion: 1,
    backend,
    release: { pointer },
    browser: { product, screenshotObservationTtlMs, domObservationTtlMs, frames: { idleIntervalMs, selectedIntervalMs, burstIntervalMs } },
    proxy: { host: "127.0.0.1", port: proxyPort },
    resources: { maxBrowserSessions, perSessionSoftPssMiB, perSessionHardPssMiB, globalChromePssMiB, profileSoftMiB, profileHardMiB, samplingIntervalMs, drainTimeoutMs, emergencyTimeoutMs },
    workspace: { executable: workspaceExecutable, diagnosticMode: workspace.diagnosticMode },
    logLevel,
    services: { startTimeoutSec, stopTimeoutSec },
  });
}

/**
 * Return only fixed reviewed service variables. No descriptor secret or human
 * input can enter this static environment file.
 * @param {ReturnType<typeof parseInstalledConfig>} config
 * @param {{ releaseRoot: string, runtimeRoot: string }} paths
 */
export function serviceEnvironment(config, paths) {
  absolutePath(paths.releaseRoot, "releaseRoot");
  absolutePath(paths.runtimeRoot, "runtimeRoot");
  const proxy = `http://${config.proxy.host}:${config.proxy.port}/`;
  return Object.freeze({
    WEBX_BROWSER_BACKEND: config.backend,
    WEBX_EGRESS_PROXY: proxy,
    BROWSERD_EGRESS_PROXY: proxy,
    PI_WEB_EGRESS_HOST: config.proxy.host,
    PI_WEB_EGRESS_PORT: String(config.proxy.port),
    PYTHONDONTWRITEBYTECODE: "1",
    BROWSERD_RUNTIME_DIR: `${paths.runtimeRoot}/pi-browserd`,
    BROWSERD_PROFILE_ROOT: `${paths.runtimeRoot}/pi-web-agentcursor/profiles`,
    BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS: String(config.browser.screenshotObservationTtlMs),
    BROWSERD_DOM_OBSERVATION_TTL_MS: String(config.browser.domObservationTtlMs),
    BROWSERD_FRAME_IDLE_INTERVAL_MS: String(config.browser.frames.idleIntervalMs),
    BROWSERD_FRAME_SELECTED_INTERVAL_MS: String(config.browser.frames.selectedIntervalMs),
    BROWSERD_FRAME_BURST_INTERVAL_MS: String(config.browser.frames.burstIntervalMs),
    BROWSERD_MAX_SESSIONS_GLOBAL: String(config.resources.maxBrowserSessions),
    PI_WEB_WORKSPACE_BIN: `${paths.releaseRoot}/bin/pi-browser-workspace`,
    PI_WEB_LOG_LEVEL: config.logLevel,
    PI_WEB_DIAGNOSTIC_MODE: config.workspace.diagnosticMode ? "1" : "0",
    PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB: String(config.resources.perSessionSoftPssMiB),
    PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB: String(config.resources.perSessionHardPssMiB),
    PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB: String(config.resources.globalChromePssMiB),
    PI_WEB_RESOURCE_PROFILE_SOFT_MIB: String(config.resources.profileSoftMiB),
    PI_WEB_RESOURCE_PROFILE_HARD_MIB: String(config.resources.profileHardMiB),
    PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS: String(config.resources.samplingIntervalMs),
    PI_WEB_RESOURCE_DRAIN_TIMEOUT_MS: String(config.resources.drainTimeoutMs),
    PI_WEB_RESOURCE_EMERGENCY_TIMEOUT_MS: String(config.resources.emergencyTimeoutMs),
    ...(config.browser.product === "auto" ? {} : { BROWSERD_CHROME_BIN: PRODUCT_EXECUTABLES[/** @type {keyof typeof PRODUCT_EXECUTABLES} */ (config.browser.product)] }),
  });
}

/** @param {Record<string, string>} values */
export function serializeEnvironmentFile(values) {
  return `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || /[\0\r\n]/u.test(value)) throw new Error("service environment contains an unsafe name or value");
    return `${name}=${JSON.stringify(value)}`;
  }).join("\n")}\n`;
}

/**
 * Render one immutable unit template. Path bytes use systemd-safe escapes;
 * timeout values remain decimal.
 * @param {string} template
 * @param {{ currentRelease: string, configHome: string, cacheHome: string, stateHome: string, browserdUnit: "pi-browserd.service" | "pi-web-agentcursor-browserd.service", startTimeoutSec: number, stopTimeoutSec: number }} values
 */
export function renderUnitTemplate(template, values) {
  for (const [name, path] of Object.entries({ currentRelease: values.currentRelease, configHome: values.configHome, cacheHome: values.cacheHome, stateHome: values.stateHome })) absolutePath(path, name);
  const replacements = {
    CURRENT_RELEASE: systemdPathFragment(values.currentRelease),
    CONFIG_HOME: systemdPathFragment(values.configHome),
    CACHE_HOME: systemdPathFragment(values.cacheHome),
    STATE_HOME: systemdPathFragment(values.stateHome),
    BROWSERD_UNIT: enumeration(values.browserdUnit, "browserdUnit", ["pi-browserd.service", "pi-web-agentcursor-browserd.service"]),
    START_TIMEOUT_SEC: String(exactInteger(values.startTimeoutSec, "startTimeoutSec", 5, 120)),
    STOP_TIMEOUT_SEC: String(exactInteger(values.stopTimeoutSec, "stopTimeoutSec", 5, 120)),
  };
  let rendered = template;
  for (const [name, value] of Object.entries(replacements)) rendered = rendered.replaceAll(`@${name}@`, value);
  if (/@[A-Z][A-Z0-9_]*@/u.test(rendered)) throw new Error("unit template contains an unknown placeholder");
  return rendered;
}

/** @param {ReturnType<typeof parseInstalledConfig>} config */
export function redactedEffectiveConfig(config) {
  return { ...structuredClone(config), effectiveEgressBindingId: `forward-proxy://${config.proxy.host}:${config.proxy.port}`, retainedSecrets: false };
}

/** @param {unknown} value @param {string} name @param {readonly string[]} keys */
function object(value, name, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  if (unknown.length > 0) throw new Error(`${name} has unknown field: ${unknown.sort().join(", ")}`);
  if (missing.length > 0) throw new Error(`${name} is missing field: ${missing.join(", ")}`);
  return record;
}

/** @param {unknown} value @param {string} name @param {number} minimum @param {number} maximum */
function exactInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return Number(value);
}

/** @param {unknown} value @param {string} name @param {readonly string[]} values */
function enumeration(value, name, values) {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

/** @param {string} value */
function systemdPathFragment(value) {
  if (/[\0\r\n]/u.test(value)) throw new Error("systemd unit value contains a control character");
  let escaped = "";
  for (const byte of Buffer.from(value)) {
    const character = String.fromCharCode(byte);
    escaped += /[A-Za-z0-9/_.:-]/u.test(character) ? character : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return escaped;
}

/** @param {string} value @param {string} name */
function absolutePath(value, name) {
  if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error(`${name} must be a safe absolute path`);
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
