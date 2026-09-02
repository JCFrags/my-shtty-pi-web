import { createHash } from "node:crypto";
import { WebxClient } from "./client.js";
import { nodeNdjsonConnectionFactory } from "./node-unix.js";
import { UnixSocketTransport } from "./transport.js";
import { defaultExportRoot, saveReadMarkdown, validateRelativeMarkdownPath } from "./save-markdown.js";
import type { BoundedContent, BrowserAction, BrowserPathId, ContentRequest, DirectReadRequest, ReadBatchRequest, ReadRequest, ReadSaveOptions, RequestOptions } from "./types.js";

export const FACADE_OPERATION_INVENTORY = {
  "web.search": "search",
  "web.read": "read",
  "web.readBatch": "readBatch; 1 to 5 ordered sources with concurrency 3",
  "web.content": "content; stored normalized content only",
  "browser.open": "createBrowserSession",
  "browser.tabs": "list/closeBrowserTab/closeBrowserSession; discard and restore unavailable",
  "browser.observe": "observeBrowser plus getBrowserVisualFrame for visual binding",
  "browser.act": "actBrowser with semantic or bound visual actions",
  "browser.cancel": "cancelBrowserOperation",
  "browser.debug": "debugBrowser; secret-bearing operations refused",
  "browser.workspace": "manageBrowserWorkspace",
} as const;

export interface FacadeRequestOptions { readonly signal: AbortSignal; readonly idempotencyKey: string; readonly ownerId: string; readonly cwd: string }
export interface FacadeResult {
  readonly title?: string; readonly url?: string; readonly summary: string; readonly data?: unknown;
  readonly artifacts?: readonly { readonly id: string; readonly kind?: string }[];
  readonly artifactPayload?: { readonly artifactId: string; readonly mediaType: string; readonly dataBase64: string; readonly size: number; readonly complete: boolean; readonly mode: "image" | "raw"; readonly offset?: number; readonly nextOffset?: number | null; readonly eof?: boolean };
  readonly trust?: "untrusted-external" | "local";
}
export interface FacadeCapabilities { readonly apiVersion: string; readonly daemon: "ready" | "unavailable"; readonly groups: { readonly search: boolean; readonly read: boolean; readonly browser: boolean; readonly browserDebug: boolean }; readonly browserPathIds: readonly string[] }
/** SDK adapter for the singular Pi facade operation names. */
export class WebxFacadeClient {
  #ownerId?: string;
  #client?: WebxClient;
  #browserPathId?: BrowserPathId;

  constructor(private readonly socketPath: string, private readonly exportRoot = defaultExportRoot()) {}

  async start(options: { signal: AbortSignal; ownerId: string; cwd: string }): Promise<void> {
    if (options.signal.aborted) throw new DOMException("startup was cancelled", "AbortError");
    validateId(options.ownerId, "ownerId");
    this.#ownerId = options.ownerId;
    this.#client = new WebxClient(new UnixSocketTransport(this.socketPath, nodeNdjsonConnectionFactory));
    await this.#client.bind(options.ownerId, options.signal);
    await this.#client.negotiate(options.signal);
  }

  async capabilities(options: { signal: AbortSignal; ownerId: string }): Promise<FacadeCapabilities> {
    const client = this.client(options.ownerId);
    try {
      const catalog = await client.capabilities({ signal: options.signal });
      const paths = catalog.browserPaths.map((path) => path.pathId);
      const healthy = (id: "search" | "read" | "browser") => catalog.capabilities.some((capability) => capability.id === id && capability.enabled && capability.healthy);
      const selected = paths.length === 1 ? paths[0] : undefined;
      this.#browserPathId = selected === "agentcursor/chrome" || selected === "agent-browser/chrome" ? selected : undefined;
      const browser = healthy("browser") && this.#browserPathId !== undefined;
      return { apiVersion: catalog.apiVersion, daemon: "ready", groups: { search: healthy("search"), read: healthy("read"), browser, browserDebug: browser && this.#browserPathId === "agent-browser/chrome" }, browserPathIds: paths };
    } catch (error) {
      if (options.signal.aborted) throw error;
      this.#browserPathId = undefined;
      return { apiVersion: "3.0.0", daemon: "unavailable", groups: { search: false, read: false, browser: false, browserDebug: false }, browserPathIds: [] };
    }
  }

  async request(operation: string, input: unknown, options: FacadeRequestOptions): Promise<FacadeResult> {
    const client = this.client(options.ownerId);
    const value = object(input);
    const requestOptions: RequestOptions = { signal: options.signal, idempotencyKey: options.idempotencyKey };
    if (operation === "web.search") {
      rejectPresent(value, ["operation", "effort", "freshness", "limit", "crawlPages", "crawlDepth"], operation);
      return external("Search results", await client.search({ query: requiredString(value.query, "query"), output: optionalSearchOutput(value.output), domains: optionalStringArray(value.domains, "domains") }, requestOptions));
    }
    if (operation === "web.read") return this.read(client, value, requestOptions);
    if (operation === "web.readBatch") return external("Batch read results", await client.readBatch(readBatchRequest(value), requestOptions));
    if (operation === "web.content") return external("Stored content", await client.content(contentRequest(value), requestOptions));
    if (operation === "browser.open") { rejectPresent(value, ["newTab", "pathId", "visible", "label"], operation); return local("Browser session opened", await client.createBrowserSession({ pathId: await this.selectedBrowserPath(client, options.signal), url: optionalString(value.url) }, requestOptions)); }
    if (operation === "browser.tabs") return this.browserTabs(client, value, requestOptions);
    if (operation === "browser.observe") return this.observe(client, value, options, requestOptions);
    if (operation === "browser.act") return local("Browser action completed", await client.actBrowser(requiredString(value.browserSessionId, "browserSessionId"), requiredString(value.tabId, "tabId"), this.browserAction(value.action), requestOptions));
    if (operation === "browser.cancel") return local("Browser cancellation requested", await client.cancelBrowserOperation(requiredString(value.operationId, "operationId"), requestOptions));
    if (operation === "browser.debug") return local("Browser diagnostic completed", await client.debugBrowser(requiredString(value.browserSessionId, "browserSessionId"), { operation: debugOperation(value.operation), args: optionalObject(value.args), maxChars: optionalNumber(value.maxChars) }, requestOptions));
    if (operation === "browser.workspace") return this.workspace(client, value, requestOptions);
    throw unavailable(operation, "operation is not in the facade inventory");
  }

  async decideApproval(): Promise<FacadeResult> { throw unavailable("approval.decide", "this runtime never returns approval placeholders"); }
  async stop(options: { ownerId: string }): Promise<void> { if (this.#ownerId !== options.ownerId) throw new Error("WebX facade owner mismatch"); const client = this.#client; this.#browserPathId = undefined; this.#client = undefined; this.#ownerId = undefined; await client?.close(); }

  private client(ownerId: string): WebxClient { if (this.#client === undefined || this.#ownerId !== ownerId) throw new Error("WebX facade client is not started for this owner"); return this.#client; }

  private async selectedBrowserPath(client: WebxClient, signal: AbortSignal): Promise<BrowserPathId> {
    if (this.#browserPathId !== undefined) return this.#browserPathId;
    const catalog = await client.capabilities({ signal });
    const paths = catalog.browserPaths.map((path) => path.pathId);
    if (paths.length !== 1 || paths[0] !== "agentcursor/chrome" && paths[0] !== "agent-browser/chrome") throw unavailable("browser.open", "webxd did not report exactly one selected browser path");
    this.#browserPathId = paths[0];
    return paths[0];
  }

  private async read(client: WebxClient, value: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    rejectPresent(value, ["browserSessionId", "tabId"], "web.read");
    const requestedUrl = requiredString(value.url, "url");
    const save = readSaveOptions(value.save);
    if (save !== undefined) rejectPresent(value, ["fields", "itemOffset", "itemLimit", "maxPages", "maxDepth", "sameDomain"], "web.read save");
    const request: ReadRequest = {
      url: requestedUrl,
      query: optionalString(value.query),
      view: optionalReadView(value.view),
      fields: optionalStringArray(value.fields, "fields"),
      itemOffset: optionalNumber(value.itemOffset),
      itemLimit: optionalNumber(value.itemLimit),
      maxChars: optionalNumber(value.maxChars),
      contentOffset: optionalNumber(value.contentOffset),
      maxPages: optionalNumber(value.maxPages),
      maxDepth: optionalNumber(value.maxDepth),
      sameDomain: optionalBoolean(value.sameDomain),
      refresh: strictOptionalBoolean(value.refresh, "refresh"),
    };
    const content = await client.read(request, options);
    if (save === undefined) return external("Read result", content);
    const completeContent = await this.completeStoredContentForSave(client, content, options);
    return local("Web content saved as Markdown", await saveReadMarkdown(completeContent, requestedUrl, save, this.exportRoot));
  }

  private async completeStoredContentForSave(client: WebxClient, content: BoundedContent, options: RequestOptions): Promise<BoundedContent> {
    const metadata = typeof content.metadata === "object" && content.metadata !== null ? content.metadata as Record<string, unknown> : {};
    const contentId = typeof metadata.contentId === "string" ? metadata.contentId : undefined;
    if (contentId === undefined) return content;
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const part = await client.content({ contentId, offset, limit: 30_000 }, { ...options, idempotencyKey: `${options.idempotencyKey}:save:${offset}` });
      chunks.push(part.untrustedContent);
      const next = part.metadata.nextOffset;
      if (next === null || next === undefined) break;
      offset = next;
    }
    const reader = typeof metadata.reader === "object" && metadata.reader !== null ? metadata.reader as Record<string, unknown> : {};
    const sourceComplete = reader.sourceComplete;
    const truncated = sourceComplete === true ? false : sourceComplete === false ? true : reader.complete !== true;
    return { ...content, untrustedContent: chunks.join(""), truncated, metadata };
  }

  private async browserTabs(client: WebxClient, input: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    const action = requiredString(input.action, "action");
    if (action === "list") return local("Owned browser sessions", await client.listBrowserSessions({ signal: options.signal }));
    if (action === "create-tab") return local("Browser tab created", await client.createBrowserTab(requiredString(input.browserSessionId, "browserSessionId"), optionalString(input.url), options));
    if (action === "focus-tab") return local("Browser tab focused", await client.focusBrowserTab(requiredString(input.browserSessionId, "browserSessionId"), requiredString(input.tabId, "tabId"), options));
    if (action === "close-session") { await client.closeBrowserSession(requiredString(input.browserSessionId, "browserSessionId"), options); return local("Browser session closed", { closed: true }); }
    if (action === "close-tab") { await client.closeBrowserTab(requiredString(input.browserSessionId, "browserSessionId"), requiredString(input.tabId, "tabId"), options); return local("Browser tab closed", { closed: true }); }
    throw unavailable("browser.tabs", `${action} has no safe Pi 0.84.1 equivalent in this product`);
  }

  private async observe(client: WebxClient, value: Record<string, unknown>, options: FacadeRequestOptions, requestOptions: RequestOptions): Promise<FacadeResult> {
    rejectPresent(value, ["selector", "includeBounds"], "browser.observe");
    const sessionId = requiredString(value.browserSessionId, "browserSessionId");
    const tabId = requiredString(value.tabId, "tabId");
    const view = observationView(value.mode ?? value.view);
    const observation = await client.observeBrowser(sessionId, tabId, view, optionalNumber(value.maxNodes) ?? optionalNumber(value.maxChars) ?? 200, requestOptions);
    if (view !== "screenshot") {
      if (observation.kind !== "dom") throw new Error("browser service returned the wrong observation kind");
      return external("Browser DOM observation", observation);
    }
    if (observation.kind !== "screenshot") throw new Error("browser service returned the wrong observation kind");
    const frame = await client.getBrowserVisualFrame(sessionId, tabId, observation.observationId, { signal: options.signal });
    if (frame.observationId !== observation.observationId || frame.browserSessionId !== sessionId || frame.tabId !== tabId || frame.mediaType !== observation.mediaType || frame.imagePixelWidth !== observation.imagePixelWidth || frame.imagePixelHeight !== observation.imagePixelHeight || frame.frameSequence !== observation.frameSequence || frame.viewportGeneration !== observation.viewportGeneration || frame.digest !== observation.digest) throw new Error("browser screenshot identity verification failed");
    const bytes = canonicalImageBase64(frame.payloadBase64);
    if (bytes.byteLength > 4 * 1024 * 1024 || sha256(bytes) !== frame.digest) throw new Error("browser screenshot integrity verification failed");
    const { artifactId, ...metadata } = observation;
    return { summary: "Browser screenshot observation", data: metadata, trust: "untrusted-external", artifactPayload: { artifactId, mediaType: frame.mediaType, dataBase64: frame.payloadBase64, size: bytes.byteLength, complete: true, mode: "image" } };
  }

  private browserAction(value: unknown): BrowserAction {
    const action = object(value);
    const kind = requiredString(action.kind, "action.kind");
    if (kind === "move" || kind === "click" || kind === "double-click" || kind === "wheel" || kind === "drag") {
      const binding = { observationId: requiredString(action.observationId, "action.observationId"), coordinateSpace: coordinateSpace(action.coordinateSpace) };
      if (kind === "move") return { kind, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), ...binding };
      if (kind === "wheel") return { kind, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), deltaX: requiredNumber(action.deltaX, "action.deltaX"), deltaY: requiredNumber(action.deltaY, "action.deltaY"), ...binding };
      if (kind === "drag") { const from = object(action.from); const to = object(action.to); return { kind, from: { x: requiredNumber(from.x, "action.from.x"), y: requiredNumber(from.y, "action.from.y") }, to: { x: requiredNumber(to.x, "action.to.x"), y: requiredNumber(to.y, "action.to.y") }, ...binding }; }
      return { kind, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), button: pointerButton(action.button), ...binding };
    }
    if (kind === "navigate") return { kind, url: requiredString(action.url, "action.url") };
    if (kind === "key-press") return { kind, key: boundedString(action.key, "action.key", 1, 64) };
    if (kind === "text-input") {
      const text = boundedString(action.text, "action.text", 0, 65_536);
      const replace = strictOptionalBoolean(action.replace, "action.replace");
      return replace === undefined ? { kind, text } : { kind, text, replace };
    }
    if (kind === "dom-click" || kind === "dom-double-click" || kind === "dom-hover") return { kind, domObservationId: requiredString(action.domObservationId, "action.domObservationId"), handle: requiredString(action.handle, "action.handle"), button: pointerButton(action.button) };
    if (kind === "dom-type" || kind === "dom-fill") return { kind, domObservationId: requiredString(action.domObservationId, "action.domObservationId"), handle: requiredString(action.handle, "action.handle"), text: requiredString(action.text, "action.text") };
    if (kind === "dom-key-press") return { kind, domObservationId: requiredString(action.domObservationId, "action.domObservationId"), handle: requiredString(action.handle, "action.handle"), key: requiredString(action.key, "action.key") };
    throw unavailable("browser.act", `${kind} is not supported by the frozen daemon action shape`);
  }

  private async workspace(client: WebxClient, input: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    const action = workspaceAction(input.action);
    const values = Array.isArray(input.values) ? input.values : [];
    const sessionId = optionalString(input.browserSessionId) ?? optionalString(values[0]);
    const tabId = optionalString(input.tabId) ?? optionalString(values[1]);
    return local(`Browser workspace ${action}`, await client.manageBrowserWorkspace({ action, sessionId, tabId }, options));
  }
}

function external(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "untrusted-external" }; }
function local(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "local" }; }
function unavailable(operation: string, reason: string): Error { const error = new Error(`${operation} is unavailable: ${reason}`); error.name = "WebxUnavailableError"; return error; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("operation input must be an object"); return value as Record<string, unknown>; }
function optionalObject(value: unknown): Readonly<Record<string, unknown>> | undefined { return value === undefined ? undefined : object(value); }
function readBatchRequest(value: Record<string, unknown>): ReadBatchRequest {
  for (const key of Object.keys(value)) if (key !== "items") throw new TypeError(`${key} is not supported by web.readBatch`);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 5) throw new TypeError("items must contain 1 to 5 direct read requests");
  return { items: value.items.map((item, index) => directReadRequest(object(item), `items[${index}]`)) };
}
function directReadRequest(value: Record<string, unknown>, name: string): DirectReadRequest {
  const allowed = new Set(["url", "query", "view", "fields", "itemOffset", "itemLimit", "maxChars", "contentOffset", "refresh"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not supported by web.readBatch`);
  const url = requiredString(value.url, `${name}.url`);
  if (!/^https?:\/\//u.test(url) || url.length > 8_192) throw new TypeError(`${name}.url must be a public HTTP(S) URL`);
  const query = optionalString(value.query);
  if (query !== undefined && query.length > 8_192) throw new TypeError(`${name}.query must contain at most 8192 characters`);
  const fields = optionalStringArray(value.fields, `${name}.fields`);
  if (fields !== undefined && (fields.length > 32 || fields.some((field) => field.length < 1 || field.length > 256))) throw new TypeError(`${name}.fields must contain at most 32 property names`);
  return {
    url, query, view: optionalReadView(value.view), fields,
    itemOffset: boundedOptionalInteger(value.itemOffset, `${name}.itemOffset`, 0, 1_000_000),
    itemLimit: boundedOptionalInteger(value.itemLimit, `${name}.itemLimit`, 1, 500),
    maxChars: boundedOptionalInteger(value.maxChars, `${name}.maxChars`, 1, 1_000_000),
    contentOffset: boundedOptionalInteger(value.contentOffset, `${name}.contentOffset`, 0, 100_000_000),
    refresh: strictOptionalBoolean(value.refresh, `${name}.refresh`),
  };
}
function contentRequest(value: Record<string, unknown>): ContentRequest {
  for (const key of Object.keys(value)) if (!["contentId", "offset", "limit", "findText", "query"].includes(key)) throw new TypeError(`${key} is not supported by web.content`);
  const offset = boundedOptionalInteger(value.offset, "offset", 0, 100_000_000);
  const limit = boundedOptionalInteger(value.limit, "limit", 1, 30_000);
  const findText = optionalString(value.findText);
  const query = optionalString(value.query);
  if (findText !== undefined && query !== undefined || offset !== undefined && (findText !== undefined || query !== undefined)) throw new TypeError("offset mode and focused mode are mutually exclusive");
  if (findText !== undefined && (findText.length < 1 || findText.length > 8_192)) throw new TypeError("findText must contain 1 to 8192 characters");
  if (query !== undefined && (query.trim().length < 1 || query.length > 8_192)) throw new TypeError("query must contain 1 to 8192 characters");
  return { contentId: requiredString(value.contentId, "contentId"), offset, limit, findText, query };
}
function boundedOptionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function readSaveOptions(value: unknown): ReadSaveOptions | undefined {
  if (value === undefined) return undefined;
  const save = object(value);
  for (const key of Object.keys(save)) if (key !== "path" && key !== "overwrite") throw new TypeError(`save.${key} is not supported`);
  const path = validateRelativeMarkdownPath(requiredString(save.path, "save.path"));
  const overwrite = optionalBoolean(save.overwrite);
  if (save.overwrite !== undefined && overwrite === undefined) throw new TypeError("save.overwrite must be a boolean");
  return { path, overwrite };
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`); return value; }
function boundedString(value: unknown, name: string, minimum: number, maximum: number): string { if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new TypeError(`${name} must contain ${minimum} to ${maximum} characters`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function requiredNumber(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} is required`); return value; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function strictOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new TypeError(`${name} must be a boolean`);
}
function optionalStringArray(value: unknown, name: string): readonly string[] | undefined { return value === undefined ? undefined : stringArray(value, name); }
function optionalSearchOutput(value: unknown): "links" | "extracts" | undefined { if (value === undefined) return undefined; if (value === "links" || value === "extracts") return value; throw new TypeError("output must be links or extracts"); }
function optionalReadView(value: unknown): "main" | "outline" | "raw" | undefined { if (value === undefined) return undefined; if (value === "main" || value === "outline" || value === "raw") return value; throw new TypeError("view is invalid"); }
function validateId(value: string, name: string): void { if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new TypeError(`${name} is invalid`); }
function observationView(value: unknown): "screenshot" | "dom" { if (value === undefined || value === "screenshot" || value === "visual") return "screenshot"; if (value === "dom") return "dom"; throw unavailable("browser.observe", `${String(value)} mode has no selected browser route`); }
function debugOperation(value: unknown): "console" | "network" | "html" | "pdf" | "record-start" | "record-stop" { if (value === "console" || value === "network" || value === "html" || value === "pdf" || value === "record-start" || value === "record-stop") return value; throw unavailable("browser.debug", "secret-bearing or unknown debug operation is refused"); }
function workspaceAction(value: unknown): "show" | "hide" | "list" | "attach" | "takeover" | "return" { if (value === "show" || value === "hide" || value === "list" || value === "attach" || value === "takeover" || value === "return") return value; throw unavailable("browser.workspace", `${String(value)} is unsupported`); }
function rejectPresent(value: Record<string, unknown>, names: readonly string[], operation: string): void { for (const name of names) if (value[name] !== undefined) throw unavailable(operation, `${name} is not supported by the daemon route`); }
function pointerButton(value: unknown): "left" | "middle" | "right" { if (value === undefined || value === "left") return "left"; if (value === "middle" || value === "right") return value; throw new TypeError("action.button is invalid"); }
function coordinateSpace(value: unknown): "imagePixels" | "cssViewport" { if (value === undefined || value === "imagePixels") return "imagePixels"; if (value === "cssViewport") return value; throw new TypeError("action.coordinateSpace is invalid"); }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} is invalid`); return value as string[]; }
function canonicalImageBase64(value: string): Uint8Array { if (value.length % 4 !== 0) throw new Error("browser screenshot is not canonical base64"); const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw new Error("browser screenshot is not canonical base64"); return bytes; }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
