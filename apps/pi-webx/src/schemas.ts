import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;
const id = () => Type.String({ minLength: 1, maxLength: 256 });
const target = {
  ref: Type.String({ minLength: 1, maxLength: 256, description: "Current semantic element ref from the latest interactive observation." }),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Optional selector fallback for the same observed target. Prefer ref." })),
};
const binding = {
  observationId: Type.String({ minLength: 1, maxLength: 256, description: "Identifier from the latest visual observation of this session." }),
  viewportId: Type.String({ minLength: 1, maxLength: 256, description: "Viewport identifier paired with the latest visual observation." }),
};
const point = {
  ...binding,
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  coordinateSpace: Type.Optional(StringEnum(["viewport", "image"] as const)),
};

export const WebSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8192, description: "Complete search query. Include time terms such as latest, today, or a year when recency matters." }),
  output: Type.Optional(StringEnum(["links", "extracts"] as const, { description: "Result form. Omit for ranked links with search snippets. Use extracts for short query-focused passages read from selected pages." })),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", description: "Strict allowed host name, such as docs.python.org. Do not pass a URL, path, or site: prefix." }), { maxItems: 32, description: "Optional strict allowed hosts. Every returned URL must match one of these hosts or its subdomains." })),
}, strict);

export const WebReadSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://", description: "Exact public HTTP(S) URL to read. Use web_search first when the URL is unknown." }),
  query: Type.Optional(Type.String({ maxLength: 8192, description: "Optional topic or section selector. Omit for the complete extracted main content." })),
  view: Type.Optional(StringEnum(["main", "outline", "raw"] as const, { description: "Extraction view. main is the readable default; outline returns structure; raw preserves source-oriented text." })),
  fields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, description: "JSON property name or dotted field path." }), { maxItems: 32, description: "Structured JSON projection. Each returned collection item remains one complete object with these fields." })),
  itemOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Zero-based item offset for a structured JSON collection. Reuse the same URL and fields." })),
  itemLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum structured JSON collection items. Use with itemOffset for item pagination." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Explicit content bound. Omit for a full read. If it binds the result, use the reported nextContentOffset." })),
  contentOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000, description: "Continuation offset reported by a prior direct read. Keep the same URL and options. Do not invent this value or combine it with linked crawling." })),
  maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum linked pages to read. Default: 1. Set above 1 only when linked sources are explicitly needed." })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Maximum link-following depth. Default: 0. Any positive value enables linked crawling." })),
  sameDomain: Type.Optional(Type.Boolean({ description: "Keep linked crawling on the starting domain. Default: true. Set false only when cited external primary sources are required." })),
  save: Type.Optional(Type.Object({
    path: Type.String({ minLength: 3, maxLength: 4096, pattern: "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\).+\\.[mM][dD]$", description: "Relative .md path below the private WebX export directory. WebX returns the absolute saved path." }),
    overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing file atomically. Default: false. Set true only when replacement is intended." })),
  }, { ...strict, description: "Save one extracted page as UTF-8 Markdown and return compact file metadata instead of the body. Not compatible with structured JSON projection or linked crawling." })),
}, strict);

const contentBase = {
  contentId: Type.String({ minLength: 36, maxLength: 36, pattern: "^cnt_[A-Za-z0-9_-]{32}$", description: "Opaque content ID returned by web_read or web_content." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30_000, description: "Maximum normalized-content characters to return. Default: 30000." })),
};

export const WebContentSchema = Type.Union([
  Type.Object({ ...contentBase, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000, description: "Exact character offset in the stored normalized content. Default: 0." })) }, strict),
  Type.Object({ ...contentBase, findText: Type.String({ minLength: 1, maxLength: 8192, description: "Exact case-insensitive text to locate. Returns bounded context around the match." }) }, strict),
  Type.Object({ ...contentBase, query: Type.String({ minLength: 1, maxLength: 8192, description: "Topic query for a bounded focused passage from the stored content." }) }, strict),
], { description: "Retrieve normalized content by opaque ID without a network request. Exact offset mode and focused findText or query mode are mutually exclusive." });

export const BrowserOpenSchema = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://", description: "Optional initial public HTTP(S) URL. Omit to open a blank owned session." })),
  pathId: Type.Optional(StringEnum(["agent-browser/chrome", "pinchtab/chrome"] as const, { description: "Browser path. Omit for the required agent-browser/chrome default. Use pinchtab/chrome only when capabilities report it." })),
  visible: Type.Optional(Type.Boolean({ description: "Request a visible browser window for human observation or takeover. Omit unless visibility is useful." })),
  label: Type.Optional(Type.String({ maxLength: 256, description: "Short human-readable session label." })),
}, strict);

export const BrowserTabsSchema = Type.Union([
  Type.Object({ action: Type.Literal("list", { description: "List this agent's owned sessions and tabs." }) }, strict),
  Type.Object({ action: Type.Literal("close-session", { description: "Close one complete owned session." }), browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier." }) }, strict),
  Type.Object({ action: Type.Literal("close-tab", { description: "Close one owned tab." }), browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier." }), tabId: Type.String({ minLength: 1, maxLength: 256, description: "Owned tab identifier." }) }, strict),
], { description: "List owned browser state or close one tab or session. Identifiers are required for close actions." });

export const BrowserObserveSchema = Type.Object({
  browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier returned by browser_open or browser_tabs list." }),
  view: Type.Optional(StringEnum(["main", "interactive", "visual", "full", "diff"] as const, { description: "Observation form: interactive for semantic refs; main for compact text; visual for screenshot-bound pixels; full for more DOM; diff after a state change." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Explicit text bound. Omit for the normal view default." })),
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
  Type.Object({ kind: StringEnum(["back", "forward", "reload"] as const) }, strict),
  Type.Object({ kind: Type.Literal("wait"), milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })), selector: Type.Optional(Type.String({ maxLength: 4096 })), text: Type.Optional(Type.String({ maxLength: 4096 })) }, strict),
]);

export const BrowserActSchema = Type.Object({
  browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier from browser_open or browser_tabs list." }),
  action: Type.Unsafe({ ...action, description: "One smallest suitable action. Semantic ref/selector actions use current interactive evidence. Coordinate actions require the latest observationId and viewportId." }),
}, strict);

export const BrowserDebugSchema = Type.Object({
  browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier." }),
  operation: StringEnum(["console", "network", "html", "pdf", "record-start", "record-stop"] as const, { description: "Bounded diagnostic operation. Secret-bearing cookie, storage, and arbitrary evaluation operations are not exposed." }),
  args: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), Type.Unknown(), { maxProperties: 64, description: "Operation-specific diagnostic arguments. Keep them minimal." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000_000, description: "Hard diagnostic output bound. Use the smallest value that can explain the failure." })),
}, strict);
