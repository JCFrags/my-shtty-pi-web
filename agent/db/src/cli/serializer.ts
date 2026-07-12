import { createHash } from "node:crypto";
import { NO_DEFAULT, getZodDefault } from "../v2/db/schema";
import type { Schema, SchemaShape } from "../v2/db/schema";

export type FieldSnapshot =
  | { kind: "data"; hasDefault: boolean; default?: any; typeHash: string }
  | { kind: "collection"; debugName?: string }
  | { kind: "blob"; debugName?: string };

export type SchemaSnapshot = {
  id: string;
  prevId: string;
  fields: Record<string, FieldSnapshot>;
};

function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function hashZodSchema(zodSchema: any): string {
  const repr = extractZodRepr(zodSchema);
  const json = stableStringify(repr);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function extractZodRepr(schema: any): any {
  if (schema === null || schema === undefined) return null;

  if (schema._zod) {
    const def = schema._zod.def;
    if (!def) return { type: "unknown" };
    return extractDefRepr(def);
  }

  if (typeof schema === "object" && "type" in schema) {
    return { type: schema.type };
  }

  return { type: "unknown" };
}

function extractDefRepr(def: any): any {
  if (!def) return { type: "unknown" };

  const type = def.type ?? def.typeName ?? "unknown";
  const repr: any = { type };

  if (def.values) repr.values = def.values;
  if (def.innerType) repr.inner = extractZodRepr(def.innerType);
  if (def.element) repr.element = extractZodRepr(def.element);
  if (def.shape) {
    repr.shape = {};
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;
    for (const [k, v] of Object.entries(shape)) {
      repr.shape[k] = extractZodRepr(v);
    }
  }
  if (def.left) repr.left = extractZodRepr(def.left);
  if (def.right) repr.right = extractZodRepr(def.right);
  if (def.options && Array.isArray(def.options)) {
    repr.options = def.options.map(extractZodRepr);
  }
  if (def.keyType) repr.keyType = extractZodRepr(def.keyType);
  if (def.valueType) repr.valueType = extractZodRepr(def.valueType);

  return repr;
}

const COLLECTION_REF_MARKER = "__kyjuCollectionRef";

export function serializeSchema(schema: Schema, id: string, prevId: string): SchemaSnapshot {
  const fields: Record<string, FieldSnapshot> = {};

  for (const [key, entry] of Object.entries(schema.shape as SchemaShape)) {
    const raw = entry as any;

    // Collection: the marker may be on the raw entry (`collection(...)` —
    // direct zod schema) or on `entry.schema` (legacy `f.collection(...)`
    // Field wrapper).
    if (raw[COLLECTION_REF_MARKER]) {
      const snap: FieldSnapshot = { kind: "collection" };
      if (raw._debugName) (snap as any).debugName = raw._debugName;
      fields[key] = snap;
      continue;
    }
    const inner = raw.schema;
    if (inner?.[COLLECTION_REF_MARKER]) {
      const snap: FieldSnapshot = { kind: "collection" };
      if (inner._debugName) (snap as any).debugName = inner._debugName;
      fields[key] = snap;
      continue;
    }

    // Blob: same — marker may be on raw entry (`blob()`) or wrapped.
    if (raw && typeof raw === "object" && raw.type === "blob") {
      fields[key] = { kind: "blob", debugName: raw.debugName };
      continue;
    }
    if (inner && typeof inner === "object" && "type" in inner && inner.type === "blob") {
      fields[key] = { kind: "blob", debugName: inner.debugName };
      continue;
    }

    // Default-bearing data field. Two paths: the legacy `f.x().default(v)`
    // wrapper exposes `_hasDefault`/`_defaultValue`; raw zod uses `ZodDefault`.
    let hasDefault: boolean;
    let defaultValue: unknown;
    if ("_hasDefault" in raw) {
      hasDefault = raw._hasDefault as boolean;
      defaultValue = raw._defaultValue !== NO_DEFAULT ? raw._defaultValue : undefined;
    } else {
      const d = getZodDefault(raw);
      hasDefault = d.hasDefault;
      defaultValue = d.value;
    }

    const snapshot: FieldSnapshot = {
      kind: "data",
      hasDefault,
      typeHash: hashZodSchema(inner ?? raw),
    };
    if (hasDefault && defaultValue !== undefined) {
      (snapshot as any).default = defaultValue;
    }
    fields[key] = snapshot;
  }

  return { id, prevId, fields };
}

export const emptySnapshot: SchemaSnapshot = {
  id: "00000000-0000-0000-0000-000000000000",
  prevId: "",
  fields: {},
};
