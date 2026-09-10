export type AgentModifier = "ctrl" | "alt" | "shift" | "meta";

export interface AgentKey {
  canonical: string;
  identity: string;
  keyCode: string;
  modifiers: readonly AgentModifier[];
  character: string | null;
}

const MODIFIERS: Record<string, AgentModifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  meta: "meta",
  super: "meta",
  command: "meta",
};

const NAMED_KEYS: Record<string, { name: string; keyCode: string; character: string | null }> = {
  enter: { name: "Enter", keyCode: "return", character: "\r" },
  escape: { name: "Escape", keyCode: "escape", character: null },
  tab: { name: "Tab", keyCode: "tab", character: null },
  backspace: { name: "Backspace", keyCode: "backspace", character: null },
  delete: { name: "Delete", keyCode: "delete", character: null },
  arrowup: { name: "ArrowUp", keyCode: "up", character: null },
  arrowdown: { name: "ArrowDown", keyCode: "down", character: null },
  arrowleft: { name: "ArrowLeft", keyCode: "left", character: null },
  arrowright: { name: "ArrowRight", keyCode: "right", character: null },
  home: { name: "Home", keyCode: "home", character: null },
  end: { name: "End", keyCode: "end", character: null },
  pageup: { name: "PageUp", keyCode: "pageup", character: null },
  pagedown: { name: "PageDown", keyCode: "pagedown", character: null },
  space: { name: "Space", keyCode: "space", character: " " },
  f1: { name: "F1", keyCode: "F1", character: null },
  f2: { name: "F2", keyCode: "F2", character: null },
  f3: { name: "F3", keyCode: "F3", character: null },
  f4: { name: "F4", keyCode: "F4", character: null },
  f5: { name: "F5", keyCode: "F5", character: null },
  f6: { name: "F6", keyCode: "F6", character: null },
  f7: { name: "F7", keyCode: "F7", character: null },
  f8: { name: "F8", keyCode: "F8", character: null },
  f9: { name: "F9", keyCode: "F9", character: null },
  f10: { name: "F10", keyCode: "F10", character: null },
  f11: { name: "F11", keyCode: "F11", character: null },
  f12: { name: "F12", keyCode: "F12", character: null },
};

const MODIFIER_ORDER: AgentModifier[] = ["ctrl", "alt", "shift", "meta"];
const MODIFIER_NAMES: Record<AgentModifier, string> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

export function parseAgentKey(value: string): AgentKey {
  if (typeof value !== "string" || value.length === 0) throw new Error("key must not be empty");
  if (value.length > 128) throw new Error("key is too long");
  if (value.includes("\0")) throw new Error("key contains NUL");
  if (value === "+") return makeKey("+", "+", [], "+");

  const parts = value.split("+");
  if (parts.some((part) => part.length === 0)) throw new Error("invalid key syntax");
  const modifiers = new Set<AgentModifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error("invalid key syntax");
    if (modifiers.has(modifier)) throw new Error("duplicate key modifier");
    modifiers.add(modifier);
  }
  if (parts.length > 1 && modifiers.size === 0) throw new Error("invalid key syntax");

  const atom = parts[parts.length - 1]!;
  const modifierOnly = MODIFIERS[atom.toLowerCase()];
  if (modifierOnly) throw new Error("key must include a non-modifier key");
  const named = NAMED_KEYS[atom.toLowerCase()];
  if (named) {
    return makeKey(
      named.name,
      named.keyCode,
      orderedModifiers(modifiers),
      characterFor(named.character, modifiers),
    );
  }
  if (atom === " ") {
    return makeKey("Space", "space", orderedModifiers(modifiers), characterFor(" ", modifiers));
  }
  if ([...atom].length !== 1 || !isPrintable(atom)) throw new Error("unsupported key");
  return makeKey(atom, atom, orderedModifiers(modifiers), characterFor(atom, modifiers));
}

function makeKey(
  name: string,
  keyCode: string,
  modifiers: AgentModifier[],
  character: string | null,
): AgentKey {
  const canonical = [...modifiers.map((modifier) => MODIFIER_NAMES[modifier]), name].join("+");
  return { canonical, identity: canonical, keyCode, modifiers, character };
}

function orderedModifiers(modifiers: Set<AgentModifier>): AgentModifier[] {
  return MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
}

function characterFor(character: string | null, modifiers: Set<AgentModifier>): string | null {
  if (!character || modifiers.has("ctrl") || modifiers.has("alt") || modifiers.has("meta")) {
    return null;
  }
  return character;
}

function isPrintable(value: string): boolean {
  return !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}
