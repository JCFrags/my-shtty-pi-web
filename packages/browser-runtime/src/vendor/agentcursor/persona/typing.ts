/* eslint-disable @typescript-eslint/no-non-null-assertion -- selectively ported upstream source */
import type { KeyOp } from "../protocol.js";
import type { Rng } from "../path-engine/rng.js";

/** Traits the typing scheduler reads (subset of PersonaTraits). */
export interface TypingTraits {
  wpm: number;
  errorRate: number;
  reactionMs: number;
}

// QWERTY neighbours, for picking a plausible wrong key on a typo.
const NEIGHBORS: Record<string, string> = {
  a: "sqwz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop",
  m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

function wrongChar(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase();
  const opts = NEIGHBORS[lower];
  if (!opts) return null;
  const pick = opts[rng.int(0, opts.length - 1)]!;
  return ch === lower ? pick : pick.toUpperCase();
}

/**
 * Turn text into a human keystroke schedule: burst timing, longer pauses at word
 * and sentence boundaries, a slower first key (reaction), and occasional typos
 * that are immediately backspaced and corrected. Invariant: flattenSchedule of
 * the result equals `text`.
 */
export function buildTypingSchedule(
  text: string,
  rng: Rng,
  traits: TypingTraits,
): KeyOp[] {
  const base = 12000 / traits.wpm; // ms per character (wpm * 5 chars/word)
  const ops: KeyOp[] = [];
  let first = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = text[i - 1];

    let delay = Math.max(8, rng.gaussian(base, base * 0.35));
    if (first) {
      delay += traits.reactionMs * rng.range(0.6, 1.1);
      first = false;
    } else if (prev === " ") {
      delay += base * rng.range(1.5, 3.5); // word boundary
    } else if (prev && ".?!".includes(prev)) {
      delay += base * rng.range(3, 6); // sentence boundary
    } else if (rng.bool(0.06)) {
      delay += base * rng.range(2, 5); // occasional mid-word think pause
    }

    if (/[a-zA-Z]/.test(ch) && rng.bool(traits.errorRate)) {
      const wrong = wrongChar(ch, rng);
      if (wrong) {
        ops.push({ t: "key", ch: wrong, delayMs: Math.round(delay) });
        ops.push({ t: "back", delayMs: Math.round(base * rng.range(2, 5)) });
        ops.push({ t: "key", ch, delayMs: Math.round(base * rng.range(0.8, 1.4)) });
        continue;
      }
    }
    ops.push({ t: "key", ch, delayMs: Math.round(delay) });
  }

  return ops;
}

/** Net text after applying every insert/backspace — what the field ends up with. */
export function flattenSchedule(ops: KeyOp[]): string {
  let out = "";
  for (const op of ops) {
    if (op.t === "key") out += op.ch;
    else out = out.slice(0, -1);
  }
  return out;
}

/**
 * Reduce a schedule to only the keystrokes that survive its backspaces, each
 * carrying a delay. For drivers that can't render a live backspace (nut-js OS
 * typing), so they still get persona timing on the final text without typos.
 */
export function scheduleToKeystrokes(ops: KeyOp[]): Array<{ ch: string; delayMs: number }> {
  const stack: Array<{ ch: string; delayMs: number }> = [];
  for (const op of ops) {
    if (op.t === "key") stack.push({ ch: op.ch, delayMs: op.delayMs });
    else stack.pop();
  }
  return stack;
}
