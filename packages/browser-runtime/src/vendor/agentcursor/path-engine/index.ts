import type { CursorSample, Point, Rect } from "../protocol.js";
import { clamp, cubicBezier, distance } from "./geometry.js";
import { easeParam, fittsDurationMs, stepCount } from "./profile.js";
import { createRng, type Rng } from "./rng.js";

export { createRng } from "./rng.js";
export type { Rng } from "./rng.js";

export interface MoveOptions {
  rng?: Rng;
  /** approximate target size, feeds Fitts duration; default 24 */
  targetWidth?: number;
  /** allow overshoot-and-correct on long moves; default true */
  overshoot?: boolean;
  /** persona: move-duration divisor; default 1 */
  speedFactor?: number;
  /** persona: Bézier bow scale; default 1 */
  curviness?: number;
  /** persona: Gaussian jitter amplitude in px; default 1.4 */
  jitterPx?: number;
  /** persona: overshoot chance on a long move; default 0.5 */
  overshootProb?: number;
  /** persona: overshoot distance as fraction of travel; default 0.12 */
  overshootMag?: number;
  /** persona: -1/+1 curvature side bias; 0 = unbiased (default) */
  handedness?: number;
}

const OVERSHOOT_MIN_DISTANCE = 180;

export function generateMove(
  from: Point,
  to: Point,
  options: MoveOptions = {},
): CursorSample[] {
  const rng = options.rng ?? createRng();
  const targetWidth = options.targetWidth ?? 24;
  const allowOvershoot = options.overshoot ?? true;
  const seg: SegmentOptions = {
    targetWidth,
    correction: false,
    speedFactor: options.speedFactor ?? 1,
    curviness: options.curviness ?? 1,
    jitterAmp: options.jitterPx ?? 1.4,
    handedness: options.handedness ?? 0,
  };
  const total = distance(from, to);

  const legs: Array<{ a: Point; b: Point; correction: boolean }> = [];
  if (
    allowOvershoot &&
    total > OVERSHOOT_MIN_DISTANCE &&
    rng.bool(options.overshootProb ?? 0.5)
  ) {
    const past = overshootPoint(from, to, rng, options.overshootMag ?? 0.12);
    legs.push({ a: from, b: past, correction: false });
    legs.push({ a: past, b: to, correction: true });
  } else {
    legs.push({ a: from, b: to, correction: false });
  }

  const samples: CursorSample[] = [];
  let tOffset = 0;
  for (const leg of legs) {
    const seg2 = { ...seg, correction: leg.correction };
    for (const s of buildSegment(leg.a, leg.b, rng, seg2)) {
      samples.push({ x: s.x, y: s.y, t: s.t + tOffset });
    }
    const last = samples.at(-1);
    tOffset = (last?.t ?? tOffset) + rng.range(12, 45);
  }

  return monotonic(samples);
}

interface SegmentOptions {
  targetWidth: number;
  jitterAmp: number;
  correction: boolean;
  speedFactor: number;
  curviness: number;
  handedness: number;
}

function buildSegment(
  a: Point,
  b: Point,
  rng: Rng,
  opts: SegmentOptions,
): CursorSample[] {
  const dist = distance(a, b);
  const baseDuration = fittsDurationMs(
    dist,
    opts.correction ? Math.max(opts.targetWidth, 12) : opts.targetWidth,
    rng,
    opts.speedFactor,
  );
  const duration = baseDuration * (opts.correction ? 0.55 : 1);
  const steps = stepCount(duration, rng);
  const skew = rng.range(0.85, 1.18);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const nx = -dy / len;
  const ny = dx / len;
  const side =
    opts.handedness !== 0
      ? (rng.bool(0.75) ? 1 : -1) * Math.sign(opts.handedness)
      : rng.bool(0.5)
        ? 1
        : -1;
  const bow = side * rng.range(dist * 0.04, dist * 0.16) * opts.curviness;
  const c1: Point = {
    x: a.x + dx * 0.3 + nx * bow * rng.range(0.7, 1.0),
    y: a.y + dy * 0.3 + ny * bow * rng.range(0.7, 1.0),
  };
  const c2: Point = {
    x: a.x + dx * 0.68 + nx * bow * rng.range(0.6, 1.0),
    y: a.y + dy * 0.68 + ny * bow * rng.range(0.6, 1.0),
  };

  const out: CursorSample[] = [];
  let tAcc = 0;
  for (let i = 0; i <= steps; i++) {
    const tf = i / steps;
    const point = cubicBezier(a, c1, c2, b, easeParam(tf, skew));
    const envelope = Math.sin(Math.PI * tf);
    if (i > 0) tAcc += (duration / steps) * rng.range(0.7, 1.3);
    out.push({
      x: point.x + rng.gaussian(0, opts.jitterAmp) * envelope,
      y: point.y + rng.gaussian(0, opts.jitterAmp) * envelope,
      t: tAcc,
    });
  }

  out[0] = { x: a.x, y: a.y, t: 0 };
  out[out.length - 1] = { x: b.x, y: b.y, t: tAcc };
  return out;
}

function overshootPoint(from: Point, to: Point, rng: Rng, mag: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const ux = dx / len;
  const uy = dy / len;
  const over = Math.min(len * mag, 110) * rng.range(0.5, 1.1);
  const perp = rng.gaussian(0, 8);
  return { x: to.x + ux * over - uy * perp, y: to.y + uy * over + ux * perp };
}

function monotonic(samples: CursorSample[]): CursorSample[] {
  const out: CursorSample[] = [];
  let lastT = -1;
  for (const s of samples) {
    const t = s.t <= lastT ? lastT + 1 : s.t;
    out.push({ x: s.x, y: s.y, t });
    lastT = t;
  }
  return out;
}

/** A point inside the rect, offset from dead-center (humans miss the middle).
 * `precision` is the spread as a fraction of the target; smaller = tighter. */
export function offCenterPoint(rect: Rect, rng: Rng = createRng(), precision = 0.18): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const ox = clamp(
    rng.gaussian(0, rect.width * precision),
    -rect.width * 0.4,
    rect.width * 0.4,
  );
  const oy = clamp(
    rng.gaussian(0, rect.height * precision),
    -rect.height * 0.4,
    rect.height * 0.4,
  );
  return { x: cx + ox, y: cy + oy };
}

export function sampleDwellMs(rng: Rng = createRng(), dwellScale = 1): number {
  return Math.round(clamp(rng.skewed(60, 300, 2.0) * dwellScale, 40, 520));
}

export function samplePressMs(rng: Rng = createRng(), pressScale = 1): number {
  return Math.round(rng.skewed(45, 130, 1.8) * pressScale);
}

export function sampleKeyDelayMs(rng: Rng = createRng()): {
  min: number;
  max: number;
} {
  const base = rng.range(55, 110);
  return { min: Math.round(base * 0.6), max: Math.round(base * 1.8) };
}
