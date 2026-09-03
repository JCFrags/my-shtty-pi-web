import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/main.js");
const OUTPUT_LIMIT = 256 * 1024;

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface CommandRequest {
  args: string[];
  context: ToolContext;
  stdin?: string;
  timeoutMs?: number;
}

export type CommandRunner = (request: CommandRequest) => Promise<unknown>;

function ownerEnvironment(context: ToolContext): NodeJS.ProcessEnv {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID ||
    !process.env.HERDR_TAB_ID || !process.env.HERDR_PANE_ID) {
    throw new Error("Browser tools require a Pi pane managed by Herdr.");
  }
  return {
    ...process.env,
    TERMINAL_BROWSER_OWNER_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    TERMINAL_BROWSER_OWNER_TAB_ID: process.env.HERDR_TAB_ID,
    TERMINAL_BROWSER_OWNER_PANE_ID: process.env.HERDR_PANE_ID,
    TERMINAL_BROWSER_OWNER_SESSION_ID: context.sessionId,
    TERMINAL_BROWSER_OWNER_PROJECT_DIR: context.cwd,
  };
}

export const defaultCommandRunner: CommandRunner = ({ args, context, stdin, timeoutMs = 30_000 }) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: context.cwd,
      env: ownerEnvironment(context),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (exceeded) return;
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > OUTPUT_LIMIT) {
        exceeded = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (context.signal?.aborted) return reject(new Error("Browser operation cancelled."));
      if (exceeded) return reject(new Error("Browser response exceeded its safe limit."));
      if (code !== 0) return reject(new Error(actionableError(stderr)));
      try {
        resolveResult(JSON.parse(stdout));
      } catch {
        reject(new Error("Browser returned an invalid response."));
      }
    });
    child.stdin.end(stdin);
  });

function actionableError(stderr: string): string {
  const message = stderr.replace(/^terminal-browser:\s*/u, "").trim();
  if (/agent control is human|agent control is paused|browser control is with the user/iu.test(message)) {
    return "Browser control is with the user. Wait until the user returns control, then call browser_control with status or resume.";
  }
  if (/stale control epoch|page changed|stale or unknown observation/iu.test(message)) {
    return "Browser state changed. Call browser_observe and retry the action.";
  }
  if (/no browser companion/iu.test(message)) return "No companion browser is open. Call browser_open first.";
  return message || "Browser operation failed.";
}

export interface BrowserStateCache {
  tabId: number;
  observationId: string;
  controlEpoch: number;
}

export type BrowserAction =
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; replace?: boolean }
  | { action: "press_key"; key: string }
  | { action: "scroll"; dy: number; dx?: number }
  | { action: "navigate"; url: string }
  | { action: "get_url" }
  | { action: "wait_for"; ref?: string; text?: string; condition?: "exists" | "visible" | "text"; timeoutMs?: number };

interface ControlStatus {
  state: "agent" | "human" | "paused";
  controlEpoch: number;
  reason: string | null;
  busy: boolean;
}

function boundedTabs(value: unknown) {
  const tabs = (value as { tabs?: unknown[] })?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.slice(0, 32).map((item) => {
    const tab = item as Record<string, unknown>;
    return {
      id: tab.id,
      url: typeof tab.url === "string" ? tab.url.slice(0, 8192) : "",
      title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
      active: tab.active === true,
    };
  });
}

export class PiBrowserClient {
  private observation: BrowserStateCache | null = null;

  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {}

  async open(context: ToolContext, options: { url?: string; newTab?: boolean; focus?: boolean }) {
    const args = ["companion", "open"];
    if (options.newTab) args.push("--new-tab");
    if (options.focus === false) args.push("--no-focus");
    if (options.url) args.push(options.url);
    const value = await this.runner({ args, context, timeoutMs: 30_000 }) as Record<string, unknown>;
    this.observation = null;
    return { action: value.action, tabs: boundedTabs(value) };
  }

  async tabs(context: ToolContext, request: { action: "list" | "activate" | "open" | "close"; tabId?: number; url?: string }) {
    const args = ["companion", "tabs", "--action", request.action];
    if (request.tabId !== undefined) args.push("--tab", String(request.tabId));
    if (request.url !== undefined) args.push("--url", request.url);
    const value = await this.runner({ args, context }) as Record<string, unknown>;
    if (request.action !== "list") this.observation = null;
    return { tabs: boundedTabs(value) };
  }

  async observe(context: ToolContext, options: { maxElements?: number; includeText?: boolean } = {}) {
    const args = ["agent", "observe", "--max-elements", String(options.maxElements ?? 120)];
    if (options.includeText === false) args.push("--no-text");
    const value = await this.runner({ args, context }) as Record<string, unknown>;
    const snapshot = value.snapshot as Record<string, unknown>;
    const elements = Array.isArray(snapshot?.elements) ? snapshot.elements.slice(0, options.maxElements ?? 120) : [];
    this.observation = {
      tabId: Number((snapshot as { tabId?: number }).tabId ?? (value as { tabId?: number }).tabId ?? 0),
      observationId: String(value.observationId),
      controlEpoch: Number(value.controlEpoch),
    };
    if (!this.observation.tabId) {
      const tabs = await this.tabs(context, { action: "list" });
      this.observation.tabId = Number(tabs.tabs.find((tab) => tab.active)?.id ?? 0);
    }
    return {
      url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 8192) : "",
      title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 512) : "",
      viewport: snapshot.viewport,
      elements,
      ...(typeof snapshot.text === "string" ? { text: snapshot.text.slice(0, 12_000) } : {}),
      truncated: typeof snapshot.text === "string" && snapshot.text.length > 12_000,
    };
  }

  private async status(context: ToolContext): Promise<ControlStatus> {
    return this.runner({ args: ["agent", "status"], context }) as Promise<ControlStatus>;
  }

  async control(context: ToolContext, action: "status" | "pause" | "resume") {
    const before = await this.status(context);
    if (action === "status") return before;
    if (action === "pause") {
      const result = await this.runner({
        args: ["agent", "pause", "--control-epoch", String(before.controlEpoch)], context,
      }) as ControlStatus;
      this.observation = null;
      return result;
    }
    const result = before.state === "agent" ? before : await this.runner({
      args: ["agent", "resume", "--control-epoch", String(before.controlEpoch)], context,
    }) as ControlStatus;
    const observation = await this.observe(context);
    return { ...result, observationReady: true, url: observation.url };
  }

  async act(context: ToolContext, request: BrowserAction) {
    const status = await this.status(context);
    if (status.state !== "agent") {
      throw new Error("Browser control is with the user. Wait for control to be returned, or call browser_control with resume when asked.");
    }
    const args = ["agent"];
    const needsObservation = request.action !== "navigate" && request.action !== "get_url";
    if (needsObservation) {
      if (!this.observation || this.observation.controlEpoch !== status.controlEpoch) {
        this.observation = null;
        throw new Error("Call browser_observe before this action so it uses the current page state.");
      }
    }
    if (request.action === "click") args.push("click", request.ref);
    if (request.action === "type") args.push("type", request.ref, "--stdin", ...(request.replace ? ["--replace"] : []));
    if (request.action === "press_key") args.push("press-key", request.key);
    if (request.action === "scroll") args.push("scroll", "--dy", String(request.dy), "--dx", String(request.dx ?? 0));
    if (request.action === "navigate") args.push("navigate", request.url);
    if (request.action === "get_url") args.push("get-url");
    if (request.action === "wait_for") {
      args.push("wait-for");
      if (request.ref) args.push("--ref", request.ref);
      if (request.text) args.push("--text", request.text);
      if (request.condition) args.push("--condition", request.condition);
      if (request.timeoutMs !== undefined) args.push("--timeout-ms", String(request.timeoutMs));
    }
    if (this.observation && needsObservation) {
      args.push("--observation", this.observation.observationId);
    }
    args.push("--control-epoch", String(status.controlEpoch));
    const value = await this.runner({
      args,
      context,
      ...(request.action === "type" ? { stdin: request.text } : {}),
      timeoutMs: request.action === "wait_for" ? (request.timeoutMs ?? 10_000) + 5_000 : 300_000,
    }) as Record<string, unknown>;
    if (request.action !== "get_url" && request.action !== "wait_for") this.observation = null;
    if (request.action === "get_url") return { url: typeof value.url === "string" ? value.url.slice(0, 8192) : "" };
    if (request.action === "wait_for") return { matched: value.matched === true, condition: value.condition };
    return { action: request.action, completed: true };
  }
}
