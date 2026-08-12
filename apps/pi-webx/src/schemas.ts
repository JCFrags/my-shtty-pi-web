import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;
const id = () => Type.String({ minLength: 1, maxLength: 256 });
const address = {
  browserSessionId: Type.Optional(id()),
  tabId: Type.Optional(id()),
};
const target = {
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
};
const binding = {
  observationId: id(),
  viewportId: id(),
};
const point = {
  ...binding,
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  coordinateSpace: Type.Optional(StringEnum(["viewport", "image"] as const)),
};

export const WebUpgradeSchema = Type.Object({
  mode: StringEnum(["browser", "debug"] as const),
}, strict);

export const WebSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8192 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 32 })),
  freshness: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
}, strict);

export const WebResearchSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 8192 }),
  mode: Type.Optional(StringEnum(["quick", "research", "deep"] as const)),
  maxQueries: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
  maxPages: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 16_777_216 })),
  resume: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), Type.Unknown(), { maxProperties: 64 })),
}, strict);

export const WebRecallSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8192 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeHistory: Type.Optional(Type.Boolean()),
}, strict);

export const WebRecallGetSchema = Type.Object({
  versionId: id(),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
}, strict);

export const WebRecallForgetSchema = Type.Union([
  Type.Object({ versionId: id() }, strict),
  Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }) }, strict),
]);

export const WebReadSchema = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  ...address,
  query: Type.Optional(Type.String({ maxLength: 8192 })),
  view: Type.Optional(StringEnum(["main", "outline", "raw"] as const)),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
}, strict);

export const BrowserOpenSchema = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  pathId: Type.Optional(StringEnum(["agent-browser/chrome", "pinchtab/chrome"] as const)),
  visible: Type.Optional(Type.Boolean()),
  newTab: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String({ maxLength: 256 })),
}, strict);

export const BrowserTabsSchema = Type.Object({
  action: StringEnum(["list", "discard-tab", "restore-tab", "close-tab", "close-session"] as const),
  ...address,
}, strict);

export const BrowserObserveSchema = Type.Object({
  ...address,
  view: Type.Optional(StringEnum(["main", "interactive", "visual", "hybrid", "adaptive", "full", "diff"] as const)),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  includeBounds: Type.Optional(Type.Boolean()),
}, strict);

const pointerButton = Type.Optional(StringEnum(["left", "right", "middle"] as const));
const action = Type.Union([
  Type.Object({ kind: Type.Literal("navigate"), url: Type.String({ minLength: 1, maxLength: 8192 }) }, strict),
  Type.Object({ kind: Type.Literal("click"), ...target }, strict),
  Type.Object({ kind: Type.Literal("fill"), ...target, text: Type.String({ maxLength: 100_000 }) }, strict),
  Type.Object({ kind: Type.Literal("type"), ...target, text: Type.String({ maxLength: 100_000 }) }, strict),
  Type.Object({ kind: Type.Literal("press"), key: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
  Type.Object({ kind: Type.Literal("select"), ...target, values: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 100 }) }, strict),
  Type.Object({ kind: Type.Literal("hover"), ...target }, strict),
  Type.Object({ kind: Type.Literal("scroll"), direction: StringEnum(["up", "down", "left", "right"] as const), amount: Type.Optional(Type.Number()) }, strict),
  Type.Object({ kind: Type.Literal("drag"), ref: id(), targetRef: id() }, strict),
  Type.Object({ kind: Type.Literal("mouse-move"), ...point }, strict),
  Type.Object({ kind: StringEnum(["mouse-down", "mouse-up", "mouse-click", "mouse-double-click"] as const), ...point, button: pointerButton }, strict),
  Type.Object({ kind: Type.Literal("mouse-wheel"), ...point, deltaX: Type.Number(), deltaY: Type.Number() }, strict),
  Type.Object({ kind: Type.Literal("coordinate-drag"), ...binding, startX: Type.Number({ minimum: 0 }), startY: Type.Number({ minimum: 0 }), endX: Type.Number({ minimum: 0 }), endY: Type.Number({ minimum: 0 }), coordinateSpace: Type.Optional(StringEnum(["viewport", "image"] as const)), button: pointerButton }, strict),
  Type.Object({ kind: StringEnum(["key-press", "key-down", "key-up"] as const), ...binding, key: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
  Type.Object({ kind: Type.Literal("text-input"), ...binding, text: Type.String({ maxLength: 100_000 }) }, strict),
  Type.Object({ kind: Type.Literal("download"), ...target }, strict),
  Type.Object({ kind: StringEnum(["back", "forward", "reload"] as const) }, strict),
  Type.Object({ kind: Type.Literal("wait"), milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })), selector: Type.Optional(Type.String({ maxLength: 4096 })), text: Type.Optional(Type.String({ maxLength: 4096 })) }, strict),
  Type.Object({ kind: Type.Literal("tab-new"), url: Type.Optional(Type.String({ maxLength: 8192 })) }, strict),
  Type.Object({ kind: Type.Literal("tab-close"), tabId: Type.Optional(id()) }, strict),
  Type.Object({ kind: Type.Literal("tab-focus"), tabId: id() }, strict),
]);

export const BrowserActSchema = Type.Object({
  ...address,
  action,
  feedback: Type.Optional(StringEnum(["none", "delta", "visual", "hybrid"] as const)),
}, strict);

export const BrowserDebugSchema = Type.Object({
  ...address,
  operation: StringEnum(["evaluate", "console", "network", "html", "cookies", "storage", "pdf", "record-start", "record-stop"] as const),
  args: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), Type.Unknown(), { maxProperties: 64 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000_000 })),
}, strict);

export const ArtifactReadSchema = Type.Union([
  Type.Object({
    artifactId: id(),
    mode: Type.Optional(Type.Literal("default")),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_194_304 })),
  }, strict),
  Type.Object({
    artifactId: id(),
    mode: Type.Literal("raw"),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
  }, strict),
]);
