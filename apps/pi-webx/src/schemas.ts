import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;
const id = () => Type.String({ minLength: 1, maxLength: 256 });
const screenshotBinding = {
  observationId: Type.String({ minLength: 1, maxLength: 256, description: "Real browser observation ID from the exact screenshot used for this action." }),
  coordinateSpace: Type.Optional(StringEnum(["imagePixels", "cssViewport"] as const, { description: "Coordinate space. Omit for imagePixels because the model points into the returned image." })),
};
const imagePoint = { x: Type.Number({ minimum: 0, maximum: 32_768 }), y: Type.Number({ minimum: 0, maximum: 32_768 }) };
const domBinding = {
  domObservationId: Type.String({ minLength: 1, maxLength: 256, description: "DOM fallback observation ID from the exact explicit DOM observation." }),
  handle: Type.String({ minLength: 1, maxLength: 256, description: "Opaque handle from that DOM fallback observation." }),
};

export const WebSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8192, description: "Complete search query. Include time terms such as latest, today, or a year when recency matters." }),
  output: Type.Optional(StringEnum(["links", "extracts"] as const, { description: "Result form. Omit for ranked links. extracts is deprecated compatibility behavior; use web_search, select sources, web_read_batch, then web_content." })),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", description: "Strict allowed host name, such as docs.python.org. Do not pass a URL, path, or site: prefix." }), { maxItems: 32, description: "Optional strict allowed hosts. Every returned URL must match one of these hosts or its subdomains." })),
}, strict);

const directReadProperties = {
  url: Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://", description: "Exact public HTTP(S) URL to read. Use web_search first when the URL is unknown." }),
  query: Type.Optional(Type.String({ maxLength: 8192, description: "Optional topic or section selector. Omit for the complete extracted main content." })),
  view: Type.Optional(StringEnum(["main", "outline", "raw"] as const, { description: "Extraction view. main is the readable default; outline returns structure; raw preserves source-oriented text." })),
  fields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, description: "JSON property name or dotted field path." }), { maxItems: 32, description: "Structured JSON projection. Each returned collection item remains one complete object with these fields." })),
  itemOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Zero-based item offset for a structured JSON collection. Reuse the same URL and fields." })),
  itemLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum structured JSON collection items. Use with itemOffset for item pagination." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Explicit content bound. Omit for a full read. If it binds the result, use the reported nextContentOffset." })),
  contentOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000, description: "Continuation offset reported by a prior direct read. Keep the same URL and options. Do not invent this value or combine it with linked crawling." })),
  refresh: Type.Optional(Type.Boolean({ description: "Bypass a fresh traffic-cache hit and validate the canonical source again. Conditional validation can reuse unchanged canonical content." })),
};

const saveProperty = Type.Optional(Type.Object({
  path: Type.String({ minLength: 3, maxLength: 4096, pattern: "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\).+\\.[mM][dD]$", description: "Relative .md path below the private WebX export directory. WebX returns the absolute saved path." }),
  overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing file atomically. Default: false. Set true only when replacement is intended." })),
}, { ...strict, description: "Save one extracted page as UTF-8 Markdown and return compact file metadata instead of the body. Not compatible with structured JSON projection or linked crawling." }));

export const WebReadSchema = Type.Object({
  ...directReadProperties,
  save: saveProperty,
}, strict);

/** Compatibility schema for installations that explicitly enable linked reads. */
export const WebReadAdvancedSchema = Type.Object({
  ...directReadProperties,
  maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Advanced legacy-compatible linked crawl page limit. Default: 1." })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Advanced linked crawl depth. Default: 0." })),
  sameDomain: Type.Optional(Type.Boolean({ description: "Advanced linked crawl host control. Default: true." })),
  save: saveProperty,
}, strict);

export const WebReadBatchSchema = Type.Object({
  items: Type.Array(Type.Object(directReadProperties, strict), { minItems: 1, maxItems: 5, description: "Directly read 1 to 5 separate sources in input order with fixed maximum concurrency 3." }),
}, strict);

export const ContentProvenanceSchema = Type.Object({
  requestedUrl: Type.String({ minLength: 1, maxLength: 8192 }),
  finalUrl: Type.String({ minLength: 1, maxLength: 8192 }),
  representation: StringEnum(["canonical-normalized", "raw-projection", "structured-projection", "crawl-aggregate"] as const),
  sourceOffset: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
  sourceComplete: Type.Boolean(),
  nextSourceOffset: Type.Union([Type.Integer({ minimum: 1, maximum: 100_000_000 }), Type.Null()]),
  extractor: Type.String({ minLength: 1, maxLength: 256 }),
  mediaType: Type.String({ minLength: 1, maxLength: 256 }),
  contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  createdAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
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
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://", description: "Optional initial public HTTP(S) URL. Omit to open about:blank." })),
}, { ...strict, description: "Open the only browser path selected when webxd started. A request cannot choose or change the backend." });

export const BrowserTabsSchema = Type.Union([
  Type.Object({ action: Type.Literal("list"), browserSessionId: Type.Optional(id()) }, strict),
  Type.Object({ action: Type.Literal("create-tab"), browserSessionId: id(), url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://" })) }, strict),
  Type.Object({ action: Type.Literal("focus-tab"), browserSessionId: id(), tabId: id() }, strict),
  Type.Object({ action: Type.Literal("close-tab"), browserSessionId: id(), tabId: id() }, strict),
  Type.Object({ action: Type.Literal("close-session"), browserSessionId: id() }, strict),
], { description: "List, create, focus, and close explicit owned tabs or close the complete session." });

export const BrowserObserveSchema = Type.Object({
  browserSessionId: id(),
  tabId: id(),
  mode: Type.Optional(StringEnum(["screenshot", "dom"] as const, { description: "Screenshot is the default. Use dom only as an explicit bounded fallback." })),
  maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "DOM node bound. Valid only with mode=dom." })),
}, strict);

const pointerButton = Type.Optional(StringEnum(["left", "right", "middle"] as const));
const action = Type.Union([
  Type.Object({ kind: Type.Literal("move"), ...screenshotBinding, ...imagePoint }, strict),
  Type.Object({ kind: Type.Literal("click"), ...screenshotBinding, ...imagePoint, button: pointerButton }, strict),
  Type.Object({ kind: Type.Literal("double-click"), ...screenshotBinding, ...imagePoint, button: pointerButton }, strict),
  Type.Object({ kind: Type.Literal("drag"), ...screenshotBinding, from: Type.Object(imagePoint, strict), to: Type.Object(imagePoint, strict) }, strict),
  Type.Object({ kind: Type.Literal("wheel"), ...screenshotBinding, ...imagePoint, deltaX: Type.Number({ minimum: -100_000, maximum: 100_000 }), deltaY: Type.Number({ minimum: -100_000, maximum: 100_000 }) }, strict),
  Type.Object({ kind: Type.Literal("dom-click"), ...domBinding, button: pointerButton }, strict),
  Type.Object({ kind: Type.Literal("dom-double-click"), ...domBinding, button: pointerButton }, strict),
  Type.Object({ kind: Type.Literal("dom-hover"), ...domBinding }, strict),
  Type.Object({ kind: StringEnum(["dom-type", "dom-fill"] as const), ...domBinding, text: Type.String({ maxLength: 65_536 }) }, strict),
  Type.Object({ kind: Type.Literal("dom-key-press"), ...domBinding, key: Type.String({ minLength: 1, maxLength: 64 }) }, strict),
  Type.Object({ kind: Type.Literal("text-input"), text: Type.String({ maxLength: 65_536 }), replace: Type.Optional(Type.Boolean()) }, strict),
  Type.Object({ kind: Type.Literal("key-press"), key: Type.String({ minLength: 1, maxLength: 64 }) }, strict),
  Type.Object({ kind: Type.Literal("navigate"), url: Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://" }) }, strict),
]);

export const BrowserActSchema = Type.Object({
  browserSessionId: id(),
  tabId: id(),
  action: Type.Unsafe({ ...action, description: "One screenshot-bound, explicit DOM fallback, text, key, or navigation action." }),
}, strict);

export const BrowserDebugSchema = Type.Object({
  browserSessionId: Type.String({ minLength: 1, maxLength: 256, description: "Owned session identifier." }),
  operation: StringEnum(["console", "network", "html", "pdf", "record-start", "record-stop"] as const, { description: "Bounded diagnostic operation. Secret-bearing cookie, storage, and arbitrary evaluation operations are not exposed." }),
  args: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), Type.Unknown(), { maxProperties: 64, description: "Operation-specific diagnostic arguments. Keep them minimal." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000_000, description: "Hard diagnostic output bound. Use the smallest value that can explain the failure." })),
}, strict);
