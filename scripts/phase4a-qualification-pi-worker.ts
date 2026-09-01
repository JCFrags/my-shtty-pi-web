import { createPiWebxExtension } from "../apps/pi-webx/src/index.js";
import { WebxError, WebxFacadeClient } from "../packages/sdk/src/index.js";

interface ToolPresentation { readonly content: Array<{ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }>; readonly details: unknown }
interface RegisteredTool { readonly name: string; readonly execute: (toolCallId: string, input: unknown, signal: AbortSignal, onUpdate: unknown, context: unknown) => Promise<ToolPresentation> }
interface RegisteredCommand { readonly handler: (args: string, context: unknown) => Promise<void> | void }
type EventHandler = (event?: unknown, context?: unknown) => Promise<unknown> | unknown;
interface Command { readonly id: number; readonly command: string; readonly [key: string]: unknown }

const ownerId = required("PI_WEB_QUALIFICATION_OWNER");
if (!/^qualification-(?:alpha|beta)$/u.test(ownerId)) throw new Error("qualification owner is invalid");
const webxPath = required("WEBXD_SOCKET");
const exportRoot = required("PI_WEB_QUALIFICATION_EXPORT_ROOT");
const tools = new Map<string, RegisteredTool>();
const events = new Map<string, EventHandler>();
const commands = new Map<string, RegisteredCommand>();
const controller = new AbortController();
let activeTools: string[] = [];
let callSequence = 0;
let stopping = false;

const context = {
  cwd: "/deterministic/phase4a-installed-qualification",
  hasUI: false,
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => ownerId },
  ui: {
    setStatus: () => undefined,
    notify: () => undefined,
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
    (result) => process.send?.({ id: command.id, ok: true, result }, () => { if (command.command === "stop") process.exit(0); }),
    (error: unknown) => {
      const failure = boundedFailure(error);
      process.send?.({ id: command.id, ok: false, errorCode: failure.code, errorStatus: failure.status });
    },
  );
});
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.send?.({ kind: "ready", role: "pi" });

async function handle(command: Command): Promise<unknown> {
  if (command.command === "start") {
    await events.get("session_start")?.({}, context);
    return { activeTools: [...activeTools] };
  }
  if (command.command === "stop") { await shutdown(); return { stopped: true }; }
  if (command.command === "execute") {
    const name = text(command.name, "tool name");
    const tool = tools.get(name);
    if (tool === undefined) throw new Error("qualification tool is unavailable");
    callSequence += 1;
    return await tool.execute(`phase4a-qualification-${callSequence}`, command.input, controller.signal, undefined, context);
  }
  if (command.command === "command") {
    const name = text(command.name, "command name");
    const registered = commands.get(name);
    if (registered === undefined) throw new Error("qualification command is unavailable");
    await registered.handler(typeof command.args === "string" ? command.args : "", context);
    return { completed: true };
  }
  throw new Error("unsupported qualification worker command");
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  controller.abort();
  await events.get("session_shutdown")?.({}, context);
}

function boundedFailure(error: unknown): { readonly code: string; readonly status: number } {
  if (error instanceof WebxError && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(error.problem.code) && Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599) return { code: error.problem.code, status: error.status };
  return { code: "UNEXPECTED", status: 0 };
}
function required(name: string): string { const value = process.env[name]; if (value === undefined || value === "" || /[\0\r\n]/u.test(value)) throw new Error(`${name} is required`); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || value === "") throw new Error(`${name} is required`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
