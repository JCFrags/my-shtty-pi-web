import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const AGENT_BROWSER_IDENTITY = Object.freeze({
  protocolVersion: "2.0.0",
  pathId: "agent-browser/chrome",
  backendVersion: "0.33.1",
  backendExecutableSha256: "6e04d06605c4ca62da36e3263086e0f7ceae808b55508de2c3958d4b7fe430aa",
  engine: "chrome",
  coordinateSpace: "css_viewport_top_left",
  touch: false,
});

export class AgentBrowserRunner {
  constructor({
    binary = process.env.AGENT_BROWSER_BIN || "agent-browser",
    namespace = process.env.AGENT_BROWSER_NAMESPACE || `pi-web-test-${process.pid}`,
    session,
    engine = "chrome",
    profile,
    extensions = [],
    launchArgs = [],
    downloadPath,
    headed = false,
  }) {
    if (!session) throw new TypeError("agent-browser session is required");
    if (engine !== AGENT_BROWSER_IDENTITY.engine) {
      throw new TypeError(`unsupported agent-browser path: ${engine}; expected agent-browser/chrome`);
    }
    this.binary = binary;
    this.env = {
      ...process.env,
      AGENT_BROWSER_NAMESPACE: namespace,
      AGENT_BROWSER_SESSION: session,
      AGENT_BROWSER_ENGINE: engine,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    };
    if (profile) this.env.AGENT_BROWSER_PROFILE = resolve(profile);
    if (extensions.length) this.env.AGENT_BROWSER_EXTENSIONS = extensions.map((path) => resolve(path)).join(",");
    if (launchArgs.length) this.env.AGENT_BROWSER_ARGS = launchArgs.join(",");
    if (downloadPath) this.env.AGENT_BROWSER_DOWNLOAD_PATH = resolve(downloadPath);
    if (headed) this.env.AGENT_BROWSER_HEADED = "1";
  }

  run(args, { timeoutMs = 120_000, json = true, allowFailure = false } = {}) {
    const commandArgs = json ? [...args, "--json"] : args;
    const started = performance.now();
    const result = spawnSync(this.binary, commandArgs, {
      env: this.env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const elapsedMs = performance.now() - started;
    const parsed = parseJsonOutput(result.stdout) ?? parseJsonOutput(result.stderr);
    const record = {
      command: [this.binary, ...commandArgs],
      elapsedMs,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
      json: parsed,
      value: unwrap(parsed),
    };
    if ((result.error || result.status !== 0 || isExplicitFailure(parsed)) && !allowFailure) {
      const reason = result.error?.message || deepFind(parsed, (value, key) => key === "message" && typeof value === "string") || record.stderr || record.stdout || `exit ${result.status}`;
      const error = new Error(`agent-browser command failed: ${reason}`);
      error.record = record;
      throw error;
    }
    return record;
  }

  async runAsync(args, { timeoutMs = 120_000, json = true, allowFailure = false, signal } = {}) {
    const commandArgs = json ? [...args, "--json"] : args;
    const started = performance.now();
    const child = spawn(this.binary, commandArgs, {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) child.kill("SIGTERM");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    let timedOut = false;
    let cancelled = Boolean(signal?.aborted);
    let escalation;
    const terminate = () => {
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
    };
    const stop = () => { cancelled = true; terminate(); };
    signal?.addEventListener("abort", stop, { once: true });
    if (cancelled) terminate();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const settled = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (status, signalName) => resolvePromise({ status, signalName }));
    }).finally(() => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", stop);
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    const parsed = parseJsonOutput(stdoutText) ?? parseJsonOutput(stderrText);
    const record = {
      command: [this.binary, ...commandArgs],
      elapsedMs: performance.now() - started,
      status: settled.status,
      signal: settled.signalName,
      stdout: stdoutText,
      stderr: stderrText,
      json: parsed,
      value: unwrap(parsed),
      settlement: cancelled ? "cancelled" : timedOut ? "timed_out" : "completed",
    };
    if (cancelled) return record;
    if ((timedOut || settled.status !== 0 || isExplicitFailure(parsed)) && !allowFailure) {
      const reason = timedOut ? `timeout after ${timeoutMs}ms` : deepFind(parsed, (value, key) => key === "message" && typeof value === "string") || stderrText || stdoutText || `exit ${settled.status}`;
      const error = new Error(`agent-browser command failed: ${reason}`);
      error.record = record;
      throw error;
    }
    return record;
  }

  validateIdentity() {
    const executable = resolveExecutable(this.binary);
    const version = this.run(["--version"], { json: false, timeoutMs: 10_000 }).stdout;
    if (!new RegExp(`(?:^|\\s)${AGENT_BROWSER_IDENTITY.backendVersion.replaceAll(".", "\\.")}(?:$|\\s)`).test(version)) {
      throw new Error(`agent-browser version mismatch: ${version}`);
    }
    const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
    if (digest !== AGENT_BROWSER_IDENTITY.backendExecutableSha256) {
      throw new Error(`agent-browser executable digest mismatch: ${digest}`);
    }
    return { ...AGENT_BROWSER_IDENTITY, executable };
  }

  close() {
    return this.run(["close"], { allowFailure: true, timeoutMs: 30_000 });
  }
}

export function validateVisualBinding(supplied, current) {
  if (!supplied || !current) throw new Error("stale_visual_binding: missing binding");
  for (const key of ["pathId", "backendVersion", "backendExecutableSha256", "engine", "engineGeneration", "tabId", "sequence", "screenshotSha256", "capturedAt"]) {
    if (supplied[key] !== current[key]) throw new Error(`stale_visual_binding: ${key} changed`);
  }
  if (supplied.pathId !== AGENT_BROWSER_IDENTITY.pathId || supplied.engine !== AGENT_BROWSER_IDENTITY.engine) {
    throw new Error("stale_visual_binding: unsupported path identity");
  }
  if (JSON.stringify(supplied.geometry) !== JSON.stringify(current.geometry)) {
    throw new Error("stale_visual_binding: geometry changed");
  }
  return current;
}

export function validateCssPoint(x, y, geometry) {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= geometry.viewportWidth || y >= geometry.viewportHeight) {
    throw new RangeError(`coordinate_out_of_range: (${x},${y}) outside ${geometry.viewportWidth}x${geometry.viewportHeight} CSS viewport`);
  }
  return { x, y };
}

export function composeCuaCommands(action, geometry) {
  const move = (x, y) => {
    validateCssPoint(x, y, geometry);
    // agent-browser 0.33.1 accepts integer CSS pixels. Floor only after
    // range validation so a valid point cannot round past an edge.
    return ["mouse", "move", String(Math.floor(x)), String(Math.floor(y))];
  };
  const button = action.button || "left";
  if (!new Set(["left", "right", "middle"]).has(button)) throw new TypeError(`unsupported mouse button: ${button}`);
  switch (action.type) {
    case "mouse_move": return [move(action.x, action.y)];
    case "mouse_down": return [move(action.x, action.y), ["mouse", "down", button]];
    case "mouse_up": return [move(action.x, action.y), ["mouse", "up", button]];
    case "click": return [move(action.x, action.y), ["mouse", "down", button], ["mouse", "up", button]];
    case "double_click": return [move(action.x, action.y), ["mouse", "down", button], ["mouse", "up", button], ["mouse", "down", button], ["mouse", "up", button]];
    case "wheel": {
      if (![action.deltaX, action.deltaY].every(Number.isFinite)) throw new RangeError("wheel deltas must be finite");
      return [["mouse", "wheel", String(action.deltaY), String(action.deltaX)]];
    }
    case "drag": {
      const commands = [move(action.fromX, action.fromY), ["mouse", "down", button]];
      validateCssPoint(action.toX, action.toY, geometry);
      for (let step = 1; step <= 8; step += 1) {
        const fraction = step / 8;
        commands.push(move(action.fromX + (action.toX - action.fromX) * fraction, action.fromY + (action.toY - action.fromY) * fraction));
      }
      commands.push(["mouse", "up", button]);
      return commands;
    }
    case "key_press": return [["press", action.key]];
    case "text": return [["keyboard", "inserttext", action.text]];
    case "touch": throw new Error("unsupported: touch on agent-browser/chrome was not proved");
    default: throw new TypeError(`unsupported CUA action: ${action.type}`);
  }
}

export async function startFixtureServer(root, { host = "127.0.0.1", port } = {}) {
  const selectedPort = port || await freePort(host);
  const child = spawn(process.execPath, [join(root, "packages/test-fixtures/src/server.mjs")], {
    cwd: root,
    env: { ...process.env, PI_WEB_FIXTURE_HOST: host, PI_WEB_FIXTURE_PORT: String(selectedPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  const baseUrl = `http://${host}:${selectedPort}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`fixture server exited: ${logs.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return {
        child,
        baseUrl,
        async stop() {
          child.kill("SIGTERM");
          await Promise.race([
            new Promise((resolve) => child.once("exit", resolve)),
            sleep(2_000).then(() => child.kill("SIGKILL")),
          ]);
        },
      };
    } catch {}
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error(`fixture server did not become healthy: ${logs.join("")}`);
}

export async function cdpCall(webSocketUrl, method, params = {}, timeoutMs = 10_000) {
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP connection failed: ${webSocketUrl}`));
    };
    socket.onopen = () => socket.send(JSON.stringify({ id, method, params }));
    socket.onmessage = ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
      else resolvePromise(message.result);
    };
  });
}

export function parseJsonOutput(output = "") {
  const trimmed = String(output).trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

export function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if ("data" in current) { current = current.data; continue; }
    if ("result" in current) { current = current.result; continue; }
    break;
  }
  return current;
}

export function deepFind(value, predicate, key = "") {
  if (predicate(value, key)) return value;
  if (!value || typeof value !== "object") return undefined;
  for (const [childKey, child] of Object.entries(value)) {
    const found = deepFind(child, predicate, childKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findString(value, matcher) {
  return deepFind(value, (candidate) => typeof candidate === "string" && matcher(candidate));
}

export async function resetDirectory(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

function resolveExecutable(binary) {
  const candidates = isAbsolute(binary) || binary.includes("/")
    ? [resolve(binary)]
    : String(process.env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {}
  }
  throw new Error(`agent-browser executable not found: ${binary}`);
}

function isExplicitFailure(value) {
  return Boolean(value && typeof value === "object" && value.success === false);
}

async function freePort(host) {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
