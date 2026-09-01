import { Type } from "../apps/pi-webx/node_modules/typebox";

/** Qualification worker needs only Pi's runtime string-enum schema helper. */
export function StringEnum(values: readonly string[], options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)), options);
}
