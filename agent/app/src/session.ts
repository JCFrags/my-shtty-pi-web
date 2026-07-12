import { randomUUID } from "node:crypto";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { appendLog, createSession } from "./db/client";
import { schedulePersist } from "./db/persist";
import { detail } from "./transcript";
import type {
  ModelInfo,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ToolCall {
  id: string;
  name: string;
  detail: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "error";
  // The SDK's tool_use_result: structured per-tool data for presentation
  // (Edit/Write carry the full pre-change file).
  result?: unknown;
  kids: ToolCall[];
}

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; call: ToolCall };

export interface Ask {
  tool: string;
  detail: string;
  resolve: (allow: boolean) => void;
}

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export const THINKING = [
  { label: "auto", tokens: null },
  { label: "off", tokens: 0 },
  { label: "high", tokens: 32_000 },
];

// The available models are account-level, so one connected session's list
// serves every session, including restored ones that aren't connected yet.
let availableModels: ModelInfo[] = [];

interface Block {
  type: string;
  name?: string;
  tool_use_id?: string;
}

export interface RestoredSession {
  dbId: string;
  sdkSessionId: string | null;
  createdAt: number;
  title: string;
  model: string;
  permissionMode: string;
  costUsd: number;
  items: Item[];
}

export class Session {
  readonly dbId: string;
  readonly createdAt: number;
  // transcript persisted before the log table existed; frozen at hydrate
  readonly legacyItems: Item[] = [];
  sdkSessionId: string | null = null;
  firstUserText = "";
  working = false;
  activity = "";
  model = "";
  mode: PermissionMode = "default";
  thinking = 0;
  cost = 0;
  ask: Ask | null = null;

  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;

  constructor(private notify: () => void, restored?: RestoredSession) {
    if (restored) {
      this.dbId = restored.dbId;
      this.sdkSessionId = restored.sdkSessionId;
      this.createdAt = restored.createdAt;
      this.firstUserText = restored.title;
      this.model = restored.model;
      this.mode = restored.permissionMode as PermissionMode;
      this.cost = restored.costUsd;
      this.legacyItems = restored.items;
    } else {
      this.dbId = randomUUID();
      this.createdAt = Date.now();
      // the session row must exist before the first log insert satisfies its foreign key;
      // the debounced persist would land it too late
      createSession({ id: this.dbId, createdAt: this.createdAt });
      this.connect();
    }
  }

  private log(message: unknown) {
    try {
      appendLog(this.dbId, { at: Date.now(), message: JSON.stringify(message) });
    } catch (error) {
      console.error("failed to log agent message", error);
    }
  }

  // Restored sessions stay disconnected until the first send, so opening
  // the app doesn't spawn one agent process per historical session.
  private connect() {
    if (this.q) return;
    const thinkingTokens = THINKING[this.thinking].tokens;
    const q = query({
      prompt: this.outgoing(),
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: this.mode,
        includePartialMessages: true,
        ...(this.model ? { model: this.model } : {}),
        ...(thinkingTokens != null ? { maxThinkingTokens: thinkingTokens } : {}),
        ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        canUseTool: (tool, input) =>
          new Promise((resolve) => {
            this.ask = {
              tool,
              detail: detail(input),
              resolve: (allow) => {
                this.ask = null;
                this.notify();
                resolve(
                  allow
                    ? { behavior: "allow", updatedInput: input }
                    : { behavior: "deny", message: "The user declined this tool use." }
                );
              },
            };
            this.notify();
          }),
      },
    });
    this.q = q;
    void this.run(q);
    void q.supportedModels().then((models) => {
      availableModels = models;
      this.notify();
    });
  }

  title(): string {
    if (!this.firstUserText) return "new session";
    const text = this.firstUserText;
    return text.length > 22 ? `${text.slice(0, 21)}…` : text;
  }

  send(text: string) {
    this.connect();
    this.firstUserText ||= text;
    this.working = true;
    const message: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    };
    this.log(message);
    this.queue.push(message);
    this.wake?.();
    this.notify();
  }

  interrupt() {
    if (this.ask) {
      this.ask.resolve(false);
      return;
    }
    if (!this.working || !this.q) return;
    void this.q.interrupt().then(() => {
      this.working = false;
      this.activity = "";
      this.notify();
    });
  }

  modelOptions(): ModelInfo[] {
    return availableModels;
  }

  // Restored sessions haven't connected, so the picker asks for a connection
  // to fetch the model list instead of waiting for the first send.
  loadModels() {
    if (availableModels.length === 0) this.connect();
  }

  setModel(value: string) {
    this.model = value;
    void this.q?.setModel(value);
    this.notify();
  }

  cycleModel() {
    if (availableModels.length === 0) return;
    const at = availableModels.findIndex((m) => m.value === this.model);
    this.setModel(availableModels[(at + 1) % availableModels.length].value);
  }

  setMode(mode: PermissionMode) {
    this.mode = mode;
    void this.q?.setPermissionMode(mode);
    this.notify();
  }

  cycleMode() {
    const at = PERMISSION_MODES.indexOf(this.mode);
    this.setMode(PERMISSION_MODES[(at + 1) % PERMISSION_MODES.length]);
  }

  setThinking(at: number) {
    this.thinking = at;
    void this.q?.setMaxThinkingTokens(THINKING[at].tokens);
    this.notify();
  }

  cycleThinking() {
    this.setThinking((this.thinking + 1) % THINKING.length);
  }

  private async *outgoing(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  private async run(q: Query) {
    try {
      for await (const message of q) {
        this.log(message);
        this.handle(message);
      }
    } catch (error) {
      this.log({ type: "app_error", text: String(error) });
      this.working = false;
      this.notify();
    }
  }

  // Transcript items are folded from the log collection on the frontend;
  // this only tracks control state.
  private handle(message: SDKMessage) {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.sdkSessionId = message.session_id;
          this.model = message.model;
          this.mode = message.permissionMode;
        }
        break;
      case "stream_event": {
        if (message.parent_tool_use_id !== null) break;
        const event = message.event as { type: string; content_block?: Block };
        if (event.type === "content_block_start") {
          if (event.content_block?.type === "thinking") this.activity = "thinking";
          if (event.content_block?.type === "text") this.activity = "";
        }
        break;
      }
      case "assistant":
        for (const block of message.message.content as Block[]) {
          if (block.type === "tool_use" && block.name) this.activity = block.name;
        }
        break;
      case "user": {
        if (message.parent_tool_use_id !== null) break;
        const content = message.message.content;
        if (!Array.isArray(content)) break;
        if ((content as Block[]).some((block) => block.type === "tool_result")) {
          this.activity = "";
        }
        break;
      }
      case "result":
        this.working = false;
        this.activity = "";
        this.cost = message.total_cost_usd;
        break;
    }
    this.notify();
  }
}

class Store {
  sessions: Session[] = [];
  at = 0;
  sidebar = false;
  palette = false;
  paletteAt = 0;
  settings = false;

  private version = 0;
  private listeners = new Set<() => void>();

  notify = () => {
    this.version += 1;
    for (const listener of this.listeners) listener();
    schedulePersist();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  active(): Session {
    return this.sessions[this.at];
  }

  add() {
    this.sessions.push(new Session(this.notify));
    this.at = this.sessions.length - 1;
    this.notify();
  }

  select(at: number) {
    this.at = at;
    this.notify();
  }

  toggleSidebar() {
    this.sidebar = !this.sidebar;
    this.notify();
  }

  togglePalette() {
    this.palette = !this.palette;
    this.paletteAt = 0;
    this.notify();
  }

  closePalette() {
    this.palette = false;
    this.notify();
  }

  movePalette(delta: number, count: number) {
    this.paletteAt = (this.paletteAt + delta + count) % count;
    this.notify();
  }

  openSettings() {
    this.settings = true;
    this.notify();
  }

  closeSettings() {
    this.settings = false;
    this.notify();
  }
}

export const store = new Store();
