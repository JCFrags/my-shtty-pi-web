import { parseElementTarget } from "./agent/protocol";
import { parseLocator } from "./agent/locator";
import type { DialogResponse } from "./agent/dialogs";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { callerTty } from "pixel-terminals";
import {
  INTEROP_PROTOCOL_VERSIONS,
  advertiseInstance,
  openSpecSchema,
  removeInstance,
  browserOwnerColumns,
  upsertInstance,
  withdrawInstance,
} from "pixel-store";
import type { BrowserOwner, InstanceRow, OpenResult, OpenSpec } from "pixel-store";

import type { AgentControlSnapshot } from "./agent/control";
import {
  parseDragRequest,
  parseGetUrlRequest,
  parseHoverRequest,
  parseNavigateRequest,
  parsePressKeyRequest,
  parseScrollRequest,
  parseTypeRequest,
  parseWaitForRequest,
} from "./agent/protocol";
import type {
  AgentActionOutcome,
  AgentClickRequest,
  AgentUploadRequest,
  AgentClickResult,
  AgentDragRequest,
  AgentDragResult,
  AgentGetUrlRequest,
  AgentGetUrlResult,
  AgentHoverRequest,
  AgentHoverResult,
  AgentNavigateRequest,
  AgentNavigateResult,
  AgentObservation,
  AgentObserveRequest,
  AgentPressKeyRequest,
  AgentPressKeyResult,
  AgentScrollRequest,
  AgentScrollResult,
  AgentTypeRequest,
  AgentTypeResult,
  AgentWaitForRequest,
  AgentWaitForResult,
} from "./agent/types";
import type { BrowserState } from "./page/types";
import { INSTANCES_DIR } from "pixel-store";

export interface Where {
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}

export interface InteropInfo {
  mode: "browser" | "app";
}

export interface ControlHost {
  key: string;
  tty: string | null;
  owner: BrowserOwner | null;
  where(): Promise<Where>;
  splitDir: InstanceRow["splitDir"];
  parentTty: string | null;
  state(): BrowserState;
  interop(): InteropInfo;
  openAppTab(spec: OpenSpec, app: NonNullable<OpenSpec["app"]>): OpenResult;
  openTab(url?: string, cwd?: string): number;
  activateTab(id: number): boolean;
  agentTabSwitchAllowed(): boolean;
  agentStatus(): AgentControlSnapshot;
  agentPause(expectedEpoch: number): AgentControlSnapshot;
  agentResume(expectedEpoch: number): AgentControlSnapshot;
  agentObserve(id: number, request: AgentObserveRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentObservation>>;
  agentUpload(id: number, request: AgentUploadRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentClickResult>>;
  agentDownloads(action: "list" | "wait" | "cancel", id: string | undefined, contextId: number | undefined, timeout: number, epoch: number): unknown;
  agentClick(id: number, request: AgentClickRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentClickResult>>;
  agentHover(id: number, request: AgentHoverRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentHoverResult>>;
  agentDrag(id: number, request: AgentDragRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentDragResult>>;
  agentType(id: number, request: AgentTypeRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentTypeResult>>;
  agentPressKey(id: number, request: AgentPressKeyRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentPressKeyResult>>;
  agentScroll(id: number, request: AgentScrollRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentScrollResult>>;
  agentNavigate(id: number, request: AgentNavigateRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentNavigateResult>>;
  agentGetUrl(id: number, request: AgentGetUrlRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentGetUrlResult>>;
  agentWaitFor(id: number, request: AgentWaitForRequest, signal?: AbortSignal): Promise<AgentActionOutcome<AgentWaitForResult>>;
  agentContext(action: "open" | "activate" | "close", id: number | undefined, url: string | undefined, epoch: number): Promise<unknown>;
  agentDialog(id: number, request: DialogResponse): Promise<unknown>;
  waitContexts(afterId: number, timeoutMs: number, expectedEpoch: number): Promise<unknown>;
  closeTab(id: number): boolean;
  agentTouch(id: number): boolean;
  agentRelease(): void;
  tabs(): unknown;
  targets(): Promise<unknown>;
  viewport(): { width: number; height: number } | null;
}

interface ControlRequest {
  id?: string;
  cmd: string;
  action?: unknown;
  url?: string;
  cwd?: string;
  tab?: number;
  maxElements?: unknown;
  includeText?: unknown;
  view?: unknown;
  scope?: unknown;
  ref?: unknown;
  locator?: unknown;
  fromLocator?: unknown;
  toLocator?: unknown;
  filter?: unknown;
  x?: unknown;
  y?: unknown;
  fromRef?: unknown;
  fromX?: unknown;
  fromY?: unknown;
  toRef?: unknown;
  toX?: unknown;
  toY?: unknown;
  button?: unknown;
  observationId?: unknown;
  expectedControlEpoch?: unknown;
  key?: unknown;
  text?: unknown;
  replace?: unknown;
  dx?: unknown;
  dy?: unknown;
  condition?: unknown;
  timeoutMs?: unknown;
  afterId?: unknown;
  dialogId?: unknown;
  files?: unknown;
  downloadId?: unknown;
  accept?: unknown;
}

export const MAX_CONTROL_LINE_BYTES = 256 * 1024;

export class Registry {
  private readonly host: ControlHost;
  readonly socketPath: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private disposed = false;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? callerTty().path;
    this.socketPath = path.join(INSTANCES_DIR, `${host.key}.sock`);
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.on("error", () => {});
    this.server.listen(this.socketPath);
    this.write();
    this.advertise();
  }

  setCdpPort(port: number | null) {
    this.cdpPort = port;
    this.write();
  }

  update() {
    this.write();
  }

  record(): InstanceRow {
    return {
      ...this.host.state(),
      tabs: this.host.tabs(),
      viewport: this.host.viewport(),
      pid: process.pid,
      key: this.host.key,
      tty: this.tty,
      splitDir: this.host.splitDir,
      parentTty: this.host.parentTty,
      ...browserOwnerColumns(this.host.owner),
      socket: this.socketPath,
      cdpPort: this.cdpPort,
      startedAt: this.startedAt,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.server?.close();
    this.server = null;
    void removeInstance(this.host.key).catch(() => {});
    withdrawInstance(this.host.key);
    fs.rmSync(this.socketPath, { force: true });
  }

  private write() {
    if (this.disposed) return;
    void upsertInstance(this.record()).catch(() => {});
  }

  private advertise() {
    advertiseInstance(this.host.key, {
      protocolVersions: INTEROP_PROTOCOL_VERSIONS,
      mode: this.host.interop().mode,
      pid: process.pid,
      socket: this.socketPath,
      startedAt: this.startedAt,
      owner: this.host.owner,
    });
  }

  private serve(connection: net.Socket) {
    let buffer = "";
    let closed = false;
    const pending = new Set<AbortController>();
    const cancel = () => { for (const controller of pending) controller.abort(new Error("browser request disconnected")); };
    const tooLarge = () => {
      if (closed) return;
      closed = true;
      cancel();
      buffer = "";
      connection.end(`${JSON.stringify({ id: null, ok: false, error: "request too large" })}\n`);
    };
    connection.setEncoding("utf8");
    connection.on("error", () => { closed = true; cancel(); });
    connection.on("close", () => {
      closed = true;
      cancel();
    });
    connection.on("data", (chunk: string) => {
      if (closed) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
          tooLarge();
          return;
        }
        if (line.trim()) {
          const controller = new AbortController();
          pending.add(controller);
          void this.dispatch(line, connection, controller.signal).finally(() => {
            controller.abort(new Error("browser request finished"));
            pending.delete(controller);
          });
        }
        if (closed) return;
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_LINE_BYTES) tooLarge();
    });
  }

  private async dispatch(line: string, connection: net.Socket, signal: AbortSignal) {
    let id: string | null = null;
    try {
      const request = JSON.parse(line) as ControlRequest;
      id = typeof request.id === "string" && request.id.length > 0 ? request.id : null;
      if (id === null) throw new Error("request id required");
      if (request.cmd === "interop/1/open") {
        const parsed = openSpecSchema.safeParse(request);
        if (!parsed.success) throw new Error("malformed open request");
        const spec = parsed.data;
        const tab = spec.app
          ? this.host.openAppTab(spec, spec.app).tab
          : this.host.openTab(spec.url);
        connection.end(`${JSON.stringify({ id, ok: true, data: { tab } })}\n`);
        return;
      }
      const data = await this.handle(request, signal);
      signal.throwIfAborted();
      const response = binaryResponse(id, data);
      connection.write(`${JSON.stringify(response.header)}\n`);
      if (response.binary) connection.end(response.binary);
      else connection.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        connection.end(`${JSON.stringify({ id, ok: false, error: message })}\n`);
      } catch {}
    }
  }

  private async handle(request: ControlRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    switch (request.cmd) {
      case "state":
        return this.record();
      case "where":
        return this.host.where();
      case "open-tab": {
        const id = this.host.openTab(request.url, request.cwd);
        return { ...this.record(), openedTab: id, tabs: await this.host.targets() };
      }
      case "targets":
        return { ...this.record(), tabs: await this.host.targets() };
      case "activate-tab": {
        if (request.tab === undefined) throw new Error("activate-tab needs a tab id");
        if (!this.host.activateTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      case "close-tab": {
        if (request.tab === undefined) throw new Error("close-tab needs a tab id");
        if (!this.host.closeTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      case "agent.context": {
        if (request.action !== "open" && request.action !== "activate" && request.action !== "close") throw new Error("invalid context action");
        if (request.url !== undefined && (typeof request.url !== "string" || request.url.length > 8192)) throw new Error("invalid context URL");
        const tab = request.action === "open" ? undefined : requiredTab(request, "agent.context");
        return this.host.agentContext(request.action, tab, request.url, requiredEpoch(request.expectedControlEpoch, "agent.context"));
      }
      case "agent.dialog": {
        const tab = requiredTab(request, "agent.dialog");
        if (typeof request.dialogId !== "string" || request.dialogId.length > 128 || !request.dialogId) throw new Error("dialogId required");
        if (typeof request.accept !== "boolean") throw new Error("accept must be boolean");
        if (request.text !== undefined && (typeof request.text !== "string" || request.text.length > 32768)) throw new Error("invalid prompt text");
        return this.host.agentDialog(tab, { dialogId: request.dialogId, accept: request.accept, text: request.text as string | undefined, expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.dialog") });
      }
      case "wait-contexts": {
        const after = request.afterId;
        const timeout = request.timeoutMs ?? 10000;
        if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) throw new Error("afterId must be a nonnegative integer");
        if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("invalid context wait timeout");
        return this.host.waitContexts(after, timeout, requiredEpoch(request.expectedControlEpoch, "wait-contexts"));
      }
      case "agent.status":
        return this.host.agentStatus();
      case "agent.pause":
        return this.host.agentPause(requiredEpoch(request.expectedControlEpoch, "agent.pause"));
      case "agent.resume":
        return this.host.agentResume(requiredEpoch(request.expectedControlEpoch, "agent.resume"));
      case "agent.observe": {
        const parsed = observeRequest(request);
        return this.host.agentObserve(parsed.tab, parsed.request, signal);
      }
      case "agent.downloads": {
        if (request.action !== "list" && request.action !== "wait" && request.action !== "cancel") throw new Error("invalid download action");
        const timeout = request.timeoutMs ?? 10000;
        if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("invalid download wait timeout");
        if (request.action !== "list" && (typeof request.downloadId !== "string" || !/^[a-f0-9-]{36}$/.test(request.downloadId))) throw new Error("download ID required");
        const tab = request.tab === undefined ? undefined : requiredTab(request, "agent.downloads");
        return this.host.agentDownloads(request.action, request.downloadId as string | undefined, tab, timeout, requiredEpoch(request.expectedControlEpoch, "agent.downloads"));
      }
      case "agent.upload": {
        const parsed = clickRequest(request);
        if (!Array.isArray(request.files) || !request.files.length || request.files.length > 16 || request.files.some(file => typeof file !== "string" || file.length > 4096)) throw new Error("upload requires 1 to 16 file paths");
        return this.host.agentUpload(parsed.tab, { ...parsed.request, files: request.files as string[] }, signal);
      }
      case "agent.click": {
        const parsed = clickRequest(request);
        return this.host.agentClick(parsed.tab, parsed.request, signal);
      }
      case "agent.hover": {
        const parsed = parseHoverRequest(request);
        return this.host.agentHover(parsed.tab, parsed.request, signal);
      }
      case "agent.drag": {
        const parsed = parseDragRequest(request);
        return this.host.agentDrag(parsed.tab, parsed.request, signal);
      }
      case "agent.type": {
        const parsed = parseTypeRequest(request);
        return this.host.agentType(parsed.tab, parsed.request, signal);
      }
      case "agent.press-key": {
        const parsed = parsePressKeyRequest(request);
        return this.host.agentPressKey(parsed.tab, parsed.request, signal);
      }
      case "agent.scroll": {
        const parsed = parseScrollRequest(request);
        return this.host.agentScroll(parsed.tab, parsed.request, signal);
      }
      case "agent.navigate": {
        const parsed = parseNavigateRequest(request);
        return this.host.agentNavigate(parsed.tab, parsed.request, signal);
      }
      case "agent.get-url": {
        const parsed = parseGetUrlRequest(request);
        return this.host.agentGetUrl(parsed.tab, parsed.request, signal);
      }
      case "agent.wait-for": {
        const parsed = parseWaitForRequest(request);
        return this.host.agentWaitFor(parsed.tab, parsed.request, signal);
      }
      case "agent-touch": {
        if (request.tab === undefined) throw new Error("agent-touch needs a tab id");
        if (!this.host.agentTouch(request.tab)) throw new Error(`no tab ${request.tab}`);
        return this.record();
      }
      case "agent-release": {
        this.host.agentRelease();
        return { ...this.record(), tabs: await this.host.targets() };
      }
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }
}

const DEFAULT_MAX_ELEMENTS = 200;
const MAX_ELEMENTS = 500;
const MAX_AGENT_STRING = 256;

function requiredTab(request: ControlRequest, command: string): number {
  if (request.tab === undefined) throw new Error(`${command} needs a tab id`);
  if (typeof request.tab !== "number" || !Number.isSafeInteger(request.tab) || request.tab < 1) {
    throw new Error(`${command} needs a valid tab id`);
  }
  return request.tab;
}

function observeRequest(request: ControlRequest): {
  tab: number;
  request: AgentObserveRequest;
} {
  const tab = requiredTab(request, "agent.observe");
  const maxElements = request.maxElements === undefined ? DEFAULT_MAX_ELEMENTS : request.maxElements;
  if (
    typeof maxElements !== "number" ||
    !Number.isSafeInteger(maxElements) ||
    maxElements < 1 ||
    maxElements > MAX_ELEMENTS
  ) {
    throw new Error("agent.observe maxElements must be an integer from 1 to 500");
  }
  const includeText = request.includeText === undefined ? true : request.includeText;
  if (typeof includeText !== "boolean") {
    throw new Error("agent.observe includeText must be boolean");
  }
  const view = request.view === undefined ? "semantic" : request.view;
  if (view !== "semantic" && view !== "visual" && view !== "both") {
    throw new Error("agent.observe view must be semantic, visual, or both");
  }
  const scope = request.scope === undefined ? "viewport" : request.scope;
  if (scope !== "viewport" && scope !== "element") {
    throw new Error("agent.observe scope must be viewport or element");
  }
  const ref = request.ref === undefined ? undefined : requiredObserveRef(request.ref);
  if (scope === "element" && view === "semantic") {
    throw new Error("agent.observe element scope requires a visual view");
  }
  if (scope === "element" && ref === undefined) {
    throw new Error("agent.observe element scope requires ref");
  }
  if (scope === "viewport" && ref !== undefined) {
    throw new Error("agent.observe ref requires element scope");
  }
  return {
    tab,
    request: { maxElements, includeText, view, scope, ...(ref ? { ref } : {}), ...(request.filter === undefined ? {} : { filter: parseLocator(request.filter) }) },
  };
}

function requiredObserveRef(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_AGENT_STRING) {
    throw new Error(`agent.observe ref must be a non-empty string of at most ${MAX_AGENT_STRING} characters`);
  }
  return value;
}

function binaryResponse(id: string, data: unknown): {
  header: { id: string; ok: true; data: unknown; binaryBytes?: number };
  binary?: Buffer;
} {
  if (!data || typeof data !== "object") return { header: { id, ok: true, data } };
  const observation = data as AgentObservation;
  if (!observation.visual?.data || !Buffer.isBuffer(observation.visual.data)) {
    return { header: { id, ok: true, data } };
  }
  const binary = observation.visual.data;
  const visual = { ...observation.visual };
  delete (visual as Partial<typeof visual>).data;
  return {
    header: {
      id,
      ok: true,
      data: { ...observation, visual },
      binaryBytes: binary.byteLength,
    },
    binary,
  };
}

function clickRequest(request: ControlRequest): {
  tab: number;
  request: AgentClickRequest;
} {
  const tab = requiredTab(request, "agent.click");
  return {
    tab,
    request: {
      ...parseElementTarget(request.ref, request.locator),
      observationId: requiredAgentString(request.observationId, "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.click"),
    },
  };
}

function requiredAgentString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_AGENT_STRING) {
    throw new Error(`agent.click ${name} must be a non-empty string of at most ${MAX_AGENT_STRING} characters`);
  }
  return value;
}

function requiredEpoch(value: unknown, command: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${command} expectedControlEpoch must be a positive integer`);
  }
  return value;
}
