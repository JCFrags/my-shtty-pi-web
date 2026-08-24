import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export const PINCHTAB_PATH_ID = "pinchtab/chrome";
export const PINCHTAB_PROVIDER = "chrome";
export const PINCHTAB_VERSION = "0.15.1";

export function validatePinchTabProvider(provider) {
  if (provider !== PINCHTAB_PROVIDER) {
    throw new TypeError(`unsupported PinchTab provider ${JSON.stringify(provider)}; only "chrome" is allowed`);
  }
  return provider;
}

export function validatePinchTabRoute(value) {
  const route = deepFind(value, (candidate, key) => key === "route" && isObject(candidate));
  if (!route) throw new Error("PinchTab routed response omitted provider identity");
  if (route.requestedProvider !== PINCHTAB_PROVIDER || route.usedProvider !== PINCHTAB_PROVIDER || route.escalated !== false) {
    throw new Error(`PinchTab provider mismatch: requested=${JSON.stringify(route.requestedProvider)}, used=${JSON.stringify(route.usedProvider)}, escalated=${JSON.stringify(route.escalated)}`);
  }
  return value;
}

export class PinchTabRunner {
  constructor({
    binary = process.env.PINCHTAB_BIN || "pinchtab",
    chromiumBinary = process.env.PINCHTAB_CHROMIUM_BIN || "/usr/bin/chromium-browser",
    agentId = `pi-web-test-${process.pid}`,
  } = {}) {
    this.binary = binary;
    this.chromiumBinary = chromiumBinary;
    this.agentId = agentId;
    this.home = undefined;
    this.serverUrl = undefined;
    this.server = undefined;
    this.instanceId = undefined;
    this.sessionId = undefined;
    this.tabs = new Set();
  }

  validateInstallation() {
    const result = spawnSync(this.binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const text = `${result.stdout || ""} ${result.stderr || ""}`;
    const actual = text.match(/\d+\.\d+\.\d+/)?.[0];
    if (result.status !== 0 || actual !== PINCHTAB_VERSION) {
      throw new Error(`PinchTab ${PINCHTAB_VERSION} is required; observed ${actual || "unavailable"}`);
    }
    return actual;
  }

  async start() {
    if (this.server) throw new Error("PinchTabRunner is already started; explicit close is required");
    this.validateInstallation();
    validatePinchTabProvider(PINCHTAB_PROVIDER);
    this.home = await mkdtemp(join(tmpdir(), "pi-web-pinchtab-test-"));
    const port = await freePort();
    this.serverUrl = `http://127.0.0.1:${port}`;
    const configDir = join(this.home, ".pinchtab");
    const stateDir = join(this.home, "state");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    const config = {
      configVersion: "0.8.0",
      server: {
        port: String(port), bind: "127.0.0.1", token: randomBytes(32).toString("hex"), stateDir,
      },
      browser: { binary: this.chromiumBinary, extraFlags: "--disable-gpu" },
      browsers: { default: PINCHTAB_PROVIDER, available: [PINCHTAB_PROVIDER] },
      instanceDefaults: { mode: "headless", noRestore: true, maxTabs: 8 },
      security: {
        allowedDomains: ["127.0.0.1", "localhost"],
        allowEvaluate: false,
        allowMacro: false,
        allowScreencast: false,
        allowDownload: false,
        allowCookies: false,
        allowUpload: false,
        allowClipboard: false,
        allowStateExport: false,
        enableActionGuards: true,
        idpi: {
          enabled: true, strictMode: true, scanContent: true, wrapContent: true,
          customPatterns: [], scanTimeoutSec: 5, shieldThreshold: 0,
        },
      },
      profiles: { baseDir: join(this.home, "profiles") },
      multiInstance: { strategy: "explicit" },
      observability: { activity: { enabled: true } },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    this.server = spawn(this.binary, ["server", "--bind", "127.0.0.1", "--port", String(port), "--log-level", "warn"], {
      env: { ...process.env, HOME: this.home },
      stdio: ["ignore", "ignore", "ignore"],
    });

    try {
      let health;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          health = await this.run(["health", "--json"], { timeoutMs: 5_000 });
          break;
        } catch {
          if (this.server.exitCode !== null) throw new Error("PinchTab server exited during startup");
          await sleep(50);
        }
      }
      if (!health) throw new Error("secured PinchTab loopback server did not become healthy");
      if (health.version !== PINCHTAB_VERSION || health.authRequired !== true) {
        throw new Error("PinchTab health identity or authentication posture mismatch");
      }
      const instance = await this.run(["instance", "start", "--browser", PINCHTAB_PROVIDER, "--mode", "headless"]);
      if (instance.browser !== PINCHTAB_PROVIDER) {
        throw new Error(`PinchTab substituted provider ${JSON.stringify(instance.browser)}`);
      }
      this.instanceId = requiredString(instance, "id", "instance");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const instances = await this.run(["instances", "--json"]);
        const current = instances.find((item) => item.id === this.instanceId);
        if (current?.browser && current.browser !== PINCHTAB_PROVIDER) throw new Error("PinchTab running provider mismatch");
        if (current?.status === "running") break;
        if (attempt === 199) throw new Error("PinchTab instance did not become ready");
        await sleep(50);
      }
      const session = await this.run(["session", "create", "--agent-id", this.agentId, "--label", "pi-web conformance", "--json"], { redactResult: false });
      if (session.agentId !== this.agentId) throw new Error("PinchTab session owner mismatch");
      this.sessionId = requiredString(session, "id", "session");
      return { pathId: PINCHTAB_PATH_ID, provider: PINCHTAB_PROVIDER, version: PINCHTAB_VERSION, instanceId: this.instanceId, sessionId: this.sessionId };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async run(args, { timeoutMs = 120_000, signal, routed = false, redactResult = true } = {}) {
    if (!this.home || !this.serverUrl) throw new Error("PinchTabRunner is not started");
    const commandArgs = ["--server", this.serverUrl, "--agent-id", this.agentId, ...args];
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary, commandArgs, {
        env: { ...process.env, HOME: this.home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      const cancel = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", cancel, { once: true });
      child.once("error", reject);
      child.once("close", (status, childSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        const out = Buffer.concat(stdout).toString("utf8").trim();
        const err = Buffer.concat(stderr).toString("utf8").trim();
        const value = parseJsonOutput(out) ?? parseJsonOutput(err);
        if (signal?.aborted) return reject(new Error("PinchTab operation cancelled"));
        if (status !== 0) return reject(new Error(`PinchTab command failed (${status ?? childSignal}): ${sanitizeFailure(err || out)}`));
        resolvePromise(value ?? out);
      });
    });
    if (routed) validatePinchTabRoute(result);
    return redactResult ? redactSecrets(result) : result;
  }

  async navigate(url) {
    const value = await this.run(["nav", url, "--new-tab", "--json"], { routed: true });
    const tabId = deepFind(value, (candidate, key) => key === "tabId" && typeof candidate === "string");
    if (!tabId) throw new Error("PinchTab navigation omitted tabId");
    this.tabs.add(tabId);
    return tabId;
  }

  async closeTab(tabId) {
    if (!this.tabs.has(tabId)) return { closed: true, settled: true };
    const result = await this.run(["close", tabId, "--json"]);
    this.tabs.delete(tabId);
    return result;
  }

  async close() {
    if (this.home && this.serverUrl) {
      if (this.sessionId) await this.run(["session", "revoke", this.sessionId], { timeoutMs: 10_000 }).catch(() => {});
      if (this.instanceId) await this.run(["instance", "stop", this.instanceId], { timeoutMs: 20_000 }).catch(() => {});
    }
    if (this.server && this.server.exitCode === null) {
      this.server.kill("SIGTERM");
      await Promise.race([new Promise((resolvePromise) => this.server.once("exit", resolvePromise)), sleep(2_000).then(() => this.server.kill("SIGKILL"))]);
    }
    if (this.home) await rm(this.home, { recursive: true, force: true });
    this.server = undefined;
    this.serverUrl = undefined;
    this.instanceId = undefined;
    this.sessionId = undefined;
    this.tabs.clear();
  }
}

export function parseJsonOutput(text = "") {
  const trimmed = String(text).trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch {}
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line.trim()); } catch {}
  }
  return undefined;
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /token|secret|cookie/i.test(key) ? "<redacted>" : redactSecrets(child),
  ]));
}

function requiredString(value, key, context) {
  const found = deepFind(value, (candidate, candidateKey) => candidateKey === key && typeof candidate === "string");
  if (!found) throw new Error(`PinchTab ${context} response omitted ${key}`);
  return found;
}

function sanitizeFailure(value) {
  return String(value).slice(0, 2_000).replace(/(token|secret|cookie)(["'=:\s]+)[^\s,}"]+/gi, "$1$2<redacted>");
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFind(value, predicate, key = "") {
  if (predicate(value, key)) return value;
  if (!value || typeof value !== "object") return undefined;
  for (const [childKey, child] of Object.entries(value)) {
    const found = deepFind(child, predicate, childKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
