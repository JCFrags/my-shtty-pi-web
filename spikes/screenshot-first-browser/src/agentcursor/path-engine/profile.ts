import { clamp, smootherstep } from "./geometry.js";
import type { Rng } from "./rng.js";

/** Fitts's law (Shannon form): duration grows with the index of difficulty.
 * `speedFactor` > 1 is a faster hand, < 1 slower (persona trait; default 1). */
export function fittsDurationMs(
  dist: number,
  targetWidth: number,
  rng: Rng,
  speedFactor = 1,
): number {
  const a = rng.range(70, 130);
  const b = rng.range(80, 150);
  const id = Math.log2(dist / Math.max(targetWidth, 6) + 1);
  return Math.max(90, (a + b * id) / speedFactor);
}

export function stepCount(durationMs: number, rng: Rng): number {
  return Math.round(clamp(durationMs / rng.range(14, 20), 8, 140));
}

/**
 * Map normalized time -> normalized distance with a smootherstep eased by a
 * per-move skew exponent, so peak velocity is not pinned to the midpoint.
 */
export function easeParam(timeFraction: number, skew: number): number {
  return Math.pow(smootherstep(timeFraction), skew);
}
