export interface Rng {
  /** uniform in [0, 1) */
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  gaussian(mean?: number, std?: number): number;
  /** right-skewed value in [min, max]; higher power = stronger skew toward min */
  skewed(min: number, max: number, power?: number): number;
  bool(p: number): boolean;
}

/**
 * Seedable mulberry32 PRNG. A seed exists only so tests can assert
 * determinism; production calls omit it and draw fresh entropy each move.
 */
export function createRng(seed?: number): Rng {
  let state = (seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + (max - min) * next();
  const int = (min: number, max: number): number =>
    Math.floor(range(min, max + 1));

  const gaussian = (mean = 0, std = 1): number => {
    const u = 1 - next();
    const v = next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const skewed = (min: number, max: number, power = 2.2): number =>
    min + (max - min) * Math.pow(next(), power);

  const bool = (p: number): boolean => next() < p;

  return { next, range, int, gaussian, skewed, bool };
}
