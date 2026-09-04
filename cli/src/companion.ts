import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  AGENT_SOCKETS_DIR,
  BROWSER_OWNER_ENV,
  browserOwnerEnvironment,
  removeInstance,
  requireHerdrBrowserOwner,
  withdrawInstance,
} from "pixel-store";
import type { BrowserOwner, InstanceRow } from "pixel-store";

import { control } from "./control";
import { ownerMatches, recordKey } from "./instances";
import { instances } from "./registry";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "zenbu-labs.terminal-browser";
const ENTRYPOINT_ID = "companion";
const READY_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 25_000;
const OUTPUT_LIMIT = 128 * 1024;

interface BrowserWhere {
  pane: string | null;
  tab: string | null;
}

interface BrowserTargets {
  tabs?: Array<{
    id: number;
    url: string;
    title: string;
    active: boolean;
    targetId: string | null;
  }>;
}

export interface CompanionOpenOptions {
  url?: string;
  newTab?: boolean;
  focus?: boolean;
}

export interface CompanionOpenResult {
  action: "opened" | "reused";
  key: string;
  pane: string;
  tabs: NonNullable<BrowserTargets["tabs"]>;
}

export interface CompanionTabsRequest {
  action: "list" | "activate" | "open" | "close";
  tab?: number;
  url?: string;
  cwd?: string;
}

export function currentBrowserOwner(environment: NodeJS.ProcessEnv, projectDir: string): BrowserOwner {
  const explicit = environment[BROWSER_OWNER_ENV.paneId];
  if (explicit) {
    const parsed = requireHerdrBrowserOwner({
      ...environment,
      HERDR_WORKSPACE_ID: environment[BROWSER_OWNER_ENV.workspaceId],
      HERDR_TAB_ID: environment[BROWSER_OWNER_ENV.tabId],
      HERDR_PANE_ID: explicit,
    }, environment[BROWSER_OWNER_ENV.projectDir] ?? projectDir, environment[BROWSER_OWNER_ENV.sessionId]);
    return parsed;
  }
  if (environment.HERDR_ENV !== "1") throw new Error("browser companion requires a Herdr Pi pane");
  return requireHerdrBrowserOwner(environment, projectDir, environment.PI_SESSION_ID);
}

function ownerLockPath(owner: BrowserOwner): string {
  const identity = `${owner.workspaceId}\0${owner.tabId}\0${owner.paneId}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(AGENT_SOCKETS_DIR, `companion-${digest}.lock`);
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withOwnerLock<T>(owner: BrowserOwner, operation: () => Promise<T>): Promise<T> {
  const lock = ownerLockPath(owner);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("browser companion launch is already in progress");
      try {
        const age = Date.now() - (await fs.stat(lock)).mtimeMs;
        if (age > LOCK_TIMEOUT_MS) await fs.rm(lock, { recursive: true, force: true });
      } catch {}
      await sleep(100);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function runHerdr(args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync(environment.HERDR_BIN_PATH || "herdr", args, {
      env: { ...environment, HERDR_ENV: "1" },
      encoding: "utf8",
      maxBuffer: OUTPUT_LIMIT,
    });
    return typeof stdout === "string" ? stdout : "";
  } catch {
    throw new Error("Herdr could not open or focus the browser companion");
  }
}

export function parseOpenedPane(output: string): string {
  if (Buffer.byteLength(output, "utf8") > OUTPUT_LIMIT) throw new Error("invalid Herdr browser pane response");
  try {
    const value = JSON.parse(output) as {
      result?: { plugin_pane?: { plugin_id?: string; entrypoint?: string; pane?: { pane_id?: string } } };
    };
    const pluginPane = value.result?.plugin_pane;
    const pane = pluginPane?.pane?.pane_id;
    if (pluginPane?.plugin_id !== PLUGIN_ID || pluginPane.entrypoint !== ENTRYPOINT_ID ||
      typeof pane !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(pane)) {
      throw new Error("invalid");
    }
    return pane;
  } catch {
    throw new Error("invalid Herdr browser pane response");
  }
}

async function liveOwned(owner: BrowserOwner): Promise<Array<{ record: InstanceRow; where: BrowserWhere; tabs: NonNullable<BrowserTargets["tabs"]> }>> {
  const matches = ownerMatches(await instances(), owner);
  const live = [];
  for (const record of matches) {
    try {
      const [where, targets] = await Promise.all([
        control(record.socket, { cmd: "where" }, 2_000) as Promise<BrowserWhere>,
        control(record.socket, { cmd: "targets" }, 2_000) as Promise<BrowserTargets>,
      ]);
      live.push({ record, where, tabs: targets.tabs ?? [] });
      continue;
    } catch {}
    await removeInstance(record.key).catch(() => {});
    withdrawInstance(record.key);
  }
  return live;
}

function isReady(browser: { where: BrowserWhere; tabs: NonNullable<BrowserTargets["tabs"]> }, pane?: string): boolean {
  return Boolean(browser.where.pane) && (!pane || browser.where.pane === pane) &&
    browser.tabs.some((tab) => tab.active && tab.targetId);
}

async function waitForReadyBrowser(owner: BrowserOwner, pane?: string) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await liveOwned(owner);
    if (found.length > 1) throw new Error("multiple browsers claim this Pi pane");
    if (found[0] && isReady(found[0], pane)) return found[0];
    await sleep(150);
  }
  throw new Error("browser companion did not become ready");
}

async function focusPane(pane: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await runHerdr(["plugin", "pane", "focus", pane], environment);
}

async function reuseBrowser(
  found: { record: InstanceRow; where: BrowserWhere; tabs: NonNullable<BrowserTargets["tabs"]> },
  options: CompanionOpenOptions,
  environment: NodeJS.ProcessEnv,
): Promise<CompanionOpenResult> {
  let tabs = found.tabs;
  if (options.url) {
    if (options.newTab) {
      const response = await control(found.record.socket, {
        cmd: "open-tab",
        url: options.url,
        cwd: found.record.ownerProjectDir ?? process.cwd(),
      }) as BrowserTargets;
      tabs = response.tabs ?? tabs;
    } else {
      const active = tabs.find((tab) => tab.active);
      if (!active) throw new Error("browser companion has no active tab");
      const status = await control(found.record.socket, { cmd: "agent.status" }) as { state?: string; controlEpoch?: number };
      if (status.state !== "agent") throw new Error("browser control is with the user; return control before navigating");
      await control(found.record.socket, {
        cmd: "agent.navigate",
        tab: active.id,
        url: options.url,
        expectedControlEpoch: status.controlEpoch,
      });
      tabs = (await control(found.record.socket, { cmd: "targets" }) as BrowserTargets).tabs ?? tabs;
    }
  }
  if (options.focus !== false) await focusPane(found.where.pane!, environment);
  return { action: "reused", key: recordKey(found.record), pane: found.where.pane!, tabs };
}

export function paneOpenArgs(owner: BrowserOwner, options: CompanionOpenOptions): string[] {
  const args = [
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", ENTRYPOINT_ID,
    "--placement", "split",
    "--target-pane", owner.paneId,
    "--direction", "right",
  ];
  const childEnvironment = browserOwnerEnvironment(owner);
  if (options.url) childEnvironment.TERMINAL_BROWSER_COMPANION_URL = options.url;
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (value !== undefined) args.push("--env", `${name}=${value}`);
  }
  args.push(options.focus === false ? "--no-focus" : "--focus");
  return args;
}

async function waitForOpenedBrowser(owner: BrowserOwner, pane: string): Promise<CompanionOpenResult> {
  const browser = await waitForReadyBrowser(owner, pane);
  return {
    action: "opened",
    key: recordKey(browser.record),
    pane,
    tabs: browser.tabs,
  };
}

export async function openCompanion(
  owner: BrowserOwner,
  options: CompanionOpenOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CompanionOpenResult> {
  return withOwnerLock(owner, async () => {
    const existing = await liveOwned(owner);
    if (existing.length > 1) throw new Error("multiple browsers claim this Pi pane");
    if (existing[0]) {
      const ready = isReady(existing[0]) ? existing[0] : await waitForReadyBrowser(owner);
      return reuseBrowser(ready, options, environment);
    }
    const pane = parseOpenedPane(await runHerdr(paneOpenArgs(owner, options), environment));
    try {
      return await waitForOpenedBrowser(owner, pane);
    } catch (error) {
      await runHerdr(["plugin", "pane", "close", pane], environment).catch(() => {});
      throw error;
    }
  });
}

export async function ownedBrowser(owner: BrowserOwner): Promise<InstanceRow> {
  const found = await liveOwned(owner);
  if (found.length === 0) throw new Error("no browser companion for this Pi pane; call browser_open first");
  if (found.length > 1) throw new Error("multiple browsers claim this Pi pane");
  return found[0]!.record;
}

export async function companionTabs(owner: BrowserOwner, request: CompanionTabsRequest): Promise<BrowserTargets> {
  const browser = await ownedBrowser(owner);
  if (request.action === "list") {
    return control(browser.socket, { cmd: "targets" }) as Promise<BrowserTargets>;
  }
  if (request.action === "open") {
    return control(browser.socket, {
      cmd: "open-tab",
      ...(request.url ? { url: request.url, cwd: request.cwd ?? owner.projectDir } : {}),
    }) as Promise<BrowserTargets>;
  }
  if (!request.tab || !Number.isSafeInteger(request.tab) || request.tab < 1) {
    throw new Error(`browser tabs ${request.action} needs a valid tab id`);
  }
  return control(browser.socket, {
    cmd: request.action === "activate" ? "activate-tab" : "close-tab",
    tab: request.tab,
  }) as Promise<BrowserTargets>;
}
