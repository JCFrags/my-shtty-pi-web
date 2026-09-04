import fs from "node:fs/promises";
import path from "node:path";

import type { Terminal } from "pixel-terminals";

import { currentBrowserOwner } from "./companion";
import { control } from "./control";
import { browsers, ownedBy, recordKey, targets } from "./instances";
import type { Browser } from "./instances";

const DEFAULT_MAX_ELEMENTS = 200;
const MAX_ELEMENTS = 500;
const MAX_AGENT_STRING = 256;
const MAX_KEY = 128;
const MAX_NATURAL_TEXT = 4_096;
const MAX_REPLACE_TEXT = 32_768;
const MAX_SCROLL_DELTA = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_ACTION_TIMEOUT_MS = 300_000;

export async function agentCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const subcommand = args.shift();
  if (subcommand === "observe") return observeCommand(terminal, args);
  if (subcommand === "click") return clickCommand(terminal, args);
  if (subcommand === "type") return typeCommand(terminal, args);
  if (subcommand === "press-key") return pressKeyCommand(terminal, args);
  if (subcommand === "scroll") return scrollCommand(terminal, args);
  if (subcommand === "navigate") return navigateCommand(terminal, args);
  if (subcommand === "get-url") return getUrlCommand(terminal, args);
  if (subcommand === "wait-for") return waitForCommand(terminal, args);
  if (subcommand === "status") return statusCommand(terminal, args);
  if (subcommand === "pause") return transitionCommand(terminal, args, "agent.pause");
  if (subcommand === "resume") return transitionCommand(terminal, args, "agent.resume");
  throw new Error("agent needs observe, click, type, press-key, scroll, navigate, get-url, wait-for, status, pause, or resume (terminal-browser agent --help)");
}

async function statusCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  rejectTabOption(args);
  const browserKey = takeValue(args, "--browser");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  print(await control(browser.socket, { cmd: "agent.status" }));
  return 0;
}

async function transitionCommand(
  terminal: Terminal | null,
  args: string[],
  cmd: "agent.pause" | "agent.resume",
): Promise<number> {
  rejectTabOption(args);
  const browserKey = takeValue(args, "--browser");
  const epochValue = takeValue(args, "--control-epoch");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  print(await control(browser.socket, {
    cmd,
    expectedControlEpoch: parseEpoch(epochValue, cmd),
  }));
  return 0;
}

async function observeCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const maxValue = takeValue(args, "--max-elements");
  const view = parseObservationView(takeValue(args, "--view"));
  const scope = parseObservationScope(takeValue(args, "--scope"));
  const ref = takeValue(args, "--ref");
  const imageOutput = takeValue(args, "--image-output");
  const noText = takeBoolean(args, "--no-text");
  if (scope === "element" && !ref) throw new Error("agent observe element scope needs --ref");
  if (scope === "viewport" && ref) throw new Error("agent observe --ref needs element scope");
  if (scope === "element" && view === "semantic") throw new Error("agent observe element scope needs a visual view");
  if (view !== "semantic" && !imageOutput) throw new Error("agent observe visual views need --image-output");
  if (view === "semantic" && imageOutput) throw new Error("agent observe --image-output needs a visual view");
  if (ref) validateAgentString(ref, "agent observe ref");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent observe --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const maxElements = parseMaxElements(maxValue);
  const value = await control(browser.socket, {
    cmd: "agent.observe",
    tab,
    maxElements,
    includeText: !noText,
    view,
    scope,
    ...(ref ? { ref } : {}),
  }) as Record<string, unknown>;
  const visual = value.visual as Record<string, unknown> | undefined;
  if (view !== "semantic") {
    if (!visual || !Buffer.isBuffer(visual.data)) throw new Error("browser returned no visual image");
    await fs.writeFile(path.resolve(imageOutput!), visual.data, { flag: "wx", mode: 0o600 });
    const { data: _data, ...metadata } = visual;
    value.visual = metadata;
  }
  print(value);
  return 0;
}

async function clickCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const observationId = takeValue(args, "--observation");
  const epochValue = takeValue(args, "--control-epoch");
  const ref = args.shift();
  if (!ref || ref.startsWith("-")) {
    throw new Error("agent click needs a ref (terminal-browser agent click --help)");
  }
  validateAgentString(ref, "agent click ref");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent click --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const observation = parseObservation(observationId, "agent.click");
  const expectedControlEpoch = parseEpoch(epochValue, "agent.click");
  print(
    await control(browser.socket, {
      cmd: "agent.click",
      tab,
      ref,
      observationId: observation,
      expectedControlEpoch,
    }),
  );
  return 0;
}

async function typeCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const observationId = takeValue(args, "--observation");
  const epochValue = takeValue(args, "--control-epoch");
  const textFlag = takeValue(args, "--text");
  const stdin = takeBoolean(args, "--stdin");
  const replace = takeBoolean(args, "--replace");
  const ref = args.shift();
  if (!ref || ref.startsWith("-")) {
    throw new Error("agent type needs a ref (terminal-browser agent type --help)");
  }
  validateAgentString(ref, "agent type ref");
  if ((textFlag === undefined && !stdin) || (textFlag !== undefined && stdin)) {
    throw new Error("agent type needs exactly one of --text or --stdin");
  }
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent type --help)`);
  const text = stdin
    ? await readStdin(replace ? MAX_REPLACE_TEXT : MAX_NATURAL_TEXT)
    : textFlag!;
  validateTypeText(text, replace);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const observation = parseObservation(observationId, "agent.type");
  const expectedControlEpoch = parseEpoch(epochValue, "agent.type");
  const timeout = replace
    ? ACTION_TIMEOUT_MS
    : Math.min(MAX_ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS + text.length * 250);
  print(
    await control(browser.socket, {
      cmd: "agent.type",
      tab,
      ref,
      text,
      replace,
      observationId: observation,
      expectedControlEpoch,
    }, timeout),
  );
  return 0;
}

async function pressKeyCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const observationId = takeValue(args, "--observation");
  const epochValue = takeValue(args, "--control-epoch");
  const key = args.shift();
  if (!key) {
    throw new Error("agent press-key needs a key (terminal-browser agent press-key --help)");
  }
  if (key.length > MAX_KEY) throw new Error("agent press-key key is too long");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent press-key --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const observation = parseObservation(observationId, "agent.press-key");
  const expectedControlEpoch = parseEpoch(epochValue, "agent.press-key");
  print(await control(browser.socket, {
    cmd: "agent.press-key",
    tab,
    key,
    observationId: observation,
    expectedControlEpoch,
  }, ACTION_TIMEOUT_MS));
  return 0;
}

async function scrollCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const observationId = takeValue(args, "--observation");
  const epochValue = takeValue(args, "--control-epoch");
  const dyValue = takeValue(args, "--dy");
  const dxValue = takeValue(args, "--dx");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent scroll --help)`);
  const dy = parseScrollNumber(dyValue, "--dy");
  const dx = dxValue === undefined ? 0 : parseScrollNumber(dxValue, "--dx");
  validateScroll(dx, dy);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const observation = parseObservation(observationId, "agent.scroll");
  const expectedControlEpoch = parseEpoch(epochValue, "agent.scroll");
  print(await control(browser.socket, {
    cmd: "agent.scroll",
    tab,
    dx,
    dy,
    observationId: observation,
    expectedControlEpoch,
  }, ACTION_TIMEOUT_MS));
  return 0;
}

async function navigateCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const epochValue = takeValue(args, "--control-epoch");
  const url = args.shift();
  if (!url || url.startsWith("-")) {
    throw new Error("agent navigate needs a URL (terminal-browser agent navigate --help)");
  }
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent navigate --help)`);
  validateNavigation(url);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const expectedControlEpoch = parseEpoch(epochValue, "agent.navigate");
  print(await control(browser.socket, {
    cmd: "agent.navigate",
    tab,
    url,
    expectedControlEpoch,
  }, ACTION_TIMEOUT_MS));
  return 0;
}

async function getUrlCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const epochValue = takeValue(args, "--control-epoch");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent get-url --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const expectedControlEpoch = parseEpoch(epochValue, "agent.get-url");
  print(await control(browser.socket, {
    cmd: "agent.get-url",
    tab,
    expectedControlEpoch,
  }, ACTION_TIMEOUT_MS));
  return 0;
}

async function waitForCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const observationId = takeValue(args, "--observation");
  const epochValue = takeValue(args, "--control-epoch");
  const ref = takeValue(args, "--ref");
  const text = takeValue(args, "--text");
  const condition = takeValue(args, "--condition");
  const timeoutValue = takeValue(args, "--timeout-ms");
  if (ref === undefined && text === undefined) throw new Error("agent wait-for needs --ref or --text");
  if (ref !== undefined) validateAgentString(ref, "agent wait-for ref");
  if (condition !== undefined && condition !== "exists" && condition !== "visible" && condition !== "text") {
    throw new Error("agent wait-for --condition must be exists, visible, or text");
  }
  if (condition === "exists" && ref === undefined) throw new Error("agent wait-for exists needs --ref");
  if (condition === "visible" && ref === undefined) throw new Error("agent wait-for visible needs --ref");
  if (condition === "text" && text === undefined) throw new Error("agent wait-for text needs --text");
  if (text !== undefined) validateWaitText(text);
  const timeoutMs = parseWaitTimeout(timeoutValue);
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent wait-for --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const observation = parseObservation(observationId, "agent.wait-for");
  const expectedControlEpoch = parseEpoch(epochValue, "agent.wait-for");
  print(await control(browser.socket, {
    cmd: "agent.wait-for",
    tab,
    ...(ref === undefined ? {} : { ref }),
    ...(text === undefined ? {} : { text }),
    ...(condition === undefined ? {} : { condition }),
    timeoutMs,
    observationId: observation,
    expectedControlEpoch,
  }, Math.min(MAX_ACTION_TIMEOUT_MS, timeoutMs + 5_000)));
  return 0;
}

async function selectBrowser(terminal: Terminal | null, key: string | undefined): Promise<Browser> {
  const found = await browsers(terminal);
  if (key) {
    const matches = found.filter((browser) => recordKey(browser) === key);
    if (matches.length === 0) throw new Error(`no browser ${key}`);
    if (matches.length > 1) throw new Error(`browser key ${key} is ambiguous`);
    return matches[0]!;
  }
  if (process.env.HERDR_ENV === "1" || process.env.TERMINAL_BROWSER_OWNER_PANE_ID) {
    const owner = currentBrowserOwner(process.env, process.cwd());
    const owned = found.filter((browser) => ownedBy(browser, owner));
    if (owned.length === 1) return owned[0]!;
    if (owned.length === 0) {
      throw new Error("no browser companion for this Pi pane; call browser_open first");
    }
    throw new Error("multiple browsers claim this Pi pane");
  }
  const here = found.filter((browser) => browser.inCurrentTab);
  if (here.length === 1) return here[0]!;
  if (here.length === 0) throw new Error("no browser in the current terminal tab; use --browser <key>");
  throw new Error(`${here.length} browsers in the current terminal tab; use --browser <key>`);
}

async function selectTab(browser: Browser, requested: number | undefined): Promise<number> {
  const available = await targets(browser);
  const selected = requested === undefined
    ? available.find((tab) => tab.active)
    : available.find((tab) => tab.id === requested);
  if (selected) return selected.id;
  if (requested === undefined) throw new Error(`browser ${recordKey(browser)} has no active tab`);
  throw new Error(`browser ${recordKey(browser)} has no tab ${requested}`);
}

function rejectTabOption(args: string[]) {
  if (args.some((arg) => arg === "--tab" || arg.startsWith("--tab="))) {
    throw new Error("agent status, pause, and resume do not accept --tab");
  }
}

function takeValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    args.splice(at, 2);
    return value;
  }
  const prefix = `${name}=`;
  const inline = args.findIndex((arg) => arg.startsWith(prefix));
  if (inline >= 0) return args.splice(inline, 1)[0]!.slice(prefix.length);
  return undefined;
}

function takeBoolean(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

function parseTab(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.startsWith("t") ? value.slice(1) : value;
  if (!/^\d+$/.test(normalized)) throw new Error(`invalid --tab ${value}`);
  const tab = Number(normalized);
  if (!Number.isSafeInteger(tab) || tab < 1) throw new Error(`invalid --tab ${value}`);
  return tab;
}

function parseObservationView(value: string | undefined): "semantic" | "visual" | "both" {
  if (value === undefined) return "semantic";
  if (value !== "semantic" && value !== "visual" && value !== "both") {
    throw new Error("--view must be semantic, visual, or both");
  }
  return value;
}

function parseObservationScope(value: string | undefined): "viewport" | "element" {
  if (value === undefined) return "viewport";
  if (value !== "viewport" && value !== "element") {
    throw new Error("--scope must be viewport or element");
  }
  return value;
}

function parseMaxElements(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ELEMENTS;
  const maxElements = Number(value);
  if (!Number.isSafeInteger(maxElements) || maxElements < 1 || maxElements > MAX_ELEMENTS) {
    throw new Error("--max-elements must be an integer from 1 to 500");
  }
  return maxElements;
}

function parseEpoch(value: string | undefined, command: string): number {
  if (value === undefined) throw new Error(`${command} needs --control-epoch <n>`);
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`${command} --control-epoch must be a positive integer`);
  }
  return epoch;
}

function parseObservation(value: string | undefined, command: string): string {
  if (value === undefined) throw new Error(`${command} needs --observation <id>`);
  validateAgentString(value, `${command} observationId`);
  return value;
}

function validateAgentString(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > MAX_AGENT_STRING) {
    throw new Error(`${name} must be a non-empty string of at most ${MAX_AGENT_STRING} characters`);
  }
}

function parseScrollNumber(value: string | undefined, name: string): number {
  if (value === undefined) throw new Error(`agent scroll needs ${name} <n>`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`agent scroll ${name} must be finite`);
  return parsed;
}

function validateScroll(dx: number, dy: number) {
  if (Math.abs(dx) > MAX_SCROLL_DELTA || Math.abs(dy) > MAX_SCROLL_DELTA) {
    throw new Error("agent scroll delta is too large");
  }
  if (dx === 0 && dy === 0) throw new Error("agent scroll needs a nonzero delta");
}

function validateTypeText(text: string, replace: boolean) {
  const max = replace ? MAX_REPLACE_TEXT : MAX_NATURAL_TEXT;
  if (text.length > max) throw new Error(`agent type text must be at most ${max} characters`);
  if (text.includes("\0")) throw new Error("agent type text contains NUL");
  if (!replace && text.length === 0) throw new Error("agent type text must not be empty unless --replace is used");
}

function validateWaitText(text: string) {
  if (text.length === 0 || text.length > 1_024) throw new Error("agent wait-for text must be non-empty and at most 1024 characters");
  if (text.includes("\0")) throw new Error("agent wait-for text contains NUL");
}

function validateNavigation(url: string) {
  if (url.trim().length === 0 || url.length > 8_192) throw new Error("agent navigate URL must be non-empty and at most 8192 characters");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) throw new Error("agent navigate URL contains control characters");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "file" && scheme !== "about") {
    throw new Error("agent navigate URL scheme is not allowed");
  }
  if (scheme === "about" && url.trim().toLowerCase() !== "about:blank") {
    throw new Error("agent navigate only allows about:blank");
  }
}

function parseWaitTimeout(value: string | undefined): number {
  if (value === undefined) return 10_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new Error("agent wait-for --timeout-ms must be an integer from 0 to 60000");
  }
  return timeout;
}

async function readStdin(maxLength: number): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    length += value.length;
    if (length > maxLength) throw new Error(`agent type stdin must be at most ${maxLength} characters`);
    chunks.push(value);
  }
  return chunks.join("");
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
