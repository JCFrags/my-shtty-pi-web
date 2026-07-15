import type { LogEntry } from "./db/schema";
import type { Item, ToolCall } from "./session";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  path?: string;
  marks?: { offset: number; data: string }[];
}

export function detail(input: Record<string, unknown>): string {
  const keys = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];
  const found = keys.map((k) => input[k]).find((v) => typeof v === "string");
  const text = (found as string) ?? JSON.stringify(input) ?? "";
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 64 ? `${flat.slice(0, 61)}…` : flat;
}

interface FoldState {
  applied: number;
  items: Item[];
  tools: Map<string, ToolCall>;
  draftFrom: number | null;
}

const folds = new Map<string, FoldState>();

export function transcript(sessionId: string, entries: readonly LogEntry[]): Item[] {
  let state = folds.get(sessionId);
  if (!state || state.applied > entries.length) {
    state = { applied: 0, items: [], tools: new Map(), draftFrom: null };
    folds.set(sessionId, state);
  }
  for (; state.applied < entries.length; state.applied++) {
    try {
      apply(state, JSON.parse(entries[state.applied].message));
    } catch {
    }
  }
  return state.items;
}

function apply(state: FoldState, message: any) {
  switch (message.type) {
    case "stream_event": {
      if (message.parent_tool_use_id !== null) break;
      const event = message.event as {
        type: string;
        content_block?: Block;
        delta?: { type: string; text?: string };
      };
      if (event.type === "content_block_start" && event.content_block?.type === "text") {
        state.draftFrom ??= state.items.length;
        state.items.push({ kind: "assistant", text: "" });
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const last = state.items[state.items.length - 1];
        if (last?.kind === "assistant") {
          // fresh object so memoized message rows see the change by identity
          state.items[state.items.length - 1] = {
            ...last,
            text: last.text + (event.delta.text ?? ""),
          };
        }
      }
      break;
    }
    case "assistant": {
      const inSubagent = message.parent_tool_use_id !== null;
      if (!inSubagent && state.draftFrom !== null) {
        state.items.splice(state.draftFrom);
        state.draftFrom = null;
      }
      for (const block of message.message.content as Block[]) {
        if (block.type === "text" && block.text && !inSubagent) {
          state.items.push({ kind: "assistant", text: block.text });
        }
        if (block.type === "tool_use" && block.id && block.name) {
          const input = block.input ?? {};
          const call: ToolCall = {
            id: block.id,
            name: block.name,
            detail: detail(input),
            input,
            status: "running",
            kids: [],
          };
          state.tools.set(call.id, call);
          const parent = message.parent_tool_use_id
            ? state.tools.get(message.parent_tool_use_id)
            : undefined;
          if (parent) parent.kids.push(call);
          else state.items.push({ kind: "tool", call });
        }
      }
      break;
    }
    case "user": {
      const content = message.message?.content;
      if (typeof content === "string") {
        state.items.push({ kind: "user", text: content });
        break;
      }
      if (!Array.isArray(content)) break;
      const texts: string[] = [];
      const images: string[] = [];
      let marks: { offset: number; data: string }[] | undefined;
      for (const block of content as Block[]) {
        if (block.type === "text" && block.text) texts.push(block.text);
        if (block.type === "image_path" && block.path) images.push(block.path);
        if (block.type === "rich_text" && typeof block.text === "string") {
          texts.push(block.text);
          marks = block.marks;
          for (const mark of block.marks ?? []) {
            try {
              const data = JSON.parse(mark.data);
              if (data.kind === "image" && data.path) images.push(data.path);
            } catch {
              continue;
            }
          }
        }
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const call = state.tools.get(block.tool_use_id);
        if (call) {
          call.status = block.is_error ? "error" : "ok";
          call.result = message.tool_use_result;
        }
      }
      if (texts.length || images.length) {
        state.items.push({
          kind: "user",
          text: texts.join("\n"),
          images: images.length ? images : undefined,
          marks,
        });
      }
      break;
    }
    case "result":
      if (message.subtype !== "success") {
        state.items.push({ kind: "assistant", text: `error: ${message.subtype}` });
      }
      break;
    case "app_error":
      state.items.push({ kind: "assistant", text: `error: ${message.text}` });
      break;
  }
}
