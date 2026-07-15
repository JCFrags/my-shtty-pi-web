import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseMarkdown } from "pixel-react";
import type { ContainerSelection, MarkRef, PastedImage } from "pixel-react";

import { attachmentsDir, persistAttachment } from "./attachments";
import { appendLog, createSession } from "./db/client";
import { MARKDOWN_TOOL, pixelMcpServer } from "./markdown-tool";
import { schedulePersist } from "./db/persist";
import { detail } from "./transcript";
import type {
  ModelInfo,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

export interface ToolCall {
  id: string;
  name: string;
  detail: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: unknown;
  kids: ToolCall[];
}

export interface ComposerAttachment {
  image: PastedImage;
  durable: string | null;
  persisted: Promise<string | null>;
}

export interface RichMark {
  offset: number;
  data: string;
}

export interface SelectionRef {
  title: string;
  doc: string;
  start: number;
  end: number;
}

export function selectionMarkdown(ref: SelectionRef): string {
  return Buffer.from(ref.doc, "utf8").subarray(ref.start, ref.end).toString("utf8").trim();
}

export type Item =
  | { kind: "user"; text: string; images?: string[]; marks?: RichMark[] }
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

let availableModels: ModelInfo[] = [];
let availableCommands: SlashCommand[] | null = null;

const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

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
}

export class Session {
  readonly dbId: string;
  readonly createdAt: number;
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
  private sendChain: Promise<void> = Promise.resolve();
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
    } else {
      this.dbId = randomUUID();
      this.createdAt = Date.now();
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

  private connect() {
    if (this.q) return;
    const thinkingTokens = THINKING[this.thinking].tokens;
    const q = query({
      prompt: this.outgoing(),
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: this.mode,
        includePartialMessages: true,
        mcpServers: { pixel: pixelMcpServer },
        allowedTools: [MARKDOWN_TOOL],
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
    void q.supportedCommands().then((commands) => {
      availableCommands = commands;
      this.notify();
    });
  }

  title(): string {
    if (!this.firstUserText) return "new session";
    const text = this.firstUserText;
    return text.length > 22 ? `${text.slice(0, 21)}…` : text;
  }

  send(text: string, marks: MarkRef[] = []) {
    const clean = text.replace(/\uFFFC/g, "").trim();
    if (!clean && marks.length === 0) return;
    this.sendChain = this.sendChain.then(() => this.sendNow(text, marks)).catch(() => {});
  }

  // selection-reference sentinels become inline markdown excerpts the model can read
  private inlineSelections(raw: string, marks: MarkRef[]): string {
    const bytes = Buffer.from(raw, "utf8");
    const sentinel = Buffer.byteLength("\uFFFC", "utf8");
    let out = "";
    let at = 0;
    for (const mark of [...marks].sort((a, b) => a.offset - b.offset)) {
      const ref = store.composerSelection(mark.id);
      if (!ref) continue;
      out += bytes.subarray(at, mark.offset).toString("utf8");
      out += `\n<user-selection doc="${ref.title}">\n${selectionMarkdown(ref)}\n</user-selection>\n`;
      at = mark.offset + sentinel;
    }
    out += bytes.subarray(at).toString("utf8");
    return out;
  }

  private async sendNow(raw: string, marks: MarkRef[]) {
    const clean = this.inlineSelections(raw, marks).replace(/\uFFFC/g, "").trim();
    const images: { path: string; media: string; data: string }[] = [];
    const rich: RichMark[] = [];
    for (const mark of marks) {
      const ref = store.composerSelection(mark.id);
      if (ref) {
        rich.push({ offset: mark.offset, data: JSON.stringify({ kind: "selection", ...ref }) });
        continue;
      }
      const attachment = store.composerImage(mark.id);
      if (!attachment) continue;
      const path = (await attachment.persisted) ?? attachment.image.path;
      rich.push({ offset: mark.offset, data: JSON.stringify({ kind: "image", path }) });
      const media = IMAGE_MEDIA[extname(path).toLowerCase()];
      if (!media) continue;
      try {
        images.push({ path, media, data: readFileSync(path).toString("base64") });
      } catch {
        continue;
      }
    }
    if (!clean && images.length === 0) return;
    this.connect();
    this.firstUserText ||= clean || "image";
    this.working = true;
    const content =
      images.length === 0
        ? clean
        : [
            ...images.map((a) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: a.media, data: a.data },
            })),
            ...(clean ? [{ type: "text" as const, text: clean }] : []),
          ];
    const message: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content } as SDKUserMessage["message"],
    };
    const logged =
      rich.length === 0
        ? message
        : {
            ...message,
            message: {
              role: "user",
              content: [{ type: "rich_text", text: raw, marks: rich }],
            },
          };
    this.log(logged);
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

  loadModels() {
    if (availableModels.length === 0) this.connect();
  }

  commands(): SlashCommand[] | null {
    return availableCommands;
  }

  loadCommands() {
    if (availableCommands === null) this.connect();
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
  settingsAt = 0;
  settingsQuery = "";
  composerText = "";
  composerEpoch = 0;
  composerMarks: MarkRef[] = [];
  markdownDoc: { title: string; text: string; highlight?: { start: number; end: number } } | null =
    null;
  panelFraction = 0.45;
  panelSelection: ContainerSelection | null = null;
  private composerSelections = new Map<number, SelectionRef>();
  private composerImages = new Map<number, ComposerAttachment>();
  private nextMarkId = 1;
  fontPath: string | null = null;
  fontId = 0;

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

  openMarkdown(title: string, text: string, highlight?: { start: number; end: number }) {
    this.markdownDoc = { title, text, highlight };
    this.notify();
  }

  setPanelSelection(selection: ContainerSelection | null) {
    this.panelSelection = selection;
    this.notify();
  }

  composerSelection(id: number): SelectionRef | undefined {
    return this.composerSelections.get(id);
  }

  addPanelSelectionToChat(): number | null {
    const doc = this.markdownDoc;
    const selection = this.panelSelection;
    if (!doc || !selection) return null;
    const indices = selection.parts
      .map((part) => /^md:(\d+)$/.exec(part.key)?.[1])
      .filter((v): v is string => v != null)
      .map(Number);
    if (indices.length === 0) return null;
    const blocks = parseMarkdown(doc.text);
    const covered = indices.map((i) => blocks[i]).filter(Boolean);
    if (covered.length === 0) return null;
    const bytes = Buffer.from(doc.text, "utf8");
    let start = Math.min(...covered.map((b) => b.sourceStart));
    let end = Math.max(...covered.map((b) => b.sourceEnd));
    while (start > 0 && bytes[start - 1] !== 0x0a) start--;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const id = this.nextMarkId++;
    this.composerSelections.set(id, { title: doc.title, doc: doc.text, start, end });
    this.panelSelection = null;
    this.notify();
    return id;
  }

  revealSelection(ref: SelectionRef) {
    this.openMarkdown(ref.title, ref.doc, { start: ref.start, end: ref.end });
  }

  closeMarkdown() {
    this.markdownDoc = null;
    this.notify();
  }

  setPanelFraction(fraction: number) {
    const next = Math.min(0.85, Math.max(0.15, fraction));
    if (next === this.panelFraction) return;
    this.panelFraction = next;
    this.notify();
  }

  togglePalette() {
    this.palette = !this.palette;
    this.paletteAt = 0;
    this.settings = false;
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
    this.settingsAt = 0;
    this.settingsQuery = "";
    this.notify();
  }

  closeSettings() {
    this.settings = false;
    this.notify();
  }

  moveSettings(delta: number, count: number) {
    if (count === 0) return;
    this.settingsAt = (this.settingsAt + delta + count) % count;
    this.notify();
  }

  setSettingsQuery(query: string) {
    this.settingsQuery = query;
    this.settingsAt = 0;
    this.notify();
  }

  clearComposer() {
    this.composerText = "";
    this.composerMarks = [];
    this.composerImages.clear();
    this.composerSelections.clear();
    this.composerEpoch += 1;
    this.notify();
  }

  addComposerImage(image: PastedImage): number {
    const id = this.nextMarkId++;
    const attachment: ComposerAttachment = {
      image,
      durable: null,
      persisted: persistAttachment(image.path).then((durable) => {
        if (durable && this.composerImages.get(id) === attachment) {
          attachment.durable = durable;
          this.registerAttachmentAlias(durable, image.path);
          this.notify();
        }
        return durable;
      }),
    };
    this.composerImages.set(id, attachment);
    return id;
  }

  private tmpByDurable = new Map<string, string>();

  registerAttachmentAlias(durable: string, tmp: string) {
    this.tmpByDurable.set(durable, tmp);
  }

  attachmentAliases(src: string): string[] | undefined {
    const tmp = this.tmpByDurable.get(src);
    return tmp ? [tmp] : undefined;
  }

  composerImage(id: number): ComposerAttachment | undefined {
    return this.composerImages.get(id);
  }

  syncComposerMarks(marks: MarkRef[]) {
    for (const mark of marks) {
      if (!mark.data || this.composerImages.has(mark.id)) continue;
      if (this.composerSelections.has(mark.id)) continue;
      let parsed: { kind?: string; path?: string } & Partial<SelectionRef>;
      try {
        parsed = JSON.parse(mark.data);
      } catch {
        continue;
      }
      if (
        parsed.kind === "selection" &&
        typeof parsed.doc === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.start === "number" &&
        typeof parsed.end === "number"
      ) {
        this.composerSelections.set(mark.id, {
          title: parsed.title,
          doc: parsed.doc,
          start: parsed.start,
          end: parsed.end,
        });
        continue;
      }
      if (parsed.kind !== "image" || !parsed.path) continue;
      const path = parsed.path;
      const durable = path.startsWith(attachmentsDir) ? path : null;
      const attachment: ComposerAttachment = {
        image: { path, width: 0, height: 0 },
        durable,
        persisted: Promise.resolve(durable),
      };
      if (!durable) {
        attachment.persisted = persistAttachment(path).then((d) => {
          if (d && this.composerImages.get(mark.id) === attachment) {
            attachment.durable = d;
            this.registerAttachmentAlias(d, path);
            this.notify();
          }
          return d;
        });
      }
      this.composerImages.set(mark.id, attachment);
    }
    const current = this.composerMarks;
    if (
      marks.length === current.length &&
      marks.every((mark, i) => mark.id === current[i].id)
    ) {
      return;
    }
    this.composerMarks = marks;
    this.notify();
  }

  setFont(path: string | null, id: number) {
    this.fontPath = path;
    this.fontId = id;
    this.notify();
  }
}

export const store = new Store();
