import type { KeyOp } from "../protocol.js";
import { clamp } from "../path-engine/geometry.js";
import { createRng, type Rng } from "../path-engine/rng.js";
import { buildTypingSchedule } from "./typing.js";

export type { KeyOp } from "../protocol.js";

/**
 * One person's stable motor + typing signature. Sampled once from the seed;
 * every action reads these so a whole session reads as the same person.
 */
export interface PersonaTraits {
  /** move-duration divisor: >1 faster, <1 slower */
  speedFactor: number;
  /** Bézier bow scale */
  curviness: number;
  /** hand-tremor amplitude, px */
  jitterPx: number;
  /** chance of an overshoot-and-correct on a long move */
  overshootProb: number;
  /** overshoot distance as a fraction of travel */
  overshootMag: number;
  /** off-center click spread as a fraction of the target */
  precision: number;
  /** pre-click dwell multiplier */
  dwellScale: number;
  /** button-hold multiplier */
  pressScale: number;
  /** typing speed, words per minute */
  wpm: number;
  /** per-character typo probability */
  errorRate: number;
  /** base reaction delay, ms */
  reactionMs: number;
  /** think-time multiplier */
  thinkScale: number;
  /** reading pause per visible character, ms */
  readMsPerChar: number;
  /** curvature side bias, -1 or +1 */
  handedness: number;
}

export interface PersonaInfo {
  seed: number;
  traits: PersonaTraits;
  actionCount: number;
  fatigue: number;
}

const FATIGUE_FULL_MS = 20 * 60_000;
const FATIGUE_MAX = 0.15;

export interface PersonaOptions {
  seed?: number;
  /** injectable clock (ms) so tests can drive fatigue deterministically */
  now?: () => number;
}

export class Persona {
  readonly seed: number;
  readonly rng: Rng;
  readonly base: PersonaTraits;
  private actions = 0;
  private readonly startMs: number;
  private readonly clock: () => number;

  constructor(opts: PersonaOptions = {}) {
    this.seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.rng = createRng(this.seed);
    this.clock = opts.now ?? (() => Date.now());
    this.startMs = this.clock();
    this.base = sampleTraits(this.rng);
  }

  /** Advance fatigue bookkeeping; call once per action. */
  tick(): void {
    this.actions++;
  }

  /** 0..FATIGUE_MAX, grows with elapsed session time. */
  get fatigue(): number {
    return clamp((this.clock() - this.startMs) / FATIGUE_FULL_MS, 0, 1) * FATIGUE_MAX;
  }

  /** Traits after fatigue drift (slower, shakier, more hesitant over time). */
  traits(): PersonaTraits {
    const f = this.fatigue;
    return {
      ...this.base,
      speedFactor: this.base.speedFactor * (1 - f),
      jitterPx: this.base.jitterPx * (1 + 0.4 * f),
      thinkScale: this.base.thinkScale * (1 + 0.5 * f),
    };
  }

  info(): PersonaInfo {
    return { seed: this.seed, traits: this.traits(), actionCount: this.actions, fatigue: this.fatigue };
  }

  /** Cognitive delay before an action; `distancePx` is the cursor travel. */
  thinkTimeMs(distancePx = 0): number {
    const t = this.traits();
    const reaction = t.reactionMs * this.rng.range(0.7, 1.3);
    const decide = Math.min(distancePx, 1200) * 0.06 * this.rng.range(0.5, 1.5);
    return Math.round((reaction + decide) * t.thinkScale);
  }

  /** Pause to "read" `chars` of freshly surfaced text, capped. */
  readPauseMs(chars: number): number {
    const t = this.traits();
    const raw = Math.min(chars, 600) * t.readMsPerChar * this.rng.range(0.6, 1.4);
    return Math.round(clamp(raw, 120, 4000));
  }

  keySchedule(text: string): KeyOp[] {
    const t = this.traits();
    return buildTypingSchedule(text, this.rng, {
      wpm: t.wpm,
      errorRate: t.errorRate,
      reactionMs: t.reactionMs,
    });
  }
}

export function createPersona(seed?: number, opts: Omit<PersonaOptions, "seed"> = {}): Persona {
  return new Persona(seed === undefined ? opts : { seed, ...opts });
}

function sampleTraits(rng: Rng): PersonaTraits {
  return {
    speedFactor: rng.range(0.75, 1.35),
    curviness: rng.range(0.6, 1.5),
    jitterPx: rng.range(0.7, 2.2),
    overshootProb: rng.range(0.25, 0.7),
    overshootMag: rng.range(0.08, 0.16),
    precision: rng.range(0.1, 0.26),
    dwellScale: rng.range(0.7, 1.5),
    pressScale: rng.range(0.75, 1.4),
    wpm: rng.range(180, 420),
    errorRate: rng.range(0, 0.05),
    reactionMs: rng.range(180, 520),
    thinkScale: rng.range(0.7, 1.5),
    readMsPerChar: rng.range(8, 22),
    handedness: rng.bool(0.5) ? 1 : -1,
  };
}
