import { createPiWebxExtension } from "../../pi-webx/src/index.js";
import { WebxFacadeClient } from "../../../packages/sdk/src/index.js";

interface ToolPresentation { readonly content: Array<{ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }>; readonly details: unknown }
interface RegisteredTool { readonly name: string; readonly execute: (toolCallId: string, input: unknown, signal: AbortSignal, onUpdate: unknown, context: unknown) => Promise<ToolPresentation> }
interface RegisteredCommand { readonly handler: (args: string, context: unknown) => Promise<void> | void }
type EventHandler = (event?: unknown, context?: unknown) => Promise<unknown> | unknown;
interface Command { readonly id: number; readonly command: string; readonly [key: string]: unknown }

const ownerId = required("PROCESS_ROUTE_PI_OWNER");
const webxPath = required("PROCESS_ROUTE_PI_WEBX_PATH");
const exportRoot = required("PROCESS_ROUTE_PI_EXPORT_ROOT");
const tools = new Map<string, RegisteredTool>();
const events = new Map<string, EventHandler>();
const commands = new Map<string, RegisteredCommand>();
const notifications: string[] = [];
const controller = new AbortController();
let activeTools: string[] = [];
let callSequence = 0;
let stopping = false;

const context = {
  cwd: "/deterministic/phase2b-process",
  hasUI: false,
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => ownerId },
  ui: {
    setStatus: () => undefined,
    notify: (message: string) => { notifications.push(message.slice(0, 1_000)); if (notifications.length > 100) notifications.shift(); },
    select: async () => "Deny",
    input: async () => undefined,
  },
};
const extensionApi = {
  registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
  registerShortcut: () => undefined,
  on: (name: string, handler: EventHandler) => events.set(name, handler),
  getActiveTools: () => [...activeTools],
  setActiveTools: (next: string[]) => { activeTools = [...next]; },
};
createPiWebxExtension(() => new WebxFacadeClient(webxPath, exportRoot), { record: async () => undefined })(extensionApi as never);

process.on("message", (message: unknown) => {
  if (!isRecord(message) || typeof message.id !== "number" || typeof message.command !== "string") return;
  const command = message as Command;
  void handle(command).then(
    (result) => {
      process.send?.({ id: command.id, ok: true, result }, () => {
        if (command.command === "stop") process.exit(0);
      });
    },
    (error: unknown) => process.send?.({ id: command.id, ok: false, error: safeError(error) }),
  );
});
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.send?.({ kind: "ready", role: "pi", pid: process.pid });

async function handle(command: Command): Promise<unknown> {
  if (command.command === "start") {
    await events.get("session_start")?.({}, context);
    return { pid: process.pid, activeTools: [...activeTools] };
  }
  if (command.command === "stop") {
    await shutdown();
    return { pid: process.pid, stopped: true, notifications: [...notifications] };
  }
  if (command.command === "execute") {
    const name = text(command.name, "tool name");
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`Pi tool ${name} is not registered`);
    callSequence += 1;
    return await tool.execute(`phase2b-${name}-${callSequence}`, command.input, controller.signal, undefined, context);
  }
  if (command.command === "command") {
    const name = text(command.name, "command name");
    const registered = commands.get(name);
    if (registered === undefined) throw new Error(`Pi command ${name} is not registered`);
    await registered.handler(typeof command.args === "string" ? command.args : "", context);
    return { notifications: [...notifications] };
  }
  throw new Error(`unsupported Pi worker command: ${command.command}`);
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  controller.abort();
  await events.get("session_shutdown")?.({}, context);
}

function required(name: string): string { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || value === "") throw new Error(`${name} is required`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeError(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1_000) : String(error).slice(0, 1_000); }
