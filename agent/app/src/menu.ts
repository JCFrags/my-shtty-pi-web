import { setKeyCapture } from "pixel-react";
import type { CaretInfo, ChangeInfo, EngineKeyEvent, NodeHandle } from "pixel-react";

import { fileEntries, refreshFiles } from "./files";
import { store } from "./session";

export interface TriggerItem {
  value: string;
  label: string;
  hint?: string;
  insert: string;
}

export interface TriggerSource {
  trigger: string;
  canStart(text: string, at: number): boolean;
  load(): void;
  loading(): boolean;
  items(query: string): TriggerItem[];
}

// While a menu is open these plain keys skip the input (Enter must not
// submit); ctrl+n / ctrl+p already pass through the input unhandled.
const CAPTURED_KEYS = ["up", "down", "enter", "tab", "escape"];

const MAX_ITEMS = 50;

// `start` is the caret position right after the trigger char, in UTF-16
// units (engine offsets are UTF-8 bytes and get converted on arrival).
type MenuState =
  | { kind: "idle" }
  | { kind: "active"; source: TriggerSource; start: number; query: string; at: number }
  // Query has no matches; quietly keeps tracking so backspacing a typo reopens.
  | { kind: "hidden"; source: TriggerSource; start: number }
  // Escape; stays closed until the caret leaves the trigger region.
  | { kind: "dismissed"; source: TriggerSource; start: number };

function toCharIndex(text: string, byte: number): number {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    if (bytes >= byte) break;
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += ch.length;
  }
  return i;
}

function toByteIndex(text: string, char: number): number {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    if (i >= char) break;
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += ch.length;
  }
  return bytes;
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi += 1;
      streak += 1;
      score += streak;
      if (ti === 0 || "/-_. ".includes(t[ti - 1])) score += 4;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return null;
  return score - t.length * 0.01;
}

export function rankMatches<T>(query: string, all: T[], keyOf: (item: T) => string): T[] {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of all) {
    const score = fuzzyScore(query, keyOf(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_ITEMS).map((s) => s.item);
}

const slashSource: TriggerSource = {
  trigger: "/",
  canStart: (_text, at) => at === 0,
  load: () => store.active().loadCommands(),
  loading: () => store.active().commands() === null,
  items: (query) =>
    rankMatches(query, store.active().commands() ?? [], (c) => c.name).map((c) => ({
      value: c.name,
      label: `/${c.name}`,
      hint: c.description || c.argumentHint,
      insert: `/${c.name} `,
    })),
};

const fileSource: TriggerSource = {
  trigger: "@",
  canStart: (text, at) => at === 0 || /\s/.test(text[at - 1]),
  load: () => refreshFiles(store.notify),
  loading: () => fileEntries() === null,
  items: (query) =>
    rankMatches(query, fileEntries() ?? [], (path) => path).map((path) => ({
      value: path,
      label: path,
      insert: `@${path} `,
    })),
};

export class TriggerMenus {
  input: NodeHandle | null = null;

  private state: MenuState = { kind: "idle" };
  private text = "";
  private cursor = 0;
  private anchor: CaretInfo | null = null;

  constructor(private sources: TriggerSource[]) {}

  onChange(text: string, change: ChangeInfo) {
    this.text = text;
    this.cursor = toCharIndex(text, change.cursor);
    if (this.state.kind !== "idle") {
      this.retarget();
    }
    if (this.state.kind === "idle" && change.source === "type") {
      const trigger = this.cursor > 0 ? text[this.cursor - 1] : "";
      const source = this.sources.find((s) => s.trigger === trigger);
      if (source?.canStart(text, this.cursor - 1)) {
        source.load();
        this.anchor = change;
        this.setState({ kind: "active", source, start: this.cursor, query: "", at: 0 });
      }
    }
    store.notify();
  }

  onCaret(caret: CaretInfo) {
    this.cursor = toCharIndex(this.text, caret.cursor);
    if (this.state.kind === "idle") return;
    this.retarget();
    store.notify();
  }

  /** Returns true when the key drove the menu and must not reach anything else. */
  handleKey(event: EngineKeyEvent): boolean {
    if (this.state.kind !== "active") return false;
    const ctrl = (letter: string) =>
      event.mods.ctrl && !event.mods.super && !event.mods.alt && event.key === letter;
    const plain = (name: string) =>
      !event.mods.ctrl && !event.mods.super && !event.mods.alt && event.key === name;
    if (plain("escape")) {
      this.setState({ kind: "dismissed", source: this.state.source, start: this.state.start });
      store.notify();
      return true;
    }
    const items = this.state.source.items(this.state.query);
    if (items.length === 0) return plain("up") || plain("down") || plain("enter") || plain("tab");
    if (plain("up") || ctrl("p")) return this.move(-1, items.length);
    if (plain("down") || ctrl("n")) return this.move(1, items.length);
    if (plain("enter") || plain("tab")) {
      this.accept(items[Math.min(this.state.at, items.length - 1)]);
      return true;
    }
    return false;
  }

  accept(item: TriggerItem) {
    if (this.state.kind !== "active") return;
    const from = toByteIndex(this.text, this.state.start - 1);
    const to = toByteIndex(this.text, Math.max(this.cursor, this.state.start));
    this.setState({ kind: "idle" });
    this.input?.splice(from, to, item.insert);
    store.notify();
  }

  reset() {
    if (this.state.kind === "idle") return;
    this.setState({ kind: "idle" });
    store.notify();
  }

  view(): { items: TriggerItem[]; at: number; anchor: CaretInfo; loading: boolean } | null {
    if (this.state.kind !== "active" || !this.anchor) return null;
    const items = this.state.source.items(this.state.query);
    if (items.length === 0) {
      if (!this.state.source.loading()) return null;
      return { items, at: 0, anchor: this.anchor, loading: true };
    }
    return {
      items,
      at: Math.min(this.state.at, items.length - 1),
      anchor: this.anchor,
      loading: false,
    };
  }

  private move(delta: number, count: number): boolean {
    if (this.state.kind !== "active") return false;
    this.state.at = (Math.min(this.state.at, count - 1) + delta + count) % count;
    store.notify();
    return true;
  }

  private retarget() {
    if (this.state.kind === "idle") return;
    const { source, start } = this.state;
    const triggerAt = start - 1;
    if (
      triggerAt < 0 ||
      this.text[triggerAt] !== source.trigger ||
      this.cursor < start ||
      /\s/.test(this.text.slice(start, this.cursor))
    ) {
      this.setState({ kind: "idle" });
      return;
    }
    if (this.state.kind === "dismissed") return;
    const query = this.text.slice(start, this.cursor);
    if (source.items(query).length === 0 && !source.loading()) {
      this.setState({ kind: "hidden", source, start });
      return;
    }
    const at = this.state.kind === "active" && this.state.query === query ? this.state.at : 0;
    this.setState({ kind: "active", source, start, query, at });
  }

  private setState(next: MenuState) {
    const wasActive = this.state.kind === "active";
    this.state = next;
    if (next.kind === "idle") this.anchor = null;
    if (next.kind === "active" && !wasActive) setKeyCapture(CAPTURED_KEYS);
    if (next.kind !== "active" && wasActive) setKeyCapture([]);
  }
}

export const menus = new TriggerMenus([slashSource, fileSource]);
