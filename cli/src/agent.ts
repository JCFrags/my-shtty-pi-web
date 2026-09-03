import type { Terminal } from "pixel-terminals";

import { control } from "./control";
import { browsers, recordKey, targets } from "./instances";
import type { Browser } from "./instances";

const DEFAULT_MAX_ELEMENTS = 200;
const MAX_ELEMENTS = 500;

export async function agentCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const subcommand = args.shift();
  if (subcommand === "observe") return observeCommand(terminal, args);
  if (subcommand === "click") return clickCommand(terminal, args);
  throw new Error("agent needs observe or click (terminal-browser agent --help)");
}

async function observeCommand(terminal: Terminal | null, args: string[]): Promise<number> {
  const browserKey = takeValue(args, "--browser");
  const tabValue = takeValue(args, "--tab");
  const maxValue = takeValue(args, "--max-elements");
  const noText = takeBoolean(args, "--no-text");
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent observe --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  const maxElements = parseMaxElements(maxValue);
  print(
    await control(browser.socket, {
      cmd: "agent.observe",
      tab,
      maxElements,
      includeText: !noText,
    }),
  );
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
  if (args.length > 0) throw new Error(`unexpected ${args[0]} (terminal-browser agent click --help)`);
  const browser = await selectBrowser(terminal, browserKey);
  const tab = await selectTab(browser, parseTab(tabValue));
  if (!observationId || observationId.trim().length === 0 || observationId.length > 256) {
    throw new Error("agent click needs --observation <id>");
  }
  const expectedControlEpoch = parseEpoch(epochValue);
  print(
    await control(browser.socket, {
      cmd: "agent.click",
      tab,
      ref,
      observationId,
      expectedControlEpoch,
    }),
  );
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
  const here = found.filter((browser) => browser.inCurrentTab);
  if (here.length === 1) return here[0]!;
  if (here.length === 0) {
    throw new Error("no browser in the current terminal tab; use --browser <key>");
  }
  throw new Error(
    `${here.length} browsers in the current terminal tab; use --browser <key>`,
  );
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

function parseMaxElements(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ELEMENTS;
  const maxElements = Number(value);
  if (!Number.isSafeInteger(maxElements) || maxElements < 1 || maxElements > MAX_ELEMENTS) {
    throw new Error("--max-elements must be an integer from 1 to 500");
  }
  return maxElements;
}

function parseEpoch(value: string | undefined): number {
  if (value === undefined) throw new Error("agent click needs --control-epoch <n>");
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("--control-epoch must be a positive integer");
  }
  return epoch;
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
