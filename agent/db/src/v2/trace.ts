import * as Effect from "effect/Effect";

/**
 * No-op trace helpers preserved for ergonomic call-site shape inside kyju
 * internals. Historically wrapped operations in a boot-trace span; now just
 * runs `fn`/the passed Effect verbatim with zero observability overhead.
 */

export const traceKyju = <R, E, A>(
  _name: string,
  eff: Effect.Effect<A, E, R>,
  _meta?: Record<string, unknown>,
): Effect.Effect<A, E, R> => eff;

export const traceKyjuSync = <A>(
  _name: string,
  fn: () => A,
  _meta?: Record<string, unknown>,
): A => fn();
